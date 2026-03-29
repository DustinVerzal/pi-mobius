import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Key } from "@mariozechner/pi-tui";
import { DockedPlanModeEditor } from "./docked-editor.js";
import { showApprovalReview } from "./approval-review.js";
import { getPlanWorkflowPresentation, renderPlanSidebarFallback, type PlanSidebarViewModel } from "./sidebar.js";
import {
  buildExecutionHandoff,
  buildPlanningKickoffPrompt,
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
  normalizeCheckpointSummary,
  planInstructions,
  planPathForSession,
  stripPlanOnlyTools,
  stripPromptMasterTools,
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

interface PendingDelegationIntent {
  type: string;
  description: string;
  prompt?: string;
  stepNumbers: number[];
  requestedAgent: string;
  stepAssociation: string;
  recordedAt: string;
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
  return { errors: [], blocking: [], warnings: [] };
}

interface ApprovalReviewOptions {
  options: string[];
  approveLabel?: string;
  overrideRequired: boolean;
}

function getApprovalReviewOptions(validation: PlanValidation, directStart = false): ApprovalReviewOptions {
  if (validation.errors.length > 0) {
    return {
      options: ["Revise in editor", "Keep planning"],
      overrideRequired: false,
    };
  }

  const overrideRequired = validation.blocking.length > 0;
  const approveLabel = overrideRequired
    ? (directStart ? "Approve and start anyway" : "Approve anyway")
    : (directStart ? "Approve and start execution" : "Approve plan");

  return {
    options: [approveLabel, "Revise in editor", "Keep planning"],
    approveLabel,
    overrideRequired,
  };
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

function isPlanAuthoringMode(mode: PlanMode): boolean {
  return mode === "planning" || mode === "approval_pending" || mode === "approved_waiting_execution";
}

function cloneSubagent(activity: PlanSubagentActivity): PlanSubagentActivity {
  return {
    ...activity,
    progressItems: activity.progressItems?.map((item) => ({ ...item })),
  };
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
  let lastSidebarSyncSignature: string | undefined;
  let lastWorkflowWidgetSyncSignature: string | undefined;
  let lastStatusSyncValue: string | undefined;
  let hasSidebarSync = false;
  let hasWorkflowWidgetSync = false;
  let hasStatusSync = false;
  let pendingDelegationIntents: PendingDelegationIntent[] = [];

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

  function getWorkflowResumeTools(): string[] {
    const base = state.previousActiveTools && state.previousActiveTools.length > 0
      ? stripPlanOnlyTools(state.previousActiveTools)
      : stripPlanOnlyTools(pi.getAllTools().map((tool) => tool.name));
    return uniqueNames(stripPromptMasterTools(base));
  }

  function getExecutionTools(): string[] {
    return uniqueNames([...getWorkflowResumeTools(), PLAN_PROGRESS_TOOL_NAME]);
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
        checkpoints: [],
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
        checkpoints: [],
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

    if (state.mode !== "planning") {
      execution.warnings = uniqueNames([
        ...execution.warnings,
        ...state.artifact.validation.errors.map((error) => `Plan validation error: ${error}`),
        ...state.artifact.validation.blocking.map((item) => `Plan approval blocker: ${item}`),
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
        if ((state.artifact?.validation.errors.length ?? 0) > 0) return "Fix plan validation errors before approval.";
        if ((state.artifact?.validation.blocking.length ?? 0) > 0) return "Review the approval blockers or approve with override from /plan.";
        return "Call plan_exit or run /plan to review and approve this plan and operating envelope.";
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
    if (state.panelVisible === false) return 72;
    return Math.max(48, Math.min(88, planEditor?.getLastRenderWidth() ?? 72));
  }

  function resetUiSyncState(): void {
    lastSidebarSyncSignature = undefined;
    lastWorkflowWidgetSyncSignature = undefined;
    lastStatusSyncValue = undefined;
    hasSidebarSync = false;
    hasWorkflowWidgetSync = false;
    hasStatusSync = false;
  }

  function getSidebarSyncSignature(model: PlanSidebarViewModel | undefined): string {
    return JSON.stringify(model ?? null);
  }

  function syncStatus(ctx: ExtensionContext, value: string | undefined): void {
    if (!ctx.hasUI) return;
    if (hasStatusSync && lastStatusSyncValue === value) return;
    lastStatusSyncValue = value;
    hasStatusSync = true;
    ctx.ui.setStatus("opencode-plan", value);
  }

  function clearWorkflowWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (hasWorkflowWidgetSync && lastWorkflowWidgetSyncSignature === "clear") return;
    lastWorkflowWidgetSyncSignature = "clear";
    hasWorkflowWidgetSync = true;
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
  }

  function syncSidebar(ctx: ExtensionContext): void {
    if (!planEditor) return;
    const model = getSidebarViewModel(ctx);
    const nextSignature = getSidebarSyncSignature(model);
    if (hasSidebarSync && lastSidebarSyncSignature === nextSignature) return;
    lastSidebarSyncSignature = nextSignature;
    hasSidebarSync = true;
    planEditor.setSidebarState(model);
  }

  function syncWorkflowWidget(ctx: ExtensionContext, model: PlanSidebarViewModel | undefined): void {
    if (!ctx.hasUI) return;
    if (!model) {
      clearWorkflowWidget(ctx);
      return;
    }

    const presentationOptions = { allowDocked: state.panelVisible !== false };
    const presentation = planEditor?.getWorkflowPresentation(model, presentationOptions)
      ?? getPlanWorkflowPresentation(planEditor?.getLastRenderWidth(), model, presentationOptions);

    if (presentation.mode === "docked") {
      clearWorkflowWidget(ctx);
      return;
    }

    const widgetLines = renderPlanSidebarFallback(model, ctx.ui.theme, getCompactSidebarWidth());
    const nextSignature = `widget:${JSON.stringify(widgetLines)}`;
    if (hasWorkflowWidgetSync && lastWorkflowWidgetSyncSignature === nextSignature) return;
    lastWorkflowWidgetSyncSignature = nextSignature;
    hasWorkflowWidgetSync = true;
    ctx.ui.setWidget(WIDGET_KEY, widgetLines, { placement: "belowEditor" });
  }

  function updateUi(ctx: ExtensionContext): void {
    const steps = getSteps();
    const completed = steps.filter((step) => step.completed).length;
    const warningCount = state.execution?.warnings.length ?? 0;
    const workflowModel = buildSidebarViewModel(ctx);
    let statusValue: string | undefined;

    if (state.mode === "executing" && steps.length > 0) {
      const warningSuffix = warningCount > 0 ? ctx.ui.theme.fg("warning", ` !${warningCount}`) : "";
      const frontierSuffix = state.execution?.frontierStepNumbers.length
        ? ctx.ui.theme.fg("muted", ` · ${formatFrontierLabel(getExecutionFrontier(steps))}`)
        : "";
      statusValue = ctx.ui.theme.fg("accent", `PLAN ${completed}/${steps.length}`) + frontierSuffix + warningSuffix;
    } else if (state.mode === "approved_waiting_execution") {
      statusValue = ctx.ui.theme.fg("success", "PLAN READY");
    } else if (state.mode === "approval_pending") {
      statusValue = ctx.ui.theme.fg("warning", "PLAN REVIEW");
    } else if (state.mode === "planning") {
      statusValue = ctx.ui.theme.fg("warning", "PLAN");
    }

    syncStatus(ctx, statusValue);
    syncSidebar(ctx);
    syncWorkflowWidget(ctx, workflowModel);
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
      const initialSidebarModel = getSidebarViewModel(ctx);
      planEditor.setSidebarState(initialSidebarModel);
      lastSidebarSyncSignature = getSidebarSyncSignature(initialSidebarModel);
      hasSidebarSync = true;
      return planEditor;
    });
  }

  function applyMode(ctx: ExtensionContext): void {
    latestCtx = ctx;
    if (isPlanAuthoringMode(state.mode)) {
      pi.setActiveTools(getPlanningTools());
    } else if (state.mode === "approved_waiting_execution") {
      pi.setActiveTools(getWorkflowResumeTools());
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

  function cloneExecutionStateForSession(execution: PlanExecutionState | undefined, warnings: string[]): PlanExecutionState {
    return {
      completedSteps: [...(execution?.completedSteps ?? [])],
      activeStep: execution?.activeStep,
      readySteps: [...(execution?.readySteps ?? [])],
      frontierStepNumbers: [...(execution?.frontierStepNumbers ?? [])],
      frontierBatch: execution?.frontierBatch,
      blockedSteps: [...(execution?.blockedSteps ?? [])],
      checkpoints: [...(execution?.checkpoints ?? []).map((checkpoint) => ({
        ...checkpoint,
        files: [...checkpoint.files],
        verification: [...checkpoint.verification],
        blockers: [...checkpoint.blockers],
        missing: [...checkpoint.missing],
      }))],
      warnings: [...warnings],
      planChangedSinceApproval: execution?.planChangedSinceApproval,
      requiresReapproval: execution?.requiresReapproval,
      lastProgressAt: execution?.lastProgressAt,
      lastProgressSource: execution?.lastProgressSource,
      lastDelegation: execution?.lastDelegation ? { ...execution.lastDelegation } : undefined,
    };
  }

  function buildExecutionKickoffPrompt(planPath: string, approval: PlanState["approval"] | undefined, cwd: string): string {
    const approvedHandoff = approval?.handoff;
    const frontierNote = approvedHandoff?.readySteps.length
      ? ` Ready frontier: ${approvedHandoff.readySteps.join(", ")}${approvedHandoff.frontierBatch ? ` (batch ${approvedHandoff.frontierBatch})` : ""}.`
      : "";
    const successNote = approvedHandoff?.successCriteria.length
      ? ` Success criteria: ${approvedHandoff.successCriteria.join(" | ")}.`
      : "";
    const scopeNote = approvedHandoff?.scopeAnchors.length
      ? ` Scope anchors: ${approvedHandoff.scopeAnchors.join(" | ")}.`
      : "";
    const verificationNote = approvedHandoff?.verification.length
      ? ` Verification focus: ${approvedHandoff.verification.join(" | ")}.`
      : "";
    const policyNote = approvedHandoff?.executionPolicy.length
      ? ` Execution policy: ${approvedHandoff.executionPolicy.join(" | ")}.`
      : "";
    const pauseNote = approvedHandoff?.pauseConditions.length
      ? ` Pause conditions: ${approvedHandoff.pauseConditions.join(" | ")}.`
      : "";
    const delegationNote = approvedHandoff?.delegationGuidance.length
      ? ` Delegation guidance: ${approvedHandoff.delegationGuidance.join(" | ")}.`
      : "";

    return `Execute the approved plan in ${toProjectRelative(planPath, cwd)}. Start from the ready frontier rather than the first unfinished step in plan order, fan out same-batch parallel work when it is truly independent, and include [DONE:n] markers as each step completes.${frontierNote}${successNote}${scopeNote}${verificationNote}${policyNote}${pauseNote}${delegationNote}`;
  }

  async function seedFreshExecutionSession(
    parentSession: string | undefined,
    handoff: {
      planPath: string;
      previousActiveTools?: string[];
      panelVisible: boolean;
      approval?: PlanState["approval"];
      artifact?: PlanArtifact;
      execution?: PlanExecutionState;
    },
    ctx: ExtensionCommandContext,
  ): Promise<{ cancelled: boolean }> {
    return ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        const approval = handoff.approval
          ? {
            ...handoff.approval,
            validation: handoff.approval.validation ? { ...handoff.approval.validation } : handoff.approval.validation,
            handoff: handoff.approval.handoff,
          }
          : undefined;
        const warnings = deriveExecutionWarnings(handoff.artifact, approval?.approvedSignature, handoff.execution?.warnings);
        const execution = cloneExecutionStateForSession(handoff.execution, warnings);
        execution.lastProgressAt = execution.lastProgressAt ?? new Date().toISOString();

        sessionManager.appendCustomEntry(STATE_ENTRY, {
          mode: "executing",
          planPath: handoff.planPath,
          previousActiveTools: handoff.previousActiveTools,
          panelVisible: handoff.panelVisible,
          artifact: handoff.artifact,
          approval,
          execution,
          subagents: [],
        });
        sessionManager.appendCustomEntry(EXECUTE_ENTRY, {
          mode: "executing",
          planPath: handoff.planPath,
          artifact: handoff.artifact,
          approval,
          execution,
        });
      },
    });
  }

  async function seedFreshPlanningSession(
    parentSession: string | undefined,
    request: string,
    previousActiveTools: string[] | undefined,
    panelVisible: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<{ cancelled: boolean }> {
    return ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        const sessionFile = sessionManager.getSessionFile();
        if (!sessionFile) {
          throw new Error("Could not resolve the fresh planning session file.");
        }

        const planPath = planPathForSession(sessionFile, ctx.cwd);
        await mkdir(dirname(planPath), { recursive: true });
        if (!(await fileExists(planPath))) {
          await writeFile(planPath, createPlanTemplate(request), "utf8");
        }

        sessionManager.appendCustomEntry(STATE_ENTRY, {
          mode: "planning",
          planPath,
          previousActiveTools,
          panelVisible,
          artifact: undefined,
          approval: undefined,
          execution: undefined,
          subagents: [],
        });
      },
    });
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
        ["Re-review plan and envelope", "Override and start execution", "Cancel"],
      );
      if (!choice || choice === "Cancel") {
        ctx.ui.notify("Starting execution was cancelled.", "info");
        return;
      }
      if (choice === "Re-review plan and envelope") {
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
      artifact: state.artifact,
      execution: state.execution,
    };

    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await seedFreshExecutionSession(parentSession, handoff, ctx);
    if (result.cancelled) {
      ctx.ui.notify("Starting execution was cancelled.", "info");
      return;
    }

    ctx.ui.notify("Started execution in a fresh session.", "info");
    queueUserMessage(ctx, buildExecutionKickoffPrompt(handoff.planPath, handoff.approval, ctx.cwd));
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
      const kickoffPrompt = buildPlanningKickoffPrompt(request);

      const result = await seedFreshPlanningSession(
        parentSession,
        request,
        pi.getActiveTools(),
        state.panelVisible,
        ctx,
      );
      if (result.cancelled) {
        ctx.ui.notify("Starting a fresh planning session was cancelled.", "info");
        return;
      }

      ctx.ui.notify("Started a fresh planning session with the native planning kickoff.", "info");
      queueUserMessage(ctx, kickoffPrompt);
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

      const approvalOptions = getApprovalReviewOptions(validation, options.directStart);
      const choice = await showApprovalReview(ctx, {
        title: "Review plan and operating envelope",
        summary,
        options: approvalOptions.options,
      });

      if (!choice || !approvalOptions.options.includes(choice) || choice === "Keep planning") {
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

      if (!approvalOptions.approveLabel || choice !== approvalOptions.approveLabel) {
        state.mode = "planning";
        applyMode(ctx);
        scheduleStateFlush(ctx, { persist: true });
        return { action: "kept_planning", startedExecution: false, planPath };
      }

      if (approvalOptions.overrideRequired && validation.blocking.length > 0) {
        ctx.ui.notify(
          `Plan approved with override. ${validation.blocking.length} approval blocker${validation.blocking.length === 1 ? " remains" : "s remain"}; they will carry into execution warnings.`,
          "warning",
        );
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
          successCriteria: [],
          executionPolicy: [],
          rereviewTriggers: [],
          blockers: [],
          openQuestions: [],
          files: [],
          verification: [],
          steps: restoredState.steps.map((step) => ({
            ...step,
            scope: step.scope ?? [],
            checkpoint: step.checkpoint ?? [],
            reviewGate: step.reviewGate,
            reviewReason: step.reviewReason,
          })),
          validation: emptyValidation(),
          signature: restoredState.steps.map((step) => `${step.step}:${step.text}`).join("\n"),
          handoff: buildExecutionHandoff({
            goal: undefined,
            context: [],
            successCriteria: [],
            executionPolicy: [],
            rereviewTriggers: [],
            blockers: [],
            files: [],
            verification: [],
            steps: restoredState.steps.map((step) => ({
              ...step,
              scope: step.scope ?? [],
              checkpoint: step.checkpoint ?? [],
              reviewGate: step.reviewGate,
              reviewReason: step.reviewReason,
            })),
          }),
        }
        : undefined);

      state = {
        mode: restoredState.mode ?? "normal",
        planPath: restoredState.planPath,
        previousActiveTools: restoredState.previousActiveTools,
        panelVisible: restoredState.panelVisible ?? true,
        artifact: legacyArtifact,
        approval: restoredState.approval,
        execution: restoredState.execution
          ? {
            ...restoredState.execution,
            checkpoints: [...(restoredState.execution.checkpoints ?? [])],
          }
          : restoredState.execution,
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
        checkpoints: [],
        warnings: [],
      };
      const checkpointWarnings = progress.count > 0 ? recordStepCheckpoint(progress.completedSteps, textSinceExecute, "assistant") : [];
      state.execution.warnings = uniqueNames([...(state.execution.warnings ?? []), ...progress.warnings, ...checkpointWarnings]);
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

  function recordStepCheckpoint(stepNumbers: number[], summaryText: string | undefined, source: "assistant" | "tool" | "subagent"): string[] {
    if (stepNumbers.length === 0) return [];

    const execution = ensureExecutionState();
    const rawSummary = (summaryText ?? "").replace(/\s+/g, " ").trim();
    const normalized = normalizeCheckpointSummary(rawSummary);
    const label = stepNumbers.length === 1 ? `step ${stepNumbers[0]}` : `steps ${stepNumbers.join(", ")}`;
    const warnings: string[] = [];

    if (!rawSummary) {
      warnings.push(`Recorded ${label} completion without a normalized checkpoint summary.`);
    } else if (normalized.missing.length > 0) {
      warnings.push(`Checkpoint for ${label} is missing ${normalized.missing.join(", ")}.`);
    }

    const recordedAt = new Date().toISOString();
    for (const step of stepNumbers) {
      const checkpoint = {
        step,
        source,
        status: normalized.missing.length === 0 ? "complete" as const : "partial" as const,
        outcome: normalized.outcome,
        files: [...normalized.files],
        verification: [...normalized.verification],
        blockers: [...normalized.blockers],
        unblockStatus: normalized.unblockStatus,
        missing: [...normalized.missing],
        rawSummary,
        recordedAt,
      };
      const existingIndex = execution.checkpoints.findIndex((item) => item.step === step);
      if (existingIndex >= 0) execution.checkpoints.splice(existingIndex, 1, checkpoint);
      else execution.checkpoints.push(checkpoint);
    }

    execution.checkpoints.sort((a, b) => a.step - b.step);
    return warnings;
  }

  function mergeStepNumbers(...sets: Array<number[] | undefined>): number[] | undefined {
    const merged = [...new Set(sets.flatMap((value) => value ?? []).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
    return merged.length > 0 ? merged : undefined;
  }

  function recordDelegationObservation(status: "allowed" | "blocked", reason: string, stepNumbers: number[] = [], requestedAgent?: string): void {
    const execution = ensureExecutionState();
    execution.lastDelegation = {
      status,
      reason,
      stepNumbers: [...stepNumbers].sort((a, b) => a - b),
      requestedAgent,
      recordedAt: new Date().toISOString(),
    };
  }

  function queueDelegationIntent(intent: PendingDelegationIntent): void {
    pendingDelegationIntents.push(intent);
    pendingDelegationIntents = pendingDelegationIntents.slice(-12);
  }

  function takePendingDelegationIntent(type: string): PendingDelegationIntent | undefined {
    const matchIndex = pendingDelegationIntents.findIndex((intent) => intent.type === type);
    if (matchIndex < 0) return undefined;
    const [intent] = pendingDelegationIntents.splice(matchIndex, 1);
    return intent;
  }

  function delegationContractStatus(text: string): { hasOutcome: boolean; hasFiles: boolean; hasVerification: boolean; hasBlockers: boolean; hasUnblockStatus: boolean } {
    return {
      hasOutcome: /\b(?:outcome|result)\b/i.test(text),
      hasFiles: /\bfiles?\b|\bpaths?\b/i.test(text),
      hasVerification: /\bverification\b|\bvalidat(?:e|ed|ion)\b|\btests?\b|\bchecks?\b|\bproof\b/i.test(text),
      hasBlockers: /\b(?:blocker|risk|issue|follow-?up)s?\b/i.test(text),
      hasUnblockStatus: /\b(?:unblock(?:ed)?\s+status|unblocked|downstream\s+status|next\s+frontier)\b/i.test(text),
    };
  }

  function describeDelegationAssociation(source: "description" | "prompt" | "intent", stepNumbers: number[]): string {
    const detail = stepNumbers.length > 0 ? `steps ${stepNumbers.join(", ")}` : "no steps";
    if (source === "intent") return `linked from delegated request (${detail})`;
    if (source === "prompt") return `linked from prompt text (${detail})`;
    return `linked from description (${detail})`;
  }

  function upsertSubagent(update: Partial<PlanSubagentActivity> & { id: string; description?: string; type?: string; status?: SubagentStatus }): void {
    const existing = state.subagents.find((item) => item.id === update.id);
    const mergedSteps = mergeStepNumbers(existing?.stepNumbers, update.stepNumbers);
    const { progressItems, ...rest } = update;
    const definedUpdate = Object.fromEntries(Object.entries(rest).filter(([_key, value]) => value !== undefined));

    if (existing) {
      Object.assign(existing, definedUpdate);
      existing.stepNumbers = mergedSteps;
      if (update.stepAssociation) existing.stepAssociation = update.stepAssociation;
      if (progressItems) existing.progressItems = progressItems.map((item) => ({ ...item }));
      if (update.activeProgressItemId !== undefined) existing.activeProgressItemId = update.activeProgressItemId;
      if (update.fallbackActivity !== undefined) existing.fallbackActivity = update.fallbackActivity;
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
      stepNumbers: mergedSteps,
      stepAssociation: update.stepAssociation,
      normalizedSummary: update.normalizedSummary,
      progressItems: progressItems?.map((item) => ({ ...item })),
      activeProgressItemId: update.activeProgressItemId,
      fallbackActivity: update.fallbackActivity,
    });
  }

  function getSubagentAssociation(type: string, description: string): { stepNumbers?: number[]; stepAssociation?: string } {
    const knownSteps = state.artifact?.steps.map((step) => step.step) ?? [];
    const descriptionSteps = extractReferencedStepsFromText(description, knownSteps);
    if (descriptionSteps.length > 0) {
      return {
        stepNumbers: descriptionSteps,
        stepAssociation: describeDelegationAssociation("description", descriptionSteps),
      };
    }

    const intent = takePendingDelegationIntent(normalizeAgentPreference(type));
    if (intent) {
      return {
        stepNumbers: intent.stepNumbers,
        stepAssociation: intent.stepAssociation,
      };
    }

    return {};
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
              ? "Prepared /plan <request> in the editor so the user can restart planning in a fresh session with the native kickoff prompt."
              : `Ask the user to run ${bootstrapCommand} to restart planning in a fresh session with the native kickoff prompt.`,
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
      const checkpointWarnings = (normalizedStatus === "completed" || (params.note && String(params.note).trim()))
        ? recordStepCheckpoint([Number(params.step)], String(params.note ?? ""), "tool")
        : [];
      noteProgress("tool", [...result.warnings, ...checkpointWarnings]);
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
    if (state.mode !== "normal" && event.toolName === "prompt_improve") {
      return {
        block: true,
        reason: "Prompt improvement is blocked while plan mode is active. Exit plan mode before invoking prompt_improve directly.",
      };
    }

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
    const descriptionText = input.description ?? "";
    const promptText = input.prompt ?? "";
    const combinedText = `${descriptionText}\n${promptText}`;
    const knownSteps = state.artifact.steps.map((step) => step.step);
    const descriptionSteps = extractReferencedStepsFromText(descriptionText, knownSteps);
    const promptSteps = extractReferencedStepsFromText(promptText, knownSteps);
    const referencedSteps = extractReferencedStepsFromText(combinedText, knownSteps);
    const frontier = getExecutionFrontier(state.artifact.steps);
    const frontierNumbers = new Set(frontier.map((step) => step.step));
    const requestedAgent = normalizeAgentPreference(input.subagent_type);
    const blockDelegation = (reason: string): { block: true; reason: string } => {
      recordDelegationObservation("blocked", reason, referencedSteps, requestedAgent);
      scheduleStateFlush(ctx, { persist: true });
      return { block: true, reason };
    };

    if (frontier.length > 0 && referencedSteps.length === 0) {
      return blockDelegation(`Execution subagents must reference a numbered plan step from the current ready frontier (${frontier.map((step) => step.step).join(", ")}).`);
    }

    const offFrontier = referencedSteps.filter((step) => !frontierNumbers.has(step));
    if (offFrontier.length > 0) {
      return blockDelegation(`Only the current ready frontier may be delegated. Off-frontier step reference(s): ${offFrontier.join(", ")}.`);
    }

    for (const step of frontier.filter((item) => referencedSteps.includes(item.step))) {
      const policy = deriveSubagentPolicy(step, frontier.length);
      if (policy.preferredAgent === "main session") {
        return blockDelegation(`Step ${step.step} is planned for main session work and should stay in the main session.`);
      }
      if (requestedAgent !== policy.preferredAgent) {
        return blockDelegation(`Step ${step.step} is planned for ${policy.preferredAgent}. Requested subagent type was ${requestedAgent}.`);
      }
      if (policy.isolation === "worktree" && input.isolation !== "worktree") {
        return blockDelegation(`Parallel write-capable work for step ${step.step} must use isolation: worktree.`);
      }
      if (policy.runInBackground && input.run_in_background !== true) {
        return blockDelegation(`Step ${step.step} should run as a background subagent so the frontier can fan out before fan-in.`);
      }
      if (policy.joinMode === "group" && input.join_mode === "async") {
        return blockDelegation(`Step ${step.step} should use grouped fan-in notifications, not async join mode, while the current frontier is parallelized.`);
      }
    }

    const contract = delegationContractStatus(combinedText);
    if (!contract.hasOutcome || !contract.hasFiles || !contract.hasVerification || !contract.hasBlockers || !contract.hasUnblockStatus) {
      const missing: string[] = [];
      if (!contract.hasOutcome) missing.push("outcome/result");
      if (!contract.hasFiles) missing.push("files/paths touched");
      if (!contract.hasVerification) missing.push("verification/tests/checks");
      if (!contract.hasBlockers) missing.push("blockers/risks/issues");
      if (!contract.hasUnblockStatus) missing.push("unblock status");
      return blockDelegation(`Delegated execution prompts must request a normalized result summary covering ${missing.join(", ")}.`);
    }

    const associationSource = descriptionSteps.length > 0 ? "description" : promptSteps.length > 0 ? "prompt" : "intent";
    queueDelegationIntent({
      type: requestedAgent,
      description: descriptionText,
      prompt: promptText,
      stepNumbers: referencedSteps,
      requestedAgent,
      stepAssociation: describeDelegationAssociation(associationSource, referencedSteps),
      recordedAt: new Date().toISOString(),
    });
    recordDelegationObservation(
      "allowed",
      `Delegating frontier step${referencedSteps.length === 1 ? "" : "s"} ${referencedSteps.join(", ")} to ${requestedAgent}.`,
      referencedSteps,
      requestedAgent,
    );
    scheduleStateFlush(ctx, { persist: true });
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
            const summaryItem = {
              id: "normalized-result-summary",
              label: existing.normalizedSummary,
              status: "completed" as const,
              source: "normalized_result_summary" as const,
            };
            existing.progressItems = [
              ...(existing.progressItems ?? []).filter((item) => item.id !== summaryItem.id),
              summaryItem,
            ];
            existing.activeProgressItemId = existing.progressItems.find((item) => item.status === "active")?.id;
            const checkpointWarnings = recordStepCheckpoint(existing.stepNumbers ?? [], summary, "subagent");
            const contract = delegationContractStatus(summary);
            if (!contract.hasOutcome || !contract.hasFiles || !contract.hasVerification || !contract.hasBlockers || !contract.hasUnblockStatus) {
              checkpointWarnings.push(`Subagent ${agentId} returned a result without the full normalized summary contract (outcome/result, files/paths, verification/tests/checks, blockers/risks/issues, unblock status).`);
            }
            if (checkpointWarnings.length > 0) noteProgress(undefined, checkpointWarnings);
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

    const assistantText = getAssistantText(event.message);
    const progress = markCompletedSteps(assistantText, state.artifact.steps);
    if (progress.count > 0) {
      progress.warnings.push(...recordStepCheckpoint(progress.completedSteps, assistantText, "assistant"));
    }
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
    pendingDelegationIntents = [];
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

    resetUiSyncState();
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
    pendingDelegationIntents = [];
    ctx.ui.setStatus("opencode-plan", undefined);
    clearWorkflowWidget(ctx);
    planEditor?.setSidebarState(undefined);
    planEditor?.dispose?.();
    planEditor = undefined;
    latestCtx = undefined;
    editorInstalled = false;
    stateFlushScheduled = false;
    persistQueued = false;
    resetUiSyncState();
  });

  pi.events.on("subagents:progress", (eventData: {
    id: string;
    type: string;
    description: string;
    status?: SubagentStatus;
    isBackground?: boolean;
    startedAt?: number;
    completedAt?: number;
    toolUses?: number;
    durationMs?: number;
    error?: string;
    stepAssociation?: string;
    normalizedSummary?: string;
    activeItemId?: string;
    fallbackActivity?: string;
    items?: Array<{ id: string; label: string; status: "pending" | "active" | "completed"; source: "description" | "step_association" | "normalized_result_summary"; detail?: string }>;
  }) => {
    const association = getSubagentAssociation(eventData.type, eventData.description);
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: eventData.status,
      isBackground: eventData.isBackground,
      startedAt: eventData.startedAt,
      completedAt: eventData.completedAt,
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      error: eventData.error,
      stepNumbers: association.stepNumbers,
      stepAssociation: eventData.stepAssociation ?? association.stepAssociation,
      normalizedSummary: eventData.normalizedSummary,
      progressItems: eventData.items,
      activeProgressItemId: eventData.activeItemId,
      fallbackActivity: eventData.fallbackActivity,
    });
    if (latestCtx) {
      pruneFinishedSubagents();
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:created", (eventData: { id: string; type: string; description: string; isBackground?: boolean }) => {
    const association = getSubagentAssociation(eventData.type, eventData.description);
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: eventData.isBackground ? "background" : "queued",
      isBackground: eventData.isBackground,
      startedAt: Date.now(),
      stepNumbers: association.stepNumbers,
      stepAssociation: association.stepAssociation,
    });
    if (latestCtx) {
      pruneFinishedSubagents();
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:started", (eventData: { id: string; type: string; description: string }) => {
    const association = getSubagentAssociation(eventData.type, eventData.description);
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: "running",
      stepNumbers: association.stepNumbers,
      stepAssociation: association.stepAssociation,
    });
    if (latestCtx) {
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:completed", (eventData: { id: string; type: string; description: string; status?: string; toolUses?: number; durationMs?: number }) => {
    const association = getSubagentAssociation(eventData.type, eventData.description);
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: (eventData.status as SubagentStatus | undefined) ?? "completed",
      completedAt: Date.now(),
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      stepNumbers: association.stepNumbers,
      stepAssociation: association.stepAssociation,
    });
    if (latestCtx) {
      pruneFinishedSubagents();
      scheduleStateFlush(latestCtx, { persist: true });
    }
  });

  pi.events.on("subagents:failed", (eventData: { id: string; type: string; description: string; status?: string; error?: string; toolUses?: number; durationMs?: number }) => {
    const association = getSubagentAssociation(eventData.type, eventData.description);
    upsertSubagent({
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: (eventData.status as SubagentStatus | undefined) ?? "failed",
      completedAt: Date.now(),
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      error: eventData.error,
      stepNumbers: association.stepNumbers,
      stepAssociation: association.stepAssociation,
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
