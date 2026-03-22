import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Key } from "@mariozechner/pi-tui";
import {
  DEFAULT_PROMPT_MASTER_TARGET,
  dispatchPromptMaster,
  extractPromptMasterPromptFromMessage,
} from "../prompt-master-injection/index.js";
import { DockedPlanModeEditor } from "./docked-editor.js";
import { showApprovalReview } from "./approval-review.js";
import { getDockedSidebarLayout, renderPlanSidebarFallback, type PlanSidebarViewModel } from "./sidebar.js";
import {
  buildExecutionHandoff,
  createPlanTemplate,
  deriveExecutionWarnings,
  deriveSubagentPolicy,
  detectPlanDrift,
  executionInstructions,
  extractPlanArtifact,
  extractReferencedStepsFromText,
  fileExists,
  findCurrentStep,
  formatApprovalSummary,
  formatFrontierLabel,
  formatPlanStatus,
  getBlockedSteps,
  getExecutionFrontier,
  getReadySteps,
  isSafeReadOnlyCommand,
  markCompletedSteps,
  normalizeAgentPreference,
  planInstructions,
  planPathForSession,
  stripPlanOnlyTools,
  toProjectRelative,
  uniqueNames,
  updateStepStatus,
  type PlanArtifact,
  type PlanExecutionState,
  type PlanMode,
  type PlanState,
  type PlanStep,
  type PlanSubagentActivity,
  type PlanValidation,
  type ProgressSource,
  type SubagentStatus,
} from "./utils.js";

const STATE_ENTRY = "opencode-plan-state";
const EXECUTE_ENTRY = "opencode-plan-execute";
const WIDGET_KEY = "opencode-plan-workflow";
const QUESTION_TOOL_NAME = "question";
const PLAN_ENTER_TOOL_NAME = "plan_enter";
const PLAN_EXIT_TOOL_NAME = "plan_exit";
const PLAN_PROGRESS_TOOL_NAME = "plan_progress";
const SUBAGENT_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;
const READ_ONLY_SUBAGENTS = new Set(["Explore", "Plan", "explore", "plan"]);
const PLAN_MODE_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "edit", "write", QUESTION_TOOL_NAME, PLAN_EXIT_TOOL_NAME];
const EXECUTION_PROGRESS_STATUSES = new Set(["pending", "blocked", "in_progress", "completed"]);

type ApprovalAction = "approved" | "kept_planning" | "cancelled";

interface SessionMessageEntry {
  type: "message";
  message: AgentMessage;
}

interface PlanBootstrapResult {
  prompt: string;
  usedFallback: boolean;
}

function createInitialState(): PlanState {
  return {
    mode: "normal",
    panelVisible: true,
    planPath: undefined,
    previousActiveTools: undefined,
    artifact: undefined,
    approval: undefined,
    execution: undefined,
    subagents: [],
  };
}

function emptyValidation(): PlanValidation {
  return { errors: [], warnings: [] };
}

function isMessageEntry(entry: unknown): entry is SessionMessageEntry {
  return typeof entry === "object" && entry !== null && (entry as { type?: string }).type === "message" && "message" in entry;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getUserText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractTextFromUnknown(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => extractTextFromUnknown(item)).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) return extractTextFromUnknown(record.content);
    if (typeof record.message === "string") return record.message;
    if (record.details) return extractTextFromUnknown(record.details);
  }
  return "";
}

function getPromptMasterBootstrapPrompt(branch: unknown[], startIndex: number): string | undefined {
  for (let i = branch.length - 1; i >= startIndex; i -= 1) {
    const entry = branch[i];
    if (!isMessageEntry(entry) || !isAssistantMessage(entry.message)) continue;
    const extracted = extractPromptMasterPromptFromMessage(entry.message);
    if (extracted) return extracted;
  }
  return undefined;
}

function isPlanAuthoringMode(mode: PlanMode): boolean {
  return mode === "planning" || mode === "approval_pending" || mode === "approved_waiting_execution";
}

function cloneSubagent(activity: PlanSubagentActivity): PlanSubagentActivity {
  return { ...activity };
}

