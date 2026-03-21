import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import type { PlanMode, PlanStep } from "./utils.js";

export interface SidebarTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
}

export interface PlanSidebarViewModel {
  mode: PlanMode;
  planPath?: string;
  steps: PlanStep[];
  toggleHint?: string;
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "...", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function makeBoxLine(theme: SidebarTheme, innerWidth: number, text = ""): string {
  return theme.fg("border", "│") + padAnsi(text, innerWidth) + theme.fg("border", "│");
}

function modeLabel(theme: SidebarTheme, mode: PlanMode): string {
  if (mode === "executing") return theme.fg("accent", "executing");
  if (mode === "planning") return theme.fg("warning", "planning");
  return theme.fg("muted", "normal");
}

function stepLine(theme: SidebarTheme, step: PlanStep): string {
  const prefix = step.completed ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
  const text = step.completed
    ? theme.fg("muted", theme.strikethrough(`${step.step}. ${step.text}`))
    : theme.fg("text", `${step.step}. ${step.text}`);
  return `${prefix} ${text}`;
}

export function renderPlanSidebar(model: PlanSidebarViewModel, theme: SidebarTheme, width: number): string[] {
  const innerWidth = Math.max(20, width - 2);
  const title = model.mode === "executing"
    ? theme.fg("accent", theme.bold(" Plan Progress "))
    : theme.fg("warning", theme.bold(" Plan Sidebar "));

  const lines: string[] = [
    theme.fg("border", "╭") + padAnsi(title, innerWidth) + theme.fg("border", "╮"),
    makeBoxLine(theme, innerWidth, `${theme.fg("muted", "Mode:")} ${modeLabel(theme, model.mode)}`),
    makeBoxLine(theme, innerWidth, `${theme.fg("muted", "Plan:")} ${theme.fg("dim", model.planPath ?? "No plan file yet")}`),
    makeBoxLine(theme, innerWidth),
  ];

  if (model.steps.length === 0) {
    lines.push(makeBoxLine(theme, innerWidth, theme.fg("dim", "No numbered plan steps detected yet.")));
    lines.push(makeBoxLine(theme, innerWidth, theme.fg("dim", "Write the plan, then approve it with plan_exit.")));
  } else {
    const completed = model.steps.filter((step) => step.completed).length;
    lines.push(
      makeBoxLine(
        theme,
        innerWidth,
        `${theme.fg("muted", "Progress:")} ${theme.fg(model.mode === "executing" ? "accent" : "text", `${completed}/${model.steps.length}`)}`,
      ),
    );
    lines.push(makeBoxLine(theme, innerWidth));
    for (const step of model.steps) {
      lines.push(makeBoxLine(theme, innerWidth, stepLine(theme, step)));
    }
  }

  if (model.toggleHint) {
    lines.push(makeBoxLine(theme, innerWidth));
    lines.push(makeBoxLine(theme, innerWidth, theme.fg("dim", model.toggleHint)));
  }

  lines.push(theme.fg("border", "╰") + theme.fg("border", "─".repeat(innerWidth)) + theme.fg("border", "╯"));
  return lines;
}

export class PlanSidebarComponent implements Component {
  private state: PlanSidebarViewModel = {
    mode: "planning",
    steps: [],
  };

  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly theme: SidebarTheme) {}

  setState(state: PlanSidebarViewModel): void {
    this.state = state;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedWidth = width;
    this.cachedLines = renderPlanSidebar(this.state, this.theme, width);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
