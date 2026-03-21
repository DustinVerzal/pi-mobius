import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Key, matchesKey, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import { PlanSidebarComponent, type PlanSidebarViewModel } from "./sidebar.js";
import {
  createPlanTemplate,
  executionInstructions,
  extractPlanSteps,
  fileExists,
  formatPlanStatus,
  isSafeReadOnlyCommand,
  markCompletedSteps,
  planInstructions,
  planPathForSession,
  stripPlanOnlyTools,
  type PlanState,
  type PlanStep,
  uniqueNames,
} from "./utils.js";

const STATE_ENTRY = "opencode-plan-state";
const EXECUTE_ENTRY = "opencode-plan-execute";
const QUESTION_TOOL_NAME = "question";
const PLAN_ENTER_TOOL_NAME = "plan_enter";
const PLAN_EXIT_TOOL_NAME = "plan_exit";
const SUBAGENT_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;
const READ_ONLY_SUBAGENTS = new Set(["Explore", "Plan", "explore", "plan"]);
const PLAN_MODE_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "edit", "write", QUESTION_TOOL_NAME, PLAN_EXIT_TOOL_NAME];

function createInitialState(): PlanState {
  return {
    mode: "normal",
    panelVisible: true,
    steps: [],
    previousActiveTools: undefined,
    planPath: undefined,
  };
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

class PlanModeEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly onEmptyTab: () => void,
  ) {
    super(tui, theme, keybindings);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) && this.getText().trim().length === 0) {
      this.onEmptyTab();
      return;
    }
    super.handleInput(data);
  }
}