export default function opencodePlanMode(pi: ExtensionAPI): void {
  let state = createInitialState();
  let planBootstrapInProgress = false;
  let planEditor: DockedPlanModeEditor | undefined;
  let latestCtx: ExtensionContext | undefined;
  let editorInstalled = false;
  let stateFlushScheduled = false;
  let persistQueued = false;
  let planSyncInFlight: Promise<void> | undefined;
  let planSyncQueued = false;
  let sessionVersion = 0;

  function getSteps(): PlanStep[] {
    return state.artifact?.steps ?? [];
  }

  function getKnownToolNames(): Set<string> {
    return new Set(pi.getAllTools().map((tool) => tool.name));
  }

  function hasSubagentTool(): boolean {
    return getKnownToolNames().has(SUBAGENT_TOOL_NAMES[0]);
  }

  function getPlanningTools(): string[] {
    const names = [...PLAN_MODE_TOOL_NAMES];
    const known = getKnownToolNames();
    for (const toolName of SUBAGENT_TOOL_NAMES) {
      if (known.has(toolName)) names.push(toolName);
    }
    return uniqueNames(names);
  }

  function getExecutionTools(): string[] {
    const base = state.previousActiveTools && state.previousActiveTools.length > 0
      ? stripPlanOnlyTools(state.previousActiveTools)
      : stripPlanOnlyTools(pi.getAllTools().map((tool) => tool.name));
    return uniqueNames([...base, PLAN_PROGRESS_TOOL_NAME]);
  }

  function persistStateNow(): void {
    pi.appendEntry(STATE_ENTRY, {
      mode: state.mode,
      planPath: state.planPath,
      previousActiveTools: state.previousActiveTools,
      panelVisible: state.panelVisible,
      artifact: state.artifact,
      approval: state.approval,
      execution: state.execution,
      subagents: state.subagents.map(cloneSubagent),
    });
  }

  function scheduleStateFlush(ctx: ExtensionContext, options: { persist?: boolean } = {}): void {
    latestCtx = ctx;
    if (options.persist) persistQueued = true;
    if (stateFlushScheduled) return;

    stateFlushScheduled = true;
    queueMicrotask(() => {
      stateFlushScheduled = false;
      if (!latestCtx) return;
      updateUi(latestCtx);
      if (persistQueued) {
        persistQueued = false;
        persistStateNow();
      }
    });
  }

  function ensureExecutionState(): PlanExecutionState {
    if (!state.execution) {
      state.execution = {
        completedSteps: [],
        activeStep: undefined,
        readySteps: [],
        frontierStepNumbers: [],
        frontierBatch: undefined,
        blockedSteps: [],
        warnings: [],
      };
    }
    return state.execution;
  }

  function updateExecutionState(): void {
    if (!state.artifact) {
      state.execution = state.execution ?? {
        completedSteps: [],
        readySteps: [],
        frontierStepNumbers: [],
        frontierBatch: undefined,
        blockedSteps: [],
        warnings: [],
      };
      return;
    }

    state.artifact.handoff = buildExecutionHandoff(state.artifact);
    const execution = ensureExecutionState();
    const frontier = getExecutionFrontier(state.artifact.steps);
    const readySteps = getReadySteps(state.artifact.steps);
    const drift = detectPlanDrift(state.artifact, state.approval?.approvedSignature);

    execution.completedSteps = state.artifact.steps.filter((step) => step.completed).map((step) => step.step);
    execution.readySteps = readySteps.map((step) => step.step);
    execution.frontierStepNumbers = frontier.map((step) => step.step);
    execution.frontierBatch = frontier[0]?.batch;
    execution.activeStep = frontier[0]?.step ?? findCurrentStep(state.artifact.steps)?.step;
    execution.blockedSteps = getBlockedSteps(state.artifact.steps);
    execution.warnings = deriveExecutionWarnings(state.artifact, state.approval?.approvedSignature, execution.warnings);
    execution.planChangedSinceApproval = drift.changed;
    execution.requiresReapproval = drift.requiresReapproval;

    if (state.artifact.validation.errors.length > 0 && state.mode !== "planning") {
      execution.warnings = uniqueNames([
        ...execution.warnings,
        ...state.artifact.validation.errors.map((error) => `Plan validation error: ${error}`),
      ]);
    }

    if (execution.frontierStepNumbers.length === 0 && state.artifact.steps.some((step) => !step.completed)) {
      execution.warnings = uniqueNames([...execution.warnings, "No ready frontier is currently runnable. Remaining work may be blocked."]);
    }
  }

  function refreshApprovalState(ctx: ExtensionContext): void {
    if (!state.approval) return;
    const latestSummary = state.planPath ? formatApprovalSummary(state.planPath, ctx.cwd, state.artifact) : state.approval.summary;
    const latestHandoff = state.artifact ? buildExecutionHandoff(state.artifact) : state.approval.handoff;
    state.approval = {
      pendingSince: state.approval.pendingSince,
      approvedAt: state.approval.approvedAt,
      approvedSignature: state.approval.approvedSignature,
      summary: state.approval.approvedAt ? state.approval.summary ?? latestSummary : latestSummary,
      validation: state.artifact?.validation ?? emptyValidation(),
      handoff: state.approval.approvedAt ? state.approval.handoff ?? latestHandoff : latestHandoff,
    };
  }

  async function ensurePlanFile(ctx: ExtensionContext, goal?: string): Promise<string> {
    if (!state.planPath) {
      state.planPath = planPathForSession(ctx.sessionManager.getSessionFile(), ctx.cwd);
    }

    await mkdir(dirname(state.planPath), { recursive: true });
    if (!(await fileExists(state.planPath))) {
      await writeFile(state.planPath, createPlanTemplate(goal), "utf8");
    }

    return state.planPath;
  }

  async function syncPlanFromDisk(ctx: ExtensionContext): Promise<void> {
    latestCtx = ctx;
    if (planSyncInFlight) {
      planSyncQueued = true;
      await planSyncInFlight;
      return;
    }

    const currentSessionVersion = sessionVersion;
    const runSync = async (): Promise<void> => {
      if (!state.planPath || !(await fileExists(state.planPath))) {
        if (currentSessionVersion !== sessionVersion) return;
        state.artifact = undefined;
        refreshApprovalState(ctx);
        updateExecutionState();
        return;
      }

      const previousSteps = getSteps();
      const markdown = await readFile(state.planPath, "utf8");
      if (currentSessionVersion !== sessionVersion) return;
      state.artifact = extractPlanArtifact(markdown, previousSteps);
      refreshApprovalState(ctx);
      updateExecutionState();
    };

    do {
      planSyncQueued = false;
      planSyncInFlight = runSync();
      await planSyncInFlight;
      planSyncInFlight = undefined;
    } while (planSyncQueued);
  }

  function buildNextAction(): string {
    const steps = getSteps();
    const frontier = state.execution?.frontierStepNumbers ?? [];

    switch (state.mode) {
      case "planning":
        if (steps.length === 0) return "Write numbered steps in the plan file.";
        if (state.artifact?.validation.errors.length) return "Fix plan validation errors before approval.";
        return "Call plan_exit or run /plan to review and approve this plan.";
      case "approval_pending":
        return "Choose approve, revise in editor, or keep planning.";
      case "approved_waiting_execution":
        return "Run /plan to start approved execution in a fresh session.";
      case "executing":
        if (frontier.length === 1) return `Work on step ${frontier[0]} and emit [DONE:${frontier[0]}] when it completes.`;
        if (frontier.length > 1) return `Fan out the ready frontier (${frontier.join(", ")}), normalize delegated results, then continue.`;
        if (steps.some((step) => !step.completed)) return "Resolve blockers, re-review drift, or update a step with plan_progress.";
        return "All steps are complete. Wrap up and verify the result.";
      default:
        return "Use /plan to enter planning mode.";
    }
  }

  function buildSidebarViewModel(ctx: ExtensionContext): PlanSidebarViewModel | undefined {
    if (state.mode === "normal") return undefined;

    return {
      mode: state.mode,
      planPath: state.planPath ? toProjectRelative(state.planPath, ctx.cwd) : undefined,
      goal: state.artifact?.goal,
      steps: getSteps(),
      approval: state.approval,
      execution: state.execution,
      blockers: state.artifact?.blockers ?? [],
      openQuestions: state.artifact?.openQuestions ?? [],
      nextAction: buildNextAction(),
      subagents: state.subagents,
      toggleHint: state.panelVisible === false
        ? "/plan sidebar • Ctrl+Alt+B show rail"
        : "/plan sidebar • Ctrl+Alt+B hide rail",
    };
  }

  function getSidebarViewModel(ctx: ExtensionContext): PlanSidebarViewModel | undefined {
    if (state.panelVisible === false) return undefined;
    return buildSidebarViewModel(ctx);
  }

  function getCompactSidebarWidth(): number {
    return Math.max(48, Math.min(88, planEditor?.getLastRenderWidth() ?? 72));
  }

  function clearWorkflowWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
  }

  function syncSidebar(ctx: ExtensionContext): void {
    planEditor?.setSidebarState(getSidebarViewModel(ctx));
  }

  function syncWorkflowWidget(ctx: ExtensionContext, model: PlanSidebarViewModel | undefined): void {
    if (!ctx.hasUI) return;

    if (!model) {
      clearWorkflowWidget(ctx);
      return;
    }

    const lastRenderWidth = planEditor?.getLastRenderWidth();
    const railVisible = state.panelVisible !== false
      && typeof lastRenderWidth === "number"
      && Boolean(getDockedSidebarLayout(lastRenderWidth, model));

    if (railVisible) {
      clearWorkflowWidget(ctx);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, renderPlanSidebarFallback(model, ctx.ui.theme, getCompactSidebarWidth()), { placement: "belowEditor" });
  }

  function updateUi(ctx: ExtensionContext): void {
    const steps = getSteps();
    const completed = steps.filter((step) => step.completed).length;
    const warningCount = state.execution?.warnings.length ?? 0;
    const workflowModel = buildSidebarViewModel(ctx);

    if (state.mode === "executing" && steps.length > 0) {
      const warningSuffix = warningCount > 0 ? ctx.ui.theme.fg("warning", ` !${warningCount}`) : "";
      const frontierSuffix = state.execution?.frontierStepNumbers.length
        ? ctx.ui.theme.fg("muted", ` · ${formatFrontierLabel(getExecutionFrontier(steps))}`)
        : "";
      ctx.ui.setStatus("opencode-plan", ctx.ui.theme.fg("accent", `PLAN ${completed}/${steps.length}`) + frontierSuffix + warningSuffix);
    } else if (state.mode === "approved_waiting_execution") {
      ctx.ui.setStatus("opencode-plan", ctx.ui.theme.fg("success", "PLAN READY"));
    } else if (state.mode === "approval_pending") {
      ctx.ui.setStatus("opencode-plan", ctx.ui.theme.fg("warning", "PLAN REVIEW"));
    } else if (state.mode === "planning") {
      ctx.ui.setStatus("opencode-plan", ctx.ui.theme.fg("warning", "PLAN"));
    } else {
      ctx.ui.setStatus("opencode-plan", undefined);
    }

    syncWorkflowWidget(ctx, workflowModel);
    syncSidebar(ctx);
  }

  function installEditorHotkey(ctx: ExtensionContext): void {
    if (!ctx.hasUI || editorInstalled) {
      if (ctx.hasUI) syncSidebar(ctx);
      return;
    }

    editorInstalled = true;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      planEditor = new DockedPlanModeEditor(tui, theme, keybindings, ctx.ui.theme, () => {
        if (state.mode === "approved_waiting_execution") {
          ctx.ui.setEditorText("/plan");
          ctx.ui.notify("Approved execution is ready. Press Enter on /plan to continue in a fresh session.", "info");
          return;
        }

        if (state.mode === "normal") {
          void enterPlanningMode(ctx).then(() => {
            ctx.ui.notify("Plan mode enabled.", "info");
          });
          return;
        }

        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
      }, () => {
        scheduleStateFlush(ctx);
      });
      planEditor.setSidebarState(getSidebarViewModel(ctx));
      return planEditor;
    });
  }

  function applyMode(ctx: ExtensionContext): void {
    latestCtx = ctx;
    if (isPlanAuthoringMode(state.mode)) {
      pi.setActiveTools(getPlanningTools());
    } else if (state.mode === "executing") {
      pi.setActiveTools(getExecutionTools());
    } else if (state.previousActiveTools && state.previousActiveTools.length > 0) {
      pi.setActiveTools(stripPlanOnlyTools(state.previousActiveTools));
    }

    installEditorHotkey(ctx);
    scheduleStateFlush(ctx);
  }

  function setSidebarVisibility(ctx: ExtensionContext, visible: boolean): void {
    state.panelVisible = visible;
    scheduleStateFlush(ctx, { persist: true });
  }

  function toggleSidebar(ctx: ExtensionContext): void {
    setSidebarVisibility(ctx, !state.panelVisible);
  }

  async function enterPlanningMode(ctx: ExtensionContext, goal?: string): Promise<void> {
    if (state.mode === "normal") {
      state.previousActiveTools = pi.getActiveTools();
      state.subagents = [];
    }
    state.mode = "planning";
    state.panelVisible = state.panelVisible ?? true;
    await ensurePlanFile(ctx, goal);
    await syncPlanFromDisk(ctx);
    applyMode(ctx);
    scheduleStateFlush(ctx, { persist: true });
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    state.mode = "normal";
    applyMode(ctx);
    scheduleStateFlush(ctx, { persist: true });
  }

  async function startExecutionMode(ctx: ExtensionContext): Promise<void> {
    await ensurePlanFile(ctx);
    await syncPlanFromDisk(ctx);
    state.mode = "executing";
    state.subagents = [];
    const execution = ensureExecutionState();
    execution.lastProgressAt = execution.lastProgressAt ?? new Date().toISOString();
    execution.warnings = deriveExecutionWarnings(state.artifact, state.approval?.approvedSignature, execution.warnings);
    applyMode(ctx);
    pi.appendEntry(EXECUTE_ENTRY, {
      mode: state.mode,
      planPath: state.planPath,
      artifact: state.artifact,
      approval: state.approval,
      execution: state.execution,
    });
    scheduleStateFlush(ctx, { persist: true });
  }

  function queueUserMessage(ctx: ExtensionContext, text: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  async function startApprovedExecutionInFreshSession(ctx: ExtensionCommandContext): Promise<void> {
    if (state.mode !== "approved_waiting_execution" || !state.planPath) {
      ctx.ui.notify("No approved plan is waiting to execute.", "warning");
      return;
    }

    await syncPlanFromDisk(ctx);
    const drift = detectPlanDrift(state.artifact, state.approval?.approvedSignature);
    if (drift.requiresReapproval) {
      const choice = await ctx.ui.select(
        `${drift.reasons.join(" ")}\n\nChoose how to continue:`,
        ["Re-review plan", "Override and start execution", "Cancel"],
      );
      if (!choice || choice === "Cancel") {
        ctx.ui.notify("Starting execution was cancelled.", "info");
        return;
      }
      if (choice === "Re-review plan") {
        await reviewPlanForApproval(ctx, { directStart: true, commandCtx: ctx });
        return;
      }
    }

    const handoff = {
      planPath: state.planPath,
      previousActiveTools: state.previousActiveTools ? [...state.previousActiveTools] : undefined,
      panelVisible: state.panelVisible,
      approval: state.approval
        ? {
          ...state.approval,
          handoff: state.approval.handoff ?? (state.artifact ? buildExecutionHandoff(state.artifact) : undefined),
        }
        : undefined,
    };

    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({ parentSession });
    if (result.cancelled) {
      ctx.ui.notify("Starting execution was cancelled.", "info");
      return;
    }

    latestCtx = ctx;
    state = createInitialState();
    state.planPath = handoff.planPath;
    state.previousActiveTools = handoff.previousActiveTools;
    state.panelVisible = handoff.panelVisible;
    state.approval = handoff.approval;

    await startExecutionMode(ctx);
    ctx.ui.notify("Started execution in a fresh session.", "info");

    const approvedHandoff = handoff.approval?.handoff;
    const frontierNote = approvedHandoff?.readySteps.length
      ? ` Ready frontier: ${approvedHandoff.readySteps.join(", ")}${approvedHandoff.frontierBatch ? ` (batch ${approvedHandoff.frontierBatch})` : ""}.`
      : "";
    const verificationNote = approvedHandoff?.verification.length
      ? ` Verification focus: ${approvedHandoff.verification.join(" | ")}.`
      : "";
    const delegationNote = approvedHandoff?.delegationGuidance.length
      ? ` Delegation guidance: ${approvedHandoff.delegationGuidance.join(" | ")}.`
      : "";

    queueUserMessage(
      ctx,
      `Execute the approved plan in ${toProjectRelative(handoff.planPath, ctx.cwd)}. Start with the first unfinished numbered step and include [DONE:n] markers as each step completes.${frontierNote}${verificationNote}${delegationNote}`,
    );
  }

  function prepareApprovedExecutionCommand(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorText("/plan");
    ctx.ui.notify("Plan approved. Press Enter on /plan to continue in a fresh execution session. This state is resumable.", "info");
  }

  function getLatestUserPlanningRequest(ctx: ExtensionContext, fallback?: string): string | undefined {
    if (fallback?.trim()) return fallback.trim();
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i] as { type: string; message?: AgentMessage };
      if (entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;
      const text = getUserText(entry.message).trim();
      if (!text) continue;
      if (text.startsWith("/plan")) continue;
      return text;
    }
    return undefined;
  }

  async function bootstrapPlanRequestInFreshSession(ctx: ExtensionCommandContext, request: string): Promise<void> {
    if (planBootstrapInProgress) {
      ctx.ui.notify("Plan bootstrap is already in progress.", "info");
      return;
    }

    planBootstrapInProgress = true;
    try {
      const parentSession = ctx.sessionManager.getSessionFile();
      const branchStart = ctx.sessionManager.getBranch().length;

      ctx.ui.notify("Improving the planning request with prompt-master...", "info");
      dispatchPromptMaster(pi, ctx, request, DEFAULT_PROMPT_MASTER_TARGET);

      let bootstrapResult: PlanBootstrapResult = { prompt: request, usedFallback: true };
      try {
        await ctx.waitForIdle();
        const improvedPrompt = getPromptMasterBootstrapPrompt(ctx.sessionManager.getBranch(), branchStart);
        if (improvedPrompt) {
          bootstrapResult = { prompt: improvedPrompt, usedFallback: false };
        } else {
          ctx.ui.notify("Prompt-master did not return a paste-ready prompt. Falling back to the original planning request.", "warning");
        }
      } catch {
        ctx.ui.notify("Prompt-master bootstrap failed. Falling back to the original planning request.", "warning");
      }

      const result = await ctx.newSession({ parentSession });
      if (result.cancelled) {
        ctx.ui.notify("Starting a fresh planning session was cancelled.", "info");
        return;
      }

      latestCtx = ctx;
      state = createInitialState();
      await enterPlanningMode(ctx, request);
      ctx.ui.notify(
        bootstrapResult.usedFallback
          ? "Started a fresh planning session with the original request."
          : "Started a fresh planning session with the improved planning prompt.",
        "info",
      );
      queueUserMessage(ctx, bootstrapResult.prompt);
    } finally {
      planBootstrapInProgress = false;
    }
  }

  async function openPlanInEditor(ctx: ExtensionContext, planPath: string): Promise<boolean> {
    const currentPlan = await readFile(planPath, "utf8");
    const reviewedPlan = await ctx.ui.editor(`Edit ${toProjectRelative(planPath, ctx.cwd)}`, currentPlan);
    if (reviewedPlan === undefined) {
      return false;
    }

    if (reviewedPlan !== currentPlan) {
      await mkdir(dirname(planPath), { recursive: true });
      await writeFile(planPath, reviewedPlan, "utf8");
    }

    await syncPlanFromDisk(ctx);
    scheduleStateFlush(ctx, { persist: true });
    return true;
  }

  async function reviewPlanForApproval(
    ctx: ExtensionContext,
    options: { directStart?: boolean; commandCtx?: ExtensionCommandContext } = {},
  ): Promise<{ action: ApprovalAction; startedExecution: boolean; planPath: string }> {
    if (!ctx.hasUI) {
      throw new Error("Plan approval requires interactive UI.");
    }

    const planPath = await ensurePlanFile(ctx);
    await syncPlanFromDisk(ctx);

    state.mode = "approval_pending";
    state.approval = {
      pendingSince: state.approval?.pendingSince ?? new Date().toISOString(),
      approvedAt: undefined,
      approvedSignature: state.approval?.approvedSignature,
      summary: formatApprovalSummary(planPath, ctx.cwd, state.artifact),
      validation: state.artifact?.validation ?? emptyValidation(),
      handoff: state.artifact ? buildExecutionHandoff(state.artifact) : state.approval?.handoff,
    };
    applyMode(ctx);
    scheduleStateFlush(ctx, { persist: true });

    while (true) {
      await syncPlanFromDisk(ctx);
      const summary = formatApprovalSummary(planPath, ctx.cwd, state.artifact);
      const validation = state.artifact?.validation ?? emptyValidation();
      state.approval = {
        pendingSince: state.approval?.pendingSince ?? new Date().toISOString(),
        approvedAt: undefined,
        approvedSignature: state.approval?.approvedSignature,
        summary,
        validation,
        handoff: state.artifact ? buildExecutionHandoff(state.artifact) : state.approval?.handoff,
      };
      scheduleStateFlush(ctx, { persist: true });

      const optionsList = validation.errors.length > 0
        ? ["Revise in editor", "Keep planning"]
        : [options.directStart ? "Approve and start execution" : "Approve plan", "Revise in editor", "Keep planning"];
      const choice = await showApprovalReview(ctx, {
        title: "Review plan for approval",
        summary,
        options: optionsList,
      });

      if (!choice || choice === "Keep planning") {
        state.mode = "planning";
        applyMode(ctx);
        scheduleStateFlush(ctx, { persist: true });
        return { action: "kept_planning", startedExecution: false, planPath };
      }

      if (choice === "Revise in editor") {
        state.mode = "planning";
        applyMode(ctx);
        await openPlanInEditor(ctx, planPath);
        state.mode = "approval_pending";
        applyMode(ctx);
        scheduleStateFlush(ctx, { persist: true });
        continue;
      }

      state.mode = "approved_waiting_execution";
      state.approval = {
        pendingSince: state.approval?.pendingSince,
        approvedAt: new Date().toISOString(),
        approvedSignature: state.artifact?.signature,
        summary,
        validation,
        handoff: state.artifact ? buildExecutionHandoff(state.artifact) : state.approval?.handoff,
      };
      updateExecutionState();
      applyMode(ctx);
      scheduleStateFlush(ctx, { persist: true });

      if (options.directStart && options.commandCtx) {
        await startApprovedExecutionInFreshSession(options.commandCtx);
        return { action: "approved", startedExecution: true, planPath };
      }

      prepareApprovedExecutionCommand(ctx);
      return { action: "approved", startedExecution: false, planPath };
    }
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    state = createInitialState();
    const branch = ctx.sessionManager.getBranch();
    let restoredState: Partial<PlanState> | undefined;
    let executeIndex = -1;

    for (let i = 0; i < branch.length; i += 1) {
      const entry = branch[i] as {
        type: string;
        customType?: string;
        data?: Partial<PlanState> & { steps?: PlanStep[] };
      };
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
        restoredState = entry.data;
      }
      if (entry.type === "custom" && entry.customType === EXECUTE_ENTRY) {
        executeIndex = i;
      }
    }

    if (restoredState) {
      const legacyArtifact: PlanArtifact | undefined = restoredState.artifact ?? (restoredState.steps
        ? {
          goal: undefined,
          context: [],
          blockers: [],
          openQuestions: [],
          files: [],
          verification: [],
          steps: restoredState.steps,
          validation: emptyValidation(),
          signature: restoredState.steps.map((step) => `${step.step}:${step.text}`).join("\n"),
        }
        : undefined);

      state = {
        mode: restoredState.mode ?? "normal",
        planPath: restoredState.planPath,
        previousActiveTools: restoredState.previousActiveTools,
        panelVisible: restoredState.panelVisible ?? true,
        artifact: legacyArtifact,
        approval: restoredState.approval,
        execution: restoredState.execution,
        subagents: (restoredState.subagents ?? []).map(cloneSubagent),
      };
    }

    if (state.mode === "executing" && state.artifact?.steps.length && executeIndex >= 0) {
      const textSinceExecute = branch
        .slice(executeIndex + 1)
        .filter((entry): entry is { type: string; message: AgentMessage } => entry.type === "message" && "message" in entry)
        .map((entry) => entry.message)
        .filter(isAssistantMessage)
        .map(getAssistantText)
        .join("\n");
      const progress = markCompletedSteps(textSinceExecute, state.artifact.steps);
      state.execution = state.execution ?? {
        completedSteps: [],
        readySteps: [],
        frontierStepNumbers: [],
        frontierBatch: undefined,
        blockedSteps: [],
        warnings: [],
      };
      state.execution.warnings = uniqueNames([...(state.execution.warnings ?? []), ...progress.warnings]);
      if (progress.source) state.execution.lastProgressSource = progress.source;
      updateExecutionState();
    }
  }

  function noteProgress(source: ProgressSource | undefined, warnings: string[] = []): void {
    const execution = ensureExecutionState();
    execution.lastProgressAt = new Date().toISOString();
    if (source) execution.lastProgressSource = source;
    execution.warnings = uniqueNames([...(execution.warnings ?? []), ...warnings]);
    updateExecutionState();
  }

  function upsertSubagent(update: Partial<PlanSubagentActivity> & { id: string; description?: string; type?: string; status?: SubagentStatus }): void {
    const existing = state.subagents.find((item) => item.id === update.id);
    if (existing) {
      Object.assign(existing, update);
      return;
    }

    state.subagents.push({
      id: update.id,
      description: update.description ?? update.id,
      type: update.type ?? "general-purpose",
      status: update.status ?? "queued",
      isBackground: update.isBackground,
      startedAt: update.startedAt ?? Date.now(),
      completedAt: update.completedAt,
      toolUses: update.toolUses,
      durationMs: update.durationMs,
      error: update.error,
    });
  }

  function pruneFinishedSubagents(): void {
    if (state.subagents.length <= 8) return;
    const running = state.subagents.filter((item) => item.status === "queued" || item.status === "running" || item.status === "background");
    const finished = state.subagents
      .filter((item) => item.status !== "queued" && item.status !== "running" && item.status !== "background")
      .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))
      .slice(0, 6);
    state.subagents = [...running, ...finished].slice(0, 10);
  }

  pi.registerFlag("plan", {
    description: "Start in opencode-like planning mode",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: QUESTION_TOOL_NAME,
    label: "Question",
    description: "Ask the user a clarifying question while planning.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user." }),
      options: Type.Optional(Type.Array(Type.String({ description: "Selectable option." }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("question requires interactive UI.");
      }

      let answer: string | undefined;
      if (params.options && params.options.length > 0) {
        answer = await ctx.ui.select(params.question, params.options);
      } else {
        answer = await ctx.ui.input("Question", params.question);
      }

      return {
        content: [{ type: "text", text: answer ? `User answer: ${answer}` : "User dismissed the question." }],
        details: { answer },
      };
    },
  });

  pi.registerTool({
    name: PLAN_ENTER_TOOL_NAME,
    label: "Plan Enter",
    description: "Prepare /plan for a fresh planning turn using the latest request or an explicit goal.",
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "Optional planning request to bootstrap." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = getLatestUserPlanningRequest(ctx, params.goal);
      if (!request) {
        throw new Error("plan_enter could not find a planning request to bootstrap.");
      }

      const bootstrapCommand = `/plan ${request}`;
      if (ctx.hasUI) {
        ctx.ui.setEditorText(bootstrapCommand);
      }

      return {
        content: [
          {
            type: "text",
            text: ctx.hasUI
              ? "Prepared /plan <request> in the editor so the user can restart planning with prompt improvement in a fresh session."
              : `Ask the user to run ${bootstrapCommand} to restart planning with prompt improvement in a fresh session.`,
          },
        ],
        details: { bootstrapCommand },
      };
    },
  });

  pi.registerTool({
    name: PLAN_EXIT_TOOL_NAME,
    label: "Plan Exit",
    description: "Review the current plan file, then approve execution.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!isPlanAuthoringMode(state.mode)) {
        throw new Error("plan_exit can only be used while planning.");
      }
      if (!ctx.hasUI) {
        throw new Error("plan_exit requires interactive UI approval.");
      }

      const result = await reviewPlanForApproval(ctx, { directStart: false });
      if (result.action !== "approved") {
        return {
          content: [{ type: "text", text: "Kept planning. Continue refining the plan file." }],
          details: { mode: state.mode, planPath: result.planPath },
        };
      }

      return {
        content: [{ type: "text", text: `Plan approved. Fresh-session execution is ready for ${toProjectRelative(result.planPath, ctx.cwd)}. Press Enter on /plan to continue.`, }],
        details: {
          mode: state.mode,
          planPath: result.planPath,
          artifact: state.artifact,
        },
      };
    },
  });

  pi.registerTool({
    name: PLAN_PROGRESS_TOOL_NAME,
    label: "Plan Progress",
    description: "Update execution progress for an approved plan step when markers need help.",
    parameters: Type.Object({
      step: Type.Number({ description: "The numbered plan step to update." }),
      status: Type.String({ description: "One of: pending, blocked, in_progress, completed." }),
      note: Type.Optional(Type.String({ description: "Optional note, blocker, or short status detail." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (state.mode !== "executing" || !state.artifact) {
        throw new Error("plan_progress can only be used during execution.");
      }

      const normalizedStatus = String(params.status).trim();
      if (!EXECUTION_PROGRESS_STATUSES.has(normalizedStatus)) {
        throw new Error(`Invalid status: ${params.status}. Use pending, blocked, in_progress, or completed.`);
      }

      const result = updateStepStatus(state.artifact.steps, Number(params.step), normalizedStatus as PlanStep["status"], params.note);
      noteProgress("tool", result.warnings);
      scheduleStateFlush(ctx, { persist: true });

      if (!result.updated) {
        return {
          content: [{ type: "text", text: result.warnings[0] ?? `Could not update step ${params.step}.` }],
          details: { warnings: result.warnings },
        };
      }

      return {
        content: [{ type: "text", text: `Updated plan step ${params.step} to ${normalizedStatus}.` }],
        details: {
          step: params.step,
          status: normalizedStatus,
          note: params.note,
          warnings: result.warnings,
        },
      };
    },
  });

  pi.registerCommand("plan", {
    description: "Enter, inspect, approve, or execute opencode-like planning mode",
    handler: async (args, ctx) => {
      const command = args.trim();

      if (command === "status") {
        ctx.ui.notify(formatPlanStatus(state.planPath, ctx.cwd, state.mode, state.panelVisible, state.artifact), "info");
        return;
      }

      const sidebarMatch = command.match(/^(?:sidebar|panel)(?:\s+(on|off|show|hide|toggle))?$/i);
      if (sidebarMatch) {
        const value = (sidebarMatch[1] ?? "toggle").toLowerCase();
        if (value === "on" || value === "show") {
          setSidebarVisibility(ctx, true);
        } else if (value === "off" || value === "hide") {
          setSidebarVisibility(ctx, false);
        } else {
          toggleSidebar(ctx);
        }
        ctx.ui.notify(`Plan panel ${state.panelVisible ? "shown" : "hidden"}.`, "info");
        return;
      }

      if (command === "off") {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
        return;
      }

      if (command === "edit" || command === "revise") {
        const planPath = await ensurePlanFile(ctx);
        await openPlanInEditor(ctx, planPath);
        state.mode = "planning";
        applyMode(ctx);
        scheduleStateFlush(ctx, { persist: true });
        return;
      }

      if (command === "review" || command === "approve") {
        await reviewPlanForApproval(ctx, { directStart: true, commandCtx: ctx });
        return;
      }

      if (command === "execute" || command === "resume" || command === "start") {
        await startApprovedExecutionInFreshSession(ctx);
        return;
      }

      if (state.mode === "approved_waiting_execution" && command.length === 0) {
        await startApprovedExecutionInFreshSession(ctx);
        return;
      }

      if ((state.mode === "planning" || state.mode === "approval_pending") && command.length === 0) {
        await reviewPlanForApproval(ctx, { directStart: true, commandCtx: ctx });
        return;
      }

      if (state.mode === "planning" && command) {
        queueUserMessage(ctx, command);
        return;
      }

      if (state.mode === "normal" && command) {
        await bootstrapPlanRequestInFreshSession(ctx, command);
        return;
      }

      if (state.mode === "normal") {
        await enterPlanningMode(ctx);
        ctx.ui.notify("Plan mode enabled. Ask for a plan or use /plan <request>.", "info");
        return;
      }

      if (state.mode === "executing" && command.length === 0) {
        ctx.ui.notify("Execution is already in progress. Use /plan off to leave workflow mode.", "info");
        return;
      }

      exitPlanMode(ctx);
      ctx.ui.notify("Plan mode disabled.", "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle opencode-like planning mode",
    handler: async (ctx) => {
      if (state.mode === "normal") {
        await enterPlanningMode(ctx);
        ctx.ui.notify("Plan mode enabled.", "info");
      } else if (state.mode === "approved_waiting_execution") {
        ctx.ui.setEditorText("/plan");
        ctx.ui.notify("Approved execution is ready. Press Enter on /plan to continue.", "info");
      } else {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("b"), {
    description: "Toggle plan panel",
    handler: async (ctx) => {
      toggleSidebar(ctx);
      ctx.ui.notify(`Plan panel ${state.panelVisible ? "shown" : "hidden"}.`, "info");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (isPlanAuthoringMode(state.mode)) {
      const planPath = await ensurePlanFile(ctx);
      return {
        message: {
          customType: "opencode-plan-context",
          content: planInstructions(planPath, ctx.cwd, hasSubagentTool()),
          display: false,
        },
      };
    }

    if (state.mode === "executing" && state.planPath) {
      return {
        message: {
          customType: "opencode-plan-execution-context",
          content: executionInstructions(state.planPath, ctx.cwd, state.artifact),
          display: false,
        },
      };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isPlanAuthoringMode(state.mode)) {
      if (event.toolName === "bash") {
        const command = String((event.input as { command?: string }).command ?? "");
        if (!isSafeReadOnlyCommand(command)) {
          return {
            block: true,
            reason: `Plan mode only allows read-only bash commands. Blocked: ${command}`,
          };
        }
        return;
      }

      if ((event.toolName === "edit" || event.toolName === "write") && state.planPath) {
        const requestedPath = String((event.input as { path?: string }).path ?? "");
        const resolvedPath = resolve(ctx.cwd, requestedPath);
        if (resolve(state.planPath) !== resolvedPath) {
          return {
            block: true,
            reason: `Plan mode only allows edits to the active plan file: ${state.planPath}`,
          };
        }
        return;
      }

      if (event.toolName === SUBAGENT_TOOL_NAMES[0]) {
        const input = event.input as { subagent_type?: string };
        const subagentType = input.subagent_type ?? "";
        if (!READ_ONLY_SUBAGENTS.has(subagentType)) {
          return {
            block: true,
            reason: "Plan mode only allows read-only subagent types (Explore or Plan).",
          };
        }
      }
      return;
    }

    if (state.mode !== "executing" || event.toolName !== SUBAGENT_TOOL_NAMES[0] || !state.artifact) return;

    const input = event.input as {
      prompt?: string;
      description?: string;
      subagent_type?: string;
      run_in_background?: boolean;
      isolation?: string;
      join_mode?: string;
    };
    const combinedText = `${input.description ?? ""}\n${input.prompt ?? ""}`;
    const knownSteps = state.artifact.steps.map((step) => step.step);
    const referencedSteps = extractReferencedStepsFromText(combinedText, knownSteps);
    const frontier = getExecutionFrontier(state.artifact.steps);
    const frontierNumbers = new Set(frontier.map((step) => step.step));

    if (frontier.length > 0 && referencedSteps.length === 0) {
      return {
        block: true,
        reason: `Execution subagents must reference a numbered plan step from the current ready frontier (${frontier.map((step) => step.step).join(", ")}).`,
      };
    }

    const offFrontier = referencedSteps.filter((step) => !frontierNumbers.has(step));
    if (offFrontier.length > 0) {
      return {
        block: true,
        reason: `Only the current ready frontier may be delegated. Off-frontier step reference(s): ${offFrontier.join(", ")}.`,
      };
    }

    const requestedAgent = normalizeAgentPreference(input.subagent_type);
    for (const step of frontier.filter((item) => referencedSteps.includes(item.step))) {
      const policy = deriveSubagentPolicy(step, frontier.length);
      if (policy.preferredAgent !== "main session" && requestedAgent !== policy.preferredAgent) {
        return {
          block: true,
          reason: `Step ${step.step} is planned for ${policy.preferredAgent}. Requested subagent type was ${requestedAgent}.`,
        };
      }
      if (policy.isolation === "worktree" && input.isolation !== "worktree") {
        return {
          block: true,
          reason: `Parallel write-capable work for step ${step.step} must use isolation: worktree.`,
        };
      }
      if (policy.runInBackground && input.run_in_background !== true) {
        return {
          block: true,
          reason: `Step ${step.step} should run as a background subagent so the frontier can fan out before fan-in.`,
        };
      }
      if (policy.joinMode === "group" && input.join_mode === "async") {
        return {
          block: true,
          reason: `Step ${step.step} should use grouped fan-in notifications, not async join mode, while the current frontier is parallelized.`,
        };
      }
    }

    if (!/\bverification\b/i.test(combinedText) || !/\bfiles?\b/i.test(combinedText) || !/\b(?:blocker|risk)s?\b/i.test(combinedText)) {
      return {
        block: true,
        reason: "Delegated execution prompts must request a normalized result summary covering files touched, verification, and blockers/risks.",
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === SUBAGENT_TOOL_NAMES[0] || event.toolName === SUBAGENT_TOOL_NAMES[1] || event.toolName === SUBAGENT_TOOL_NAMES[2]) {
      if (state.mode === "executing" && event.toolName === SUBAGENT_TOOL_NAMES[1]) {
        const agentId = String((event.input as { agent_id?: string }).agent_id ?? "");
        const summary = extractTextFromUnknown((event as { output?: unknown; result?: unknown }).output ?? (event as { output?: unknown; result?: unknown }).result).replace(/\s+/g, " ").trim();
        if (agentId) {
          const existing = state.subagents.find((item) => item.id === agentId);
          if (existing && summary) {
            existing.normalizedSummary = summary.slice(0, 280);
            if (!/\bverification\b/i.test(summary) || !/\bfiles?\b/i.test(summary) || !/\b(?:blocker|risk)s?\b/i.test(summary)) {
              noteProgress(undefined, [`Subagent ${agentId} returned a result without the full normalized summary contract (files, verification, blockers/risks).`]);
            }
          }
        }
      }
      pruneFinishedSubagents();
      scheduleStateFlush(ctx, { persist: true });
    }

    if (!state.planPath) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const input = event.input as { path?: string };
    if (!input.path) return;

    const resolvedInput = resolve(ctx.cwd, input.path);
    if (resolvedInput !== resolve(state.planPath)) return;

    await syncPlanFromDisk(ctx);
    scheduleStateFlush(ctx, { persist: true });
  });

  pi.on("turn_end", async (event, ctx) => {
    if (state.mode !== "executing" || !state.artifact) return;
    if (!isAssistantMessage(event.message)) return;

    const progress = markCompletedSteps(getAssistantText(event.message), state.artifact.steps);
    if (progress.count > 0 || progress.warnings.length > 0) {
      noteProgress(progress.source, progress.warnings);
      scheduleStateFlush(ctx, { persist: true });
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (isPlanAuthoringMode(state.mode)) {
      await syncPlanFromDisk(ctx);
      scheduleStateFlush(ctx, { persist: true });
      return;
    }

    if (state.mode === "executing" && state.artifact?.steps.length && state.artifact.steps.every((step) => step.completed)) {
      ctx.ui.notify("Plan execution complete.", "success");
      exitPlanMode(ctx);
      return;
    }

    if (state.mode === "executing") {
      scheduleStateFlush(ctx, { persist: true });
    }
  });

  async function restoreAndApply(ctx: ExtensionContext): Promise<void> {
    latestCtx = ctx;
    sessionVersion += 1;
    const currentSessionVersion = sessionVersion;
    restoreFromBranch(ctx);

    if (pi.getFlag("plan") === true && state.mode === "normal") {
      state.previousActiveTools = pi.getActiveTools();
      state.mode = "planning";
    }

    if (state.mode !== "normal") {
      await ensurePlanFile(ctx);
      if (currentSessionVersion !== sessionVersion) return;
      await syncPlanFromDisk(ctx);
      if (currentSessionVersion !== sessionVersion) return;
    }

    applyMode(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreAndApply(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await restoreAndApply(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionVersion += 1;
    ctx.ui.setStatus("opencode-plan", undefined);
    clearWorkflowWidget(ctx);
    planEditor?.setSidebarState(undefined);
    planEditor?.dispose?.();
    planEditor = undefined;
    latestCtx = undefined;
    editorInstalled = false;
    stateFlushScheduled = false;
    persistQueued = false;
  });

  pi.events.on("subagents:created", (eventData: { id: string; type: string; description: string; isBackground?: boolean }) => {
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: eventData.isBackground ? "background" : "queued",
      isBackground: eventData.isBackground,
      startedAt: Date.now(),
      stepNumbers: extractReferencedStepsFromText(eventData.description, state.artifact?.steps.map((step) => step.step) ?? []),
    });
    if (latestCtx) {
      pruneFinishedSubagents();
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:started", (eventData: { id: string; type: string; description: string }) => {
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: "running",
      stepNumbers: extractReferencedStepsFromText(eventData.description, state.artifact?.steps.map((step) => step.step) ?? []),
    });
    if (latestCtx) {
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:completed", (eventData: { id: string; type: string; description: string; status?: string; toolUses?: number; durationMs?: number }) => {
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: (eventData.status as SubagentStatus | undefined) ?? "completed",
      completedAt: Date.now(),
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      stepNumbers: extractReferencedStepsFromText(eventData.description, state.artifact?.steps.map((step) => step.step) ?? []),
    });
    if (latestCtx) {
      pruneFinishedSubagents();
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:failed", (eventData: { id: string; type: string; description: string; status?: string; error?: string; toolUses?: number; durationMs?: number }) => {
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: (eventData.status as SubagentStatus | undefined) ?? "failed",
      completedAt: Date.now(),
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      error: eventData.error,
      stepNumbers: extractReferencedStepsFromText(eventData.description, state.artifact?.steps.map((step) => step.step) ?? []),
    });
    if (latestCtx) {
      pruneFinishedSubagents();
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:steered", (eventData: { id: string }) => {
    upsertSubagent({ id: eventData.id, status: "running" });
    if (latestCtx) {
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });
}
