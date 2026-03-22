import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { PlanApprovalState, PlanExecutionState, PlanMode, PlanStep, PlanSubagentActivity } from "./utils.js";

export interface SidebarTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

export interface PlanSidebarViewModel {
  mode: PlanMode;
  planPath?: string;
  goal?: string;
  steps: PlanStep[];
  approval?: PlanApprovalState;
  execution?: PlanExecutionState;
  blockers: string[];
  openQuestions: string[];
  nextAction: string;
  subagents: PlanSubagentActivity[];
  toggleHint?: string;
}

export interface DockedSidebarLayout {
  editorWidth: number;
  sidebarWidth: number;
  gutterWidth: number;
}

export interface PlanSidebarRenderOptions {
  maxLines?: number;
}

export const DOCKED_SIDEBAR_WIDTH_RATIO = 0.24;
export const DOCKED_SIDEBAR_GUTTER_WIDTH = 1;
export const MIN_DOCKED_SIDEBAR_TERM_WIDTH = 120;
export const MIN_DOCKED_SIDEBAR_WIDTH = 30;
export const MAX_DOCKED_SIDEBAR_WIDTH = 42;
export const MIN_DOCKED_EDITOR_WIDTH = 72;
const MAX_VISIBLE_WARNINGS = 1;
const MAX_VISIBLE_SUBAGENTS = 2;
const MAX_VISIBLE_STEPS = 3;
const MAX_VISIBLE_SECTION_ITEMS = 1;
const SECTION_LINE_LIMITS = {
  goal: 2,
  now: 2,
  next: 2,
  warning: 2,
  subagent: 2,
  step: 2,
  blocker: 2,
  question: 1,
};

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "...", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function emptyBoxLine(theme: SidebarTheme, innerWidth: number): string {
  return theme.fg("border", "│") + " ".repeat(innerWidth) + theme.fg("border", "│");
}

function clampWrappedLines(theme: SidebarTheme, innerWidth: number, text: string, maxLines?: number): string[] {
  const wrapped = wrapTextWithAnsi(text, innerWidth, { trim: false });
  const baseLines = wrapped.length > 0 ? wrapped : [""];
  if (!maxLines || baseLines.length <= maxLines) return baseLines;
  if (maxLines <= 1) {
    return [truncateToWidth(`${baseLines[0]} ${theme.fg("dim", "…")}`, innerWidth, "...", true)];
  }

  const visible = baseLines.slice(0, maxLines - 1);
  const hiddenCount = baseLines.length - visible.length;
  return [...visible, theme.fg("dim", `… +${hiddenCount} more line${hiddenCount === 1 ? "" : "s"}`)];
}

function wrapIntoBoxLines(theme: SidebarTheme, innerWidth: number, text: string, maxLines?: number): string[] {
  return clampWrappedLines(theme, innerWidth, text, maxLines).map((line) => theme.fg("border", "│") + padAnsi(line, innerWidth) + theme.fg("border", "│"));
}

function pushSection(lines: string[], theme: SidebarTheme, innerWidth: number, label: string, value?: string, maxLines = 1): void {
  if (!value || value.trim().length === 0) return;
  lines.push(...wrapIntoBoxLines(theme, innerWidth, `${theme.fg("muted", `${label}:`)} ${value}`, maxLines));
}

function modeLabel(theme: SidebarTheme, mode: PlanMode): string {
  switch (mode) {
    case "executing":
      return theme.fg("accent", "executing");
    case "approved_waiting_execution":
      return theme.fg("success", "approved");
    case "approval_pending":
      return theme.fg("warning", "awaiting approval");
    case "planning":
      return theme.fg("warning", "planning");
    default:
      return theme.fg("muted", "normal");
  }
}

function approvalLabel(theme: SidebarTheme, mode: PlanMode): string {
  if (mode === "approved_waiting_execution" || mode === "executing") return theme.fg("success", "approved");
  if (mode === "approval_pending") return theme.fg("warning", "reviewing");
  if (mode === "planning") return theme.fg("muted", "drafting");
  return theme.fg("muted", "inactive");
}

function stepStatePrefix(theme: SidebarTheme, step: PlanStep, currentStep?: number): string {
  if (step.completed) return theme.fg("success", "[x]");
  if (currentStep === step.step || step.status === "in_progress") return theme.fg("accent", "[>]");
  if (step.status === "blocked") return theme.fg("warning", "[!]");
  return theme.fg("muted", "[ ]");
}

