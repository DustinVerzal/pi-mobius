import { Text } from "@mariozechner/pi-tui";
import {
  isTerminalSubagentStatus,
  type SubagentChecklistItem,
  type SubagentProgressRegistry,
  type SubagentProgressSnapshot,
} from "./progress.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_WIDGET_LINES = 12;
const MAX_WIDGET_AGENTS = 4;
const MAX_CHECKLIST_LINES = 3;
const MAX_RESULT_CHECKLIST_LINES = 4;

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

function truncate(text: string, maxLength = 118): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatMs(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTurns(turnCount: unknown, maxTurns: unknown): string | undefined {
  if (typeof turnCount !== "number" || turnCount <= 0) return undefined;
  return typeof maxTurns === "number" && maxTurns > 0 ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checklistLines(snapshot: SubagentProgressSnapshot, fallbackText: string | undefined, theme: Theme, maxLines: number): string[] {
  const completedItems = snapshot.items.filter((item) => item.status === "completed");
  const activeItem = snapshot.items.find((item) => item.status === "active") ?? snapshot.items.at(0);
  const lines: string[] = [];

  const pushLine = (text: string | undefined) => {
    if (!text) return;
    lines.push(text);
  };

  const formatItem = (prefix: string, item: SubagentChecklistItem, color: string) => {
    const suffix = item.detail ? ` ${theme.fg("dim", `(${item.detail})`)}` : "";
    return `${theme.fg(color, prefix)} ${item.label}${suffix}`;
  };

  if (isTerminalSubagentStatus(snapshot.status)) {
    if (snapshot.status === "failed" || snapshot.status === "stopped") {
      pushLine(snapshot.error ? `${theme.fg("warning", "!")} ${snapshot.error}` : undefined);
    }

    if (completedItems.length > 0) {
      for (const item of completedItems.slice(0, maxLines)) {
        pushLine(formatItem("✓", item, "success"));
      }
    } else if (activeItem) {
      pushLine(formatItem(snapshot.status === "completed" || snapshot.status === "steered" ? "✓" : "→", activeItem, snapshot.status === "failed" ? "warning" : "success"));
    }
  } else {
    const nonDuplicateCompleted = completedItems.filter((item) => item.label.toLowerCase() !== snapshot.description.toLowerCase());
    for (const item of nonDuplicateCompleted.slice(0, Math.max(0, maxLines - 1))) {
      pushLine(formatItem("✓", item, "success"));
    }

    if (activeItem && lines.length < maxLines) {
      const duplicateDescription = activeItem.label.toLowerCase() === snapshot.description.toLowerCase();
      if (!duplicateDescription || !fallbackText) {
        pushLine(formatItem("→", activeItem, "accent"));
      }
    }

    if (lines.length === 0) {
      pushLine(fallbackText ? `${theme.fg("dim", "⎿")} ${fallbackText}` : `${theme.fg("dim", "⎿")} thinking…`);
    }
  }

  if (lines.length > maxLines) {
    const hiddenCount = lines.length - maxLines + 1;
    return [...lines.slice(0, maxLines - 1), theme.fg("dim", `… +${hiddenCount} more`)];
  }

  return lines;
}

function sortSnapshots(snapshots: SubagentProgressSnapshot[]): SubagentProgressSnapshot[] {
  const priority = (snapshot: SubagentProgressSnapshot): number => {
    if (snapshot.status === "failed" || snapshot.status === "stopped") return 0;
    if (!isTerminalSubagentStatus(snapshot.status)) return 1;
    return 2;
  };

  return [...snapshots].sort((a, b) => {
    const priorityDiff = priority(a) - priority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt);
  });
}

function visibleSnapshots(registry: SubagentProgressRegistry): SubagentProgressSnapshot[] {
  const snapshots = sortSnapshots(registry.list());
  const active = snapshots.filter((snapshot) => !isTerminalSubagentStatus(snapshot.status));
  const terminal = snapshots
    .filter((snapshot) => isTerminalSubagentStatus(snapshot.status))
    .slice(0, active.length > 0 ? 2 : 3);
  return [...active, ...terminal].slice(0, MAX_WIDGET_AGENTS);
}

function statusIcon(snapshot: SubagentProgressSnapshot, spinnerFrame = 0): string {
  if (snapshot.status === "failed" || snapshot.status === "stopped") return "✗";
  if (snapshot.status === "completed" || snapshot.status === "steered") return "✓";
  if (snapshot.status === "queued") return "◦";
  return SPINNER[spinnerFrame % SPINNER.length] ?? SPINNER[0];
}

function statusColor(snapshot: SubagentProgressSnapshot): string {
  if (snapshot.status === "failed" || snapshot.status === "stopped") return "warning";
  if (snapshot.status === "completed" || snapshot.status === "steered") return "success";
  if (snapshot.status === "queued") return "muted";
  return "accent";
}

function statusLabel(snapshot: SubagentProgressSnapshot): string {
  if (snapshot.status === "background") return "background";
  if (snapshot.status === "steered") return "wrapped up";
  return snapshot.status;
}

function summaryStats(snapshot: SubagentProgressSnapshot): string {
  const parts = [statusLabel(snapshot)];
  if (typeof snapshot.toolUses === "number" && snapshot.toolUses > 0) {
    parts.push(`${snapshot.toolUses} tool use${snapshot.toolUses === 1 ? "" : "s"}`);
  }
  const duration = formatMs(snapshot.durationMs);
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

export function renderSubagentWidget(registry: SubagentProgressRegistry, theme: Theme): string[] {
  const snapshots = visibleSnapshots(registry);
  if (snapshots.length === 0) {
    return [theme.fg("dim", "Agents")];
  }

  const lines: string[] = [theme.fg("accent", "Agents")];
  let remainingBody = MAX_WIDGET_LINES - 1;

  for (const [index, snapshot] of snapshots.entries()) {
    if (remainingBody <= 0) break;
    const isLast = index === snapshots.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childConnector = isLast ? "   " : "│  ";
    const icon = theme.fg(statusColor(snapshot), statusIcon(snapshot, index));
    const header = truncate(
      `${theme.fg("dim", connector)} ${icon} ${theme.bold(snapshot.description)} ${theme.fg("dim", `(${snapshot.type})`)} ${theme.fg("dim", `· ${summaryStats(snapshot)}`)}`,
    );
    lines.push(header);
    remainingBody -= 1;
    if (remainingBody <= 0) break;

    const fallbackText = snapshot.fallbackActivity;
    const checklist = checklistLines(snapshot, fallbackText, theme, Math.min(MAX_CHECKLIST_LINES, remainingBody));
    for (const line of checklist) {
      if (remainingBody <= 0) break;
      lines.push(truncate(`${theme.fg("dim", childConnector)}   ${line}`));
      remainingBody -= 1;
    }
  }

  const hiddenCount = registry.list().length - snapshots.length;
  if (hiddenCount > 0 && remainingBody > 0) {
    lines.push(theme.fg("dim", `└─ +${hiddenCount} more agent${hiddenCount === 1 ? "" : "s"}`));
  }

  return lines.slice(0, MAX_WIDGET_LINES);
}

function statsFromDetails(details: Record<string, unknown>, theme: Theme): string {
  const parts: string[] = [];
  if (isNonEmptyText(details.modelName)) parts.push(details.modelName);
  if (Array.isArray(details.tags)) {
    for (const tag of details.tags) {
      if (isNonEmptyText(tag)) parts.push(tag);
    }
  }
  const turns = formatTurns(details.turnCount, details.maxTurns);
  if (turns) parts.push(turns);
  if (typeof details.toolUses === "number" && details.toolUses > 0) {
    parts.push(`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
  }
  if (isNonEmptyText(details.tokens)) parts.push(details.tokens);
  if (typeof details.durationMs === "number" && details.durationMs > 0) {
    parts.push(formatMs(details.durationMs) ?? "");
  }
  return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function firstTextBlock(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

export function renderAgentResultWithProgress(
  result: { content?: Array<{ type?: string; text?: string }>; details?: unknown },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): Text | undefined {
  const details = result.details as Record<string, unknown> | undefined;
  if (!details) return undefined;

  const progress = details.progress as SubagentProgressSnapshot | undefined;
  const status = typeof details.status === "string" ? details.status : undefined;
  const stats = statsFromDetails(details, theme);
  const spinnerFrame = typeof details.spinnerFrame === "number" ? details.spinnerFrame : 0;
  const icon = status === "error" || status === "aborted" || status === "stopped"
    ? theme.fg("error", "✗")
    : status === "completed" || status === "steered"
      ? theme.fg(status === "steered" ? "warning" : "success", "✓")
      : status === "background"
        ? theme.fg("muted", "◦")
        : theme.fg("accent", SPINNER[spinnerFrame % SPINNER.length] ?? SPINNER[0]);

  let firstLine = icon;
  if (stats) firstLine += ` ${stats}`;
  const lines: string[] = [firstLine];

  if (status === "background") {
    const backgroundLabel = typeof details.agentId === "string" ? `Running in background (ID: ${details.agentId})` : "Running in background";
    lines.push(theme.fg("dim", `  ⎿  ${backgroundLabel}`));
  }

  const fallbackText = isNonEmptyText(details.activity) ? details.activity : undefined;
  if (progress) {
    for (const line of checklistLines(progress, fallbackText, theme, MAX_RESULT_CHECKLIST_LINES)) {
      lines.push(`  ${line}`);
    }
  } else if (fallbackText) {
    lines.push(theme.fg("dim", `  ⎿  ${fallbackText}`));
  } else if (options.isPartial || status === "running") {
    lines.push(theme.fg("dim", "  ⎿  thinking…"));
  }

  if ((status === "completed" || status === "steered") && options.expanded) {
    const output = firstTextBlock(result);
    const visibleLines = output.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 40);
    for (const line of visibleLines) {
      lines.push(theme.fg("dim", `  ${line}`));
    }
    if (output.split(/\r?\n/).filter((line) => line.trim().length > 0).length > visibleLines.length) {
      lines.push(theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)"));
    }
  }

  if ((status === "error" || status === "aborted" || status === "stopped") && isNonEmptyText(details.error)) {
    lines.push(theme.fg("warning", `  ⎿  ${details.error}`));
  }

  return new Text(lines.join("\n"), 0, 0);
}

export function wrapAgentWidgetFactory(
  registry: SubagentProgressRegistry,
  originalFactory: ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined,
): ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined {
  if (!originalFactory) return originalFactory;

  return (tui, theme) => {
    const original = originalFactory(tui, theme);
    return {
      render: () => renderSubagentWidget(registry, theme),
      invalidate: () => original.invalidate(),
    };
  };
}