export default function opencodePlanMode(pi: ExtensionAPI): void {
  let state = createInitialState();
  let editorTui: TUI | undefined;
  let sidebarHandle: OverlayHandle | undefined;
  let sidebarComponent: PlanSidebarComponent | undefined;

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
    if (state.previousActiveTools && state.previousActiveTools.length > 0) {
      return uniqueNames(stripPlanOnlyTools(state.previousActiveTools));
    }
    return uniqueNames(stripPlanOnlyTools(pi.getAllTools().map((tool) => tool.name)));
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY, {
      mode: state.mode,
      planPath: state.planPath,
      previousActiveTools: state.previousActiveTools,
      panelVisible: state.panelVisible,
      steps: state.steps,
    });
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
    if (!state.planPath || !(await fileExists(state.planPath))) {
      state.steps = [];
      updateUi(ctx);
      return;
    }

    const markdown = await readFile(state.planPath, "utf8");
    const parsedSteps = extractPlanSteps(markdown);
    const doneSteps = new Set(state.steps.filter((step) => step.completed).map((step) => step.step));
    state.steps = parsedSteps.map((step) => ({
      ...step,
      completed: doneSteps.has(step.step),
    }));
    updateUi(ctx);
  }

  function disposeSidebar(): void {
    sidebarHandle?.hide();
    sidebarHandle = undefined;
    sidebarComponent = undefined;
  }

  function getSidebarViewModel(ctx: ExtensionContext): PlanSidebarViewModel | undefined {
    if (state.mode === "normal" || state.panelVisible === false) return undefined;

    return {
      mode: state.mode,
      planPath: state.planPath ? state.planPath.replace(`${ctx.cwd}/`, "./") : undefined,
      steps: state.steps,
      toggleHint: "/plan sidebar • Ctrl+Alt+B hide",
    };
  }

  function ensureSidebar(ctx: ExtensionContext): void {
    if (!editorTui) return;
    if (sidebarComponent && sidebarHandle) return;

    sidebarComponent = new PlanSidebarComponent(ctx.ui.theme);
    sidebarHandle = editorTui.showOverlay(sidebarComponent, {
      nonCapturing: true,
      anchor: "right-center",
      width: "28%",
      minWidth: 34,
      maxHeight: "75%",
      margin: { top: 1, right: 1, bottom: 1 },
      visible: (termWidth) => termWidth >= 100,
    });
  }

  function syncSidebar(ctx: ExtensionContext): void {
    ctx.ui.setWidget("opencode-plan-sidebar", undefined);
    const model = getSidebarViewModel(ctx);

    if (!editorTui || !model) {
      disposeSidebar();
      editorTui?.requestRender();
      return;
    }

    ensureSidebar(ctx);
    sidebarComponent?.setState(model);
    sidebarHandle?.setHidden(false);
    editorTui.requestRender();
  }

  function updateUi(ctx: ExtensionContext): void {
    if (state.mode === "executing" && state.steps.length > 0) {
      const completed = state.steps.filter((step) => step.completed).length;
      ctx.ui.setStatus("opencode-plan", ctx.ui.theme.fg("accent", `PLAN ${completed}/${state.steps.length}`));
    } else if (state.mode === "planning") {
      ctx.ui.setStatus("opencode-plan", ctx.ui.theme.fg("warning", "PLAN"));
    } else {
      ctx.ui.setStatus("opencode-plan", undefined);
    }

    void syncSidebar(ctx);
  }

  function togglePlanningFromTab(ctx: ExtensionContext): void {
    if (state.mode === "normal") {
      void enterPlanningMode(ctx).then(() => {
        ctx.ui.notify("Plan mode enabled.", "info");
      });
      return;
    }

    exitPlanMode(ctx);
    ctx.ui.notify("Plan mode disabled.", "info");
  }

  function setSidebarVisibility(ctx: ExtensionContext, visible: boolean): void {
    state.panelVisible = visible;
    updateUi(ctx);
    persistState();
  }

  function toggleSidebar(ctx: ExtensionContext): void {
    setSidebarVisibility(ctx, !state.panelVisible);
  }

  function installEditorHotkey(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      if (editorTui && editorTui !== tui) {
        disposeSidebar();
      }
      editorTui = tui;
      void syncSidebar(ctx);
      return new PlanModeEditor(tui, theme, keybindings, () => {
        togglePlanningFromTab(ctx);
      });
    });
  }

  function applyMode(ctx: ExtensionContext): void {
    if (state.mode === "planning") {
      pi.setActiveTools(getPlanningTools());
    } else if (state.mode === "executing") {
      pi.setActiveTools(getExecutionTools());
    } else if (state.previousActiveTools && state.previousActiveTools.length > 0) {
      pi.setActiveTools(stripPlanOnlyTools(state.previousActiveTools));
    }
    installEditorHotkey(ctx);
    updateUi(ctx);
  }

  async function enterPlanningMode(ctx: ExtensionContext, goal?: string): Promise<void> {
    if (state.mode === "normal") {
      state.previousActiveTools = pi.getActiveTools();
    }
    state.mode = "planning";
    state.panelVisible = state.panelVisible ?? true;
    await ensurePlanFile(ctx, goal);
    await syncPlanFromDisk(ctx);
    applyMode(ctx);
    persistState();
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    state.mode = "normal";
    applyMode(ctx);
    persistState();
  }

  async function startExecutionMode(ctx: ExtensionContext): Promise<void> {
    await ensurePlanFile(ctx);
    await syncPlanFromDisk(ctx);
    state.mode = "executing";
    applyMode(ctx);
    pi.appendEntry(EXECUTE_ENTRY, {
      mode: state.mode,
      planPath: state.planPath,
      steps: state.steps,
    });
    persistState();
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

  function queueUserMessage(ctx: ExtensionContext, text: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    let restoredState: PlanState | undefined;
    let executeIndex = -1;

    for (let i = 0; i < branch.length; i += 1) {
      const entry = branch[i] as {
        type: string;
        customType?: string;
        data?: Partial<PlanState>;
        message?: AgentMessage;
      };
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
        restoredState = {
          mode: entry.data.mode ?? "normal",
          planPath: entry.data.planPath,
          previousActiveTools: entry.data.previousActiveTools,
          panelVisible: entry.data.panelVisible ?? true,
          steps: entry.data.steps ?? [],
        };
      }
      if (entry.type === "custom" && entry.customType === EXECUTE_ENTRY) {
        executeIndex = i;
      }
    }

    if (restoredState) {
      state = restoredState;
    }

    if (state.mode === "executing" && state.steps.length > 0 && executeIndex >= 0) {
      const textSinceExecute = branch
        .slice(executeIndex + 1)
        .filter((entry): entry is { type: string; message: AgentMessage } => entry.type === "message" && "message" in entry)
        .map((entry) => entry.message)
        .filter(isAssistantMessage)
        .map(getAssistantText)
        .join("\n");
      markCompletedSteps(textSinceExecute, state.steps);
    }
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
              ? "Prepared /plan <request> in the editor so the user can restart planning in a fresh session."
              : `Ask the user to run ${bootstrapCommand} to restart planning in a fresh session.`,
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
      if (state.mode !== "planning") {
        throw new Error("plan_exit can only be used while planning.");
      }
      if (!ctx.hasUI) {
        throw new Error("plan_exit requires interactive UI approval.");
      }

      const planPath = await ensurePlanFile(ctx);
      const currentPlan = await readFile(planPath, "utf8");
      const reviewedPlan = await ctx.ui.editor(`Review ${planPath.replace(`${ctx.cwd}/`, "./")}`, currentPlan);
      if (reviewedPlan === undefined) {
        return {
          content: [{ type: "text", text: "Kept planning. Plan review was cancelled." }],
          details: { mode: state.mode, planPath },
        };
      }

      if (reviewedPlan !== currentPlan) {
        await mkdir(dirname(planPath), { recursive: true });
        await writeFile(planPath, reviewedPlan, "utf8");
      }

      await syncPlanFromDisk(ctx);
      const choice = await ctx.ui.select("Approve this plan for execution?", ["Execute approved plan", "Keep planning"]);
      if (choice !== "Execute approved plan") {
        return {
          content: [{ type: "text", text: "Kept planning. Continue refining the plan file." }],
          details: { mode: state.mode, planPath },
        };
      }

      await startExecutionMode(ctx);
      return {
        content: [{ type: "text", text: `Plan approved. Switching to execution for ${planPath.replace(`${ctx.cwd}/`, "./")}.` }],
        details: {
          mode: state.mode,
          planPath,
          steps: state.steps,
        },
      };
    },
  });

  pi.registerCommand("plan", {
    description: "Enter, inspect, or exit opencode-like planning mode",
    handler: async (args, ctx) => {
      const command = args.trim();

      if (command === "status") {
        ctx.ui.notify(formatPlanStatus(state.planPath, ctx.cwd, state.mode, state.panelVisible), "info");
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
        ctx.ui.notify(`Plan sidebar ${state.panelVisible ? "shown" : "hidden"}.`, "info");
        return;
      }

      if (command === "off") {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
        return;
      }

      if (state.mode === "planning" && command) {
        queueUserMessage(ctx, command);
        return;
      }

      if (state.mode === "normal" && command) {
        const result = await ctx.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
        if (result.cancelled) return;
        await enterPlanningMode(ctx, command);
        ctx.ui.notify("Started a fresh planning session.", "info");
        queueUserMessage(ctx, command);
        return;
      }

      if (state.mode === "normal") {
        await enterPlanningMode(ctx);
        ctx.ui.notify("Plan mode enabled. Ask for a plan or use /plan <request>.", "info");
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
      } else {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("b"), {
    description: "Toggle plan sidebar",
    handler: async (ctx) => {
      toggleSidebar(ctx);
      ctx.ui.notify(`Plan sidebar ${state.panelVisible ? "shown" : "hidden"}.`, "info");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (state.mode === "planning") {
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
          content: executionInstructions(state.planPath, ctx.cwd, state.steps),
          display: false,
        },
      };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode !== "planning") return;

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
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.planPath) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const input = event.input as { path?: string };
    if (!input.path) return;

    const resolvedInput = resolve(ctx.cwd, input.path);
    if (resolvedInput !== resolve(state.planPath)) return;

    await syncPlanFromDisk(ctx);
    persistState();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (state.mode === "planning") {
      await syncPlanFromDisk(ctx);
      persistState();
      return;
    }

    if (state.mode === "executing" && state.steps.length > 0 && state.steps.every((step) => step.completed)) {
      ctx.ui.notify("Plan execution complete.", "success");
      exitPlanMode(ctx);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (state.mode !== "executing" || state.steps.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const completed = markCompletedSteps(getAssistantText(event.message), state.steps);
    if (completed > 0) {
      updateUi(ctx);
      persistState();
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);

    if (pi.getFlag("plan") === true && state.mode === "normal") {
      state.previousActiveTools = pi.getActiveTools();
      state.mode = "planning";
    }

    if (state.mode !== "normal") {
      await ensurePlanFile(ctx);
      await syncPlanFromDisk(ctx);
    }

    applyMode(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("opencode-plan", undefined);
    ctx.ui.setWidget("opencode-plan-sidebar", undefined);
    disposeSidebar();
  });
}