function stepText(theme: SidebarTheme, step: PlanStep, currentStep?: number): string {
  if (step.completed) {
    return theme.fg("muted", theme.strikethrough(`${step.step}. ${step.text}`));
  }
  if (currentStep === step.step || step.status === "in_progress") {
    return theme.fg("accent", `${step.step}. ${step.text}`);
  }
  if (step.status === "blocked") {
    return theme.fg("warning", `${step.step}. ${step.text}`);
  }
  return theme.fg("text", `${step.step}. ${step.text}`);
}

function stepLines(theme: SidebarTheme, innerWidth: number, step: PlanStep, currentStep?: number, maxLines = SECTION_LINE_LIMITS.step): string[] {
  const prefix = `${stepStatePrefix(theme, step, currentStep)} `;
  const metadata: string[] = [];
  if (step.agent) metadata.push(step.agent);
  if (typeof step.batch === "number") metadata.push(`b${step.batch}`);
  if (step.dependsOn.length > 0) metadata.push(`deps:${step.dependsOn.join(",")}`);
  const suffix = metadata.length > 0 ? theme.fg("dim", ` (${metadata.join(" • ")})`) : "";
  const wrapped = clampWrappedLines(theme, Math.max(8, innerWidth - visibleWidth(prefix)), stepText(theme, step, currentStep) + suffix, maxLines);
  return wrapped.map((line, index) => {
    const currentPrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
    return theme.fg("border", "│") + padAnsi(`${currentPrefix}${line}`, innerWidth) + theme.fg("border", "│");
  });
}

function summarizeSubagents(theme: SidebarTheme, subagents: PlanSubagentActivity[]): string {
  if (subagents.length === 0) return theme.fg("dim", "none");
  const running = subagents.filter((agent) => agent.status === "running" || agent.status === "queued" || agent.status === "background").length;
  const done = subagents.filter((agent) => agent.status === "completed" || agent.status === "steered").length;
  const failed = subagents.filter((agent) => agent.status === "failed" || agent.status === "stopped").length;
  return [
    running > 0 ? theme.fg("accent", `${running} running`) : undefined,
    done > 0 ? theme.fg("success", `${done} done`) : undefined,
    failed > 0 ? theme.fg("warning", `${failed} attention`) : undefined,
  ].filter(Boolean).join(theme.fg("dim", " · ")) || theme.fg("dim", "none");
}

function subagentLine(theme: SidebarTheme, agent: PlanSubagentActivity): string {
  const status = agent.status === "failed" || agent.status === "stopped"
    ? theme.fg("warning", agent.status)
    : agent.status === "completed" || agent.status === "steered"
      ? theme.fg("success", agent.status)
      : theme.fg("accent", agent.status);
  const steps = agent.stepNumbers && agent.stepNumbers.length > 0 ? theme.fg("dim", `[steps ${agent.stepNumbers.join(",")}] `) : "";
  return `${status} ${steps}${theme.fg("text", agent.description)} ${theme.fg("dim", `(${agent.type})`)}`;
}

function summarizeFrontier(theme: SidebarTheme, model: PlanSidebarViewModel): string | undefined {
  const frontier = model.execution?.frontierStepNumbers ?? [];
  if (frontier.length === 0) return undefined;
  const batch = model.execution?.frontierBatch;
  const batchText = typeof batch === "number" ? `batch ${batch}` : "ready";
  return `${theme.fg("accent", batchText)} ${theme.fg("dim", "·")} ${theme.fg("text", `steps ${frontier.join(", ")}`)}`;
}

function summarizeFanIn(theme: SidebarTheme, model: PlanSidebarViewModel): string | undefined {
  const frontier = new Set(model.execution?.frontierStepNumbers ?? []);
  if (frontier.size === 0) return undefined;
  const frontierAgents = model.subagents.filter((agent) => agent.stepNumbers?.some((step) => frontier.has(step)));
  if (frontierAgents.length === 0) return theme.fg("dim", "no delegated work");
  const running = frontierAgents.filter((agent) => agent.status === "running" || agent.status === "queued" || agent.status === "background").length;
  const done = frontierAgents.filter((agent) => agent.status === "completed" || agent.status === "steered").length;
  const failed = frontierAgents.filter((agent) => agent.status === "failed" || agent.status === "stopped").length;
  return [
    running > 0 ? theme.fg("accent", `${running} waiting`) : undefined,
    done > 0 ? theme.fg("success", `${done} in`) : undefined,
    failed > 0 ? theme.fg("warning", `${failed} failed`) : undefined,
  ].filter(Boolean).join(theme.fg("dim", " · ")) || theme.fg("dim", "idle");
}

function executionBlockers(model: PlanSidebarViewModel): string[] {
  return model.execution?.blockedSteps?.map((item) => `Step ${item.step}: ${item.reason}`) ?? [];
}

function getVisibleSubagents(subagents: PlanSubagentActivity[]): PlanSubagentActivity[] {
  return [...subagents]
    .sort((a, b) => {
      const priority = (agent: PlanSubagentActivity): number => {
        if (agent.status === "failed" || agent.status === "stopped") return 0;
        if (agent.status === "running" || agent.status === "queued" || agent.status === "background") return 1;
        return 2;
      };
      return priority(a) - priority(b) || (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt);
    })
    .slice(0, MAX_VISIBLE_SUBAGENTS);
}

function getVisibleSteps(model: PlanSidebarViewModel): { visible: PlanStep[]; hiddenCount: number } {
  const currentStep = model.execution?.activeStep;
  const visible: PlanStep[] = [];
  const push = (step: PlanStep | undefined): void => {
    if (!step) return;
    if (visible.some((item) => item.step === step.step)) return;
    visible.push(step);
  };

  push(model.steps.find((step) => step.step === currentStep));
  for (const step of model.steps) {
    if (visible.length >= MAX_VISIBLE_STEPS) break;
    if (!step.completed) push(step);
  }
  for (const step of model.steps) {
    if (visible.length >= MAX_VISIBLE_STEPS) break;
    if (step.completed) push(step);
  }

  return {
    visible,
    hiddenCount: Math.max(0, model.steps.length - visible.length),
  };
}

function summarizeStepCounts(theme: SidebarTheme, model: PlanSidebarViewModel): string {
  const completed = model.steps.filter((step) => step.completed).length;
  const blocked = model.steps.filter((step) => !step.completed && step.status === "blocked").length;
  const remaining = Math.max(0, model.steps.length - completed);
  return [
    theme.fg("text", `${completed}/${model.steps.length} done`),
    remaining > 0 ? theme.fg("muted", `${remaining} left`) : theme.fg("success", "complete"),
    blocked > 0 ? theme.fg("warning", `${blocked} blocked`) : undefined,
  ].filter(Boolean).join(theme.fg("dim", " · "));
}

function summarizeOverflow(theme: SidebarTheme, count: number, noun: string): string | undefined {
  if (count <= 0) return undefined;
  return theme.fg("dim", `+${count} more ${noun}`);
}

function renderCompactList(
  lines: string[],
  theme: SidebarTheme,
  innerWidth: number,
  title: string,
  items: string[],
  countLabel?: string,
  itemLineLimit = 1,
): void {
  if (items.length === 0 && !countLabel) return;
  lines.push(emptyBoxLine(theme, innerWidth));
  lines.push(...wrapIntoBoxLines(theme, innerWidth, theme.bold(theme.fg("muted", title))));
  if (countLabel) {
    lines.push(...wrapIntoBoxLines(theme, innerWidth, countLabel));
  }
  for (const item of items.slice(0, MAX_VISIBLE_SECTION_ITEMS)) {
    lines.push(...wrapIntoBoxLines(theme, innerWidth, `• ${item}`, itemLineLimit));
  }
  const overflow = summarizeOverflow(theme, Math.max(0, items.length - MAX_VISIBLE_SECTION_ITEMS), title.toLowerCase());
  if (overflow) {
    lines.push(...wrapIntoBoxLines(theme, innerWidth, overflow));
  }
}

function finalizeSidebarHeight(lines: string[], theme: SidebarTheme, innerWidth: number, maxLines?: number): string[] {
  if (!maxLines || lines.length <= maxLines) return lines;
  if (maxLines <= 3) return lines.slice(0, maxLines);

  const bodyBudget = Math.max(1, maxLines - 2);
  const hiddenCount = Math.max(0, lines.length - bodyBudget - 1);
  return [
    ...lines.slice(0, bodyBudget),
    theme.fg("border", "│") + padAnsi(theme.fg("dim", `… +${hiddenCount} more rail line${hiddenCount === 1 ? "" : "s"}`), innerWidth) + theme.fg("border", "│"),
    theme.fg("border", "╰") + theme.fg("border", "─".repeat(innerWidth)) + theme.fg("border", "╯"),
  ];
}

export function renderPlanSidebar(model: PlanSidebarViewModel, theme: SidebarTheme, width: number, options: PlanSidebarRenderOptions = {}): string[] {
  const innerWidth = Math.max(24, width - 2);
  const currentStep = model.execution?.activeStep;
  const active = model.steps.find((step) => step.step === currentStep);
  const visibleWarnings = model.execution?.warnings.slice(0, MAX_VISIBLE_WARNINGS) ?? [];
  const hiddenWarningCount = Math.max(0, (model.execution?.warnings.length ?? 0) - visibleWarnings.length);
  const visibleSubagents = getVisibleSubagents(model.subagents);
  const hiddenSubagentCount = Math.max(0, model.subagents.length - visibleSubagents.length);
  const visibleSteps = getVisibleSteps(model);
  const frontierSummary = summarizeFrontier(theme, model);
  const fanInSummary = summarizeFanIn(theme, model);
  const blockedReasons = executionBlockers(model);
  const title = model.mode === "executing"
    ? theme.fg("accent", theme.bold(" Workflow Rail "))
    : theme.fg("warning", theme.bold(" Plan Workflow "));

  const lines: string[] = [
    theme.fg("border", "╭") + padAnsi(title, innerWidth) + theme.fg("border", "╮"),
  ];

  pushSection(
    lines,
    theme,
    innerWidth,
    "Mode",
    `${modeLabel(theme, model.mode)} ${theme.fg("dim", "·")} ${approvalLabel(theme, model.mode)}`,
  );
  pushSection(lines, theme, innerWidth, "Progress", summarizeStepCounts(theme, model));
  pushSection(lines, theme, innerWidth, "Ready", frontierSummary);
  pushSection(lines, theme, innerWidth, "Fan-in", fanInSummary);
  if (model.planPath) {
    pushSection(lines, theme, innerWidth, "Plan", theme.fg("dim", model.planPath));
  }
  if (model.goal) {
    pushSection(lines, theme, innerWidth, "Goal", theme.fg("dim", model.goal), SECTION_LINE_LIMITS.goal);
  }
  if (active) {
    pushSection(lines, theme, innerWidth, "Now", theme.fg("accent", `${active.step}. ${active.text}`), SECTION_LINE_LIMITS.now);
  }
  pushSection(lines, theme, innerWidth, "Next", theme.fg("text", model.nextAction), SECTION_LINE_LIMITS.next);

  if (visibleWarnings.length > 0) {
    lines.push(emptyBoxLine(theme, innerWidth));
    lines.push(...wrapIntoBoxLines(theme, innerWidth, theme.bold(theme.fg("warning", "Warnings"))));
    for (const warning of visibleWarnings) {
      lines.push(...wrapIntoBoxLines(theme, innerWidth, `${theme.fg("warning", "! ")}${warning}`, SECTION_LINE_LIMITS.warning));
    }
    const overflow = summarizeOverflow(theme, hiddenWarningCount, "warnings");
    if (overflow) {
      lines.push(...wrapIntoBoxLines(theme, innerWidth, overflow));
    }
  }

  lines.push(emptyBoxLine(theme, innerWidth));
  lines.push(...wrapIntoBoxLines(theme, innerWidth, `${theme.fg("muted", "Subagents:")} ${summarizeSubagents(theme, model.subagents)}`));
  for (const agent of visibleSubagents) {
    lines.push(...wrapIntoBoxLines(theme, innerWidth, `• ${subagentLine(theme, agent)}`, SECTION_LINE_LIMITS.subagent));
  }
  const subagentOverflow = summarizeOverflow(theme, hiddenSubagentCount, "subagents");
  if (subagentOverflow) {
    lines.push(...wrapIntoBoxLines(theme, innerWidth, subagentOverflow));
  }

  lines.push(emptyBoxLine(theme, innerWidth));
  lines.push(...wrapIntoBoxLines(theme, innerWidth, theme.bold(theme.fg("muted", "Focus"))));
  if (model.steps.length === 0) {
    lines.push(...wrapIntoBoxLines(theme, innerWidth, theme.fg("dim", "No numbered plan steps detected yet.")));
  } else {
    for (const step of visibleSteps.visible) {
      lines.push(...stepLines(theme, innerWidth, step, currentStep));
      if (step.note && (step.step === currentStep || step.status === "blocked")) {
        lines.push(...wrapIntoBoxLines(theme, innerWidth, `   ${theme.fg("dim", step.note)}`, 1));
      }
    }
    const hiddenSteps = summarizeOverflow(theme, visibleSteps.hiddenCount, "steps");
    if (hiddenSteps) {
      lines.push(...wrapIntoBoxLines(theme, innerWidth, hiddenSteps));
    }
  }

  const blockerItems = [...blockedReasons, ...model.blockers];
  renderCompactList(lines, theme, innerWidth, "Blockers", blockerItems, blockerItems.length > 0 ? theme.fg("warning", `${blockerItems.length} blocker(s)`) : undefined, SECTION_LINE_LIMITS.blocker);
  renderCompactList(lines, theme, innerWidth, "Open questions", model.openQuestions, model.openQuestions.length > 0 ? theme.fg("muted", `${model.openQuestions.length} open`) : undefined, SECTION_LINE_LIMITS.question);

  if (model.toggleHint) {
    lines.push(emptyBoxLine(theme, innerWidth));
    lines.push(...wrapIntoBoxLines(theme, innerWidth, theme.fg("dim", model.toggleHint), 1));
  }

  lines.push(theme.fg("border", "╰") + theme.fg("border", "─".repeat(innerWidth)) + theme.fg("border", "╯"));
  return finalizeSidebarHeight(lines, theme, innerWidth, options.maxLines);
}

export function renderPlanSidebarFallback(model: PlanSidebarViewModel, theme: SidebarTheme, width: number): string[] {
  const completed = model.steps.filter((step) => step.completed).length;
  const warningCount = model.execution?.warnings.length ?? 0;
  const frontier = summarizeFrontier(theme, model);
  const fanIn = summarizeFanIn(theme, model);
  const currentStep = model.steps.find((step) => step.step === model.execution?.activeStep);
  const line1 = `${theme.fg("accent", theme.bold("PLAN"))} ${theme.fg("muted", `${completed}/${model.steps.length}`)} ${theme.fg("dim", "·")} ${modeLabel(theme, model.mode)} ${theme.fg("dim", "·")} ${approvalLabel(theme, model.mode)}`;
  const line2 = frontier
    ? `${theme.fg("muted", "Ready:")} ${frontier}${fanIn ? `${theme.fg("dim", " · ")}${fanIn}` : ""}`
    : `${theme.fg("muted", "Next:")} ${model.nextAction}`;
  const line3 = currentStep
    ? `${theme.fg("muted", "Now:")} ${currentStep.step}. ${currentStep.text}`
    : `${theme.fg("muted", "Next:")} ${model.nextAction}`;
  const statusParts = [
    warningCount > 0 ? theme.fg("warning", `Warnings: ${warningCount}`) : undefined,
    model.subagents.length > 0 ? `${theme.fg("muted", "Agents:")} ${summarizeSubagents(theme, model.subagents)}` : undefined,
  ].filter(Boolean);
  const line4 = statusParts.length > 0 ? statusParts.join(theme.fg("dim", " · ")) : undefined;
  return [line1, line2, line3, line4]
    .filter((line): line is string => Boolean(line))
    .map((line) => truncateToWidth(line, width, "...", true));
}

export function getDockedSidebarLayout(totalWidth: number, model?: PlanSidebarViewModel): DockedSidebarLayout | undefined {
  if (!model) return undefined;
  if (totalWidth < MIN_DOCKED_SIDEBAR_TERM_WIDTH) return undefined;

  const gutterWidth = DOCKED_SIDEBAR_GUTTER_WIDTH;
  const maxSidebarWidth = Math.min(MAX_DOCKED_SIDEBAR_WIDTH, totalWidth - gutterWidth - MIN_DOCKED_EDITOR_WIDTH);
  if (maxSidebarWidth < MIN_DOCKED_SIDEBAR_WIDTH) return undefined;

  const sidebarWidth = Math.min(
    maxSidebarWidth,
    Math.max(MIN_DOCKED_SIDEBAR_WIDTH, Math.round(totalWidth * DOCKED_SIDEBAR_WIDTH_RATIO)),
  );
  const editorWidth = totalWidth - sidebarWidth - gutterWidth;
  if (editorWidth < MIN_DOCKED_EDITOR_WIDTH) return undefined;

  return { editorWidth, sidebarWidth, gutterWidth };
}

export function renderDockedSidebarLayout(
  editorLines: string[],
  model: PlanSidebarViewModel,
  theme: SidebarTheme,
  layout: DockedSidebarLayout,
): string[] {
  const sidebarLines = renderPlanSidebar(model, theme, layout.sidebarWidth);
  const rowCount = Math.max(editorLines.length, sidebarLines.length);
  const gutter = " ".repeat(layout.gutterWidth);
  const lines: string[] = [];

  for (let i = 0; i < rowCount; i += 1) {
    const editorLine = padAnsi(editorLines[i] ?? "", layout.editorWidth);
    const sidebarLine = padAnsi(sidebarLines[i] ?? "", layout.sidebarWidth);
    lines.push(`${editorLine}${gutter}${sidebarLine}`);
  }

  return lines;
}
