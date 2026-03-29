import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type ContextUsageSnapshot = {
  percent: number | null;
  contextWindow: number;
};

type FooterRenderInput = {
  cwd: string;
  branch: string | null | undefined;
  statuses: Map<string, string>;
  modelId: string;
  provider?: string;
  thinkingLevel: ThinkingLevel;
  usage: UsageTotals;
  contextUsage?: ContextUsageSnapshot;
};

const PLAN_STATUS_KEY = "opencode-plan";
const POWERLINE_GLYPHS = /[]/g;

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function normalizeCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export function shortenPath(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;

  const homePrefixed = value.startsWith("~/");
  const absolute = !homePrefixed && value.startsWith("/");
  const parts = value.split("/").filter(Boolean);

  if (parts.length <= 1) return truncateToWidth(value, width, "...");

  let suffix = parts.pop() ?? "";
  while (parts.length > 0) {
    const next = parts.pop() ?? "";
    const candidate = `${next}/${suffix}`;
    const prefix = homePrefixed ? "~/.../" : absolute ? "/.../" : ".../";
    if (visibleWidth(prefix + candidate) > width) break;
    suffix = candidate;
  }

  const shortened = `${homePrefixed ? "~/.../" : absolute ? "/.../" : ".../"}${suffix}`;
  return visibleWidth(shortened) <= width ? shortened : truncateToWidth(value, width, "...");
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function collectUsageTotals(ctx: ExtensionContext): UsageTotals {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const message = entry.message as AssistantMessage;
    input += message.usage.input;
    output += message.usage.output;
    cacheRead += message.usage.cacheRead;
    cacheWrite += message.usage.cacheWrite;
    cost += message.usage.cost.total;
  }

  return { input, output, cacheRead, cacheWrite, cost };
}

function thinkingColor(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    default:
      return "accent";
  }
}

function formatUsageLabel(usage: UsageTotals): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
  return parts.length > 0 ? `usage ${parts.join(" ")}` : "usage idle";
}

function buildContextDisplay(contextUsage?: ContextUsageSnapshot): { plain: string; color: string } {
  if (!contextUsage || !contextUsage.contextWindow) {
    return { plain: "ctx unavailable", color: "dim" };
  }

  if (contextUsage.percent == null) {
    return { plain: `ctx ?/${formatTokens(contextUsage.contextWindow)}`, color: "dim" };
  }

  if (contextUsage.percent > 90) {
    return { plain: `ctx ${contextUsage.percent.toFixed(1)}%/${formatTokens(contextUsage.contextWindow)}`, color: "error" };
  }

  if (contextUsage.percent > 70) {
    return { plain: `ctx ${contextUsage.percent.toFixed(1)}%/${formatTokens(contextUsage.contextWindow)}`, color: "warning" };
  }

  return { plain: `ctx ${contextUsage.percent.toFixed(1)}%/${formatTokens(contextUsage.contextWindow)}`, color: "dim" };
}

function buildRuntimeLine(theme: { fg: (color: string, text: string) => string }, width: number, input: FooterRenderInput): string {
  const usageLabel = formatUsageLabel(input.usage);
  const contextLabel = buildContextDisplay(input.contextUsage);
  let left = `${theme.fg("dim", usageLabel)}${theme.fg("dim", " · ")}${theme.fg(contextLabel.color, contextLabel.plain)}`;

  const modelLabel = input.provider ? `${input.provider}:${input.modelId}` : input.modelId;
  const right = `${theme.fg("muted", modelLabel)}${theme.fg("dim", " · thinking ")}${theme.fg(thinkingColor(input.thinkingLevel), input.thinkingLevel)}`;

  let leftWidth = visibleWidth(left);
  if (leftWidth > width) {
    left = truncateToWidth(left, width, theme.fg("dim", "..."));
    leftWidth = visibleWidth(left);
  }

  const minPadding = 2;
  const rightWidth = visibleWidth(right);
  const totalNeeded = leftWidth + minPadding + rightWidth;

  if (totalNeeded <= width) {
    const padding = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
    return left + padding + right;
  }

  const availableForRight = width - leftWidth - minPadding;
  if (availableForRight <= 0) return left;

  const truncatedRight = truncateToWidth(right, availableForRight, theme.fg("dim", "..."));
  const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)));
  return left + padding + truncatedRight;
}

export function orderStatuses(statuses: Map<string, string>): Array<[string, string]> {
  return Array.from(statuses.entries()).sort(([a], [b]) => {
    if (a === PLAN_STATUS_KEY && b !== PLAN_STATUS_KEY) return -1;
    if (a !== PLAN_STATUS_KEY && b === PLAN_STATUS_KEY) return 1;
    return a.localeCompare(b);
  });
}

function buildStatusLine(theme: { fg: (color: string, text: string) => string }, width: number, statuses: Map<string, string>): string | undefined {
  if (statuses.size === 0) return undefined;

  const rendered = orderStatuses(statuses)
    .map(([, text]) => sanitizeStatusText(text).replace(POWERLINE_GLYPHS, ""))
    .filter(Boolean);

  if (rendered.length === 0) return undefined;

  const separator = theme.fg("dim", " · ");
  return truncateToWidth(rendered.join(separator), width, theme.fg("dim", "..."));
}

export function renderContextFooterLines(
  theme: { fg: (color: string, text: string) => string },
  width: number,
  input: FooterRenderInput,
): string[] {
  const normalizedCwd = normalizeCwd(input.cwd);
  const branchLabel = input.branch ? `git ${input.branch}` : "";
  const branchWidth = branchLabel ? visibleWidth(branchLabel) + visibleWidth(" · ") : 0;
  const pathBudget = branchLabel ? Math.max(8, width - branchWidth) : width;
  const pathText = shortenPath(normalizedCwd, pathBudget);

  const rawPathLine = branchLabel
    ? `${theme.fg("text", pathText)}${theme.fg("dim", " · git ")}${theme.fg("accent", input.branch ?? "")}`
    : theme.fg("text", pathText);

  const pathLine = truncateToWidth(rawPathLine, width, theme.fg("dim", "..."));
  const runtimeLine = buildRuntimeLine(theme, width, input);
  const statusLine = buildStatusLine(theme, width, input.statuses);
  return statusLine ? [pathLine, runtimeLine, statusLine] : [pathLine, runtimeLine];
}

export function installContextFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, theme, footerData) => {
    const disposeBranchWatcher = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose() {
        disposeBranchWatcher();
      },
      invalidate() {},
      render(width: number): string[] {
        const contextUsage = ctx.getContextUsage();

        return renderContextFooterLines(theme, width, {
          cwd: ctx.cwd,
          branch: footerData.getGitBranch(),
          statuses: footerData.getExtensionStatuses(),
          modelId: ctx.model?.id || "no-model",
          provider: ctx.model?.provider,
          thinkingLevel: pi.getThinkingLevel() || "off",
          usage: collectUsageTotals(ctx),
          contextUsage: contextUsage
            ? {
                percent: contextUsage.percent ?? null,
                contextWindow: contextUsage.contextWindow ?? 0,
              }
            : undefined,
        });
      },
    };
  });
}

export default function opencodeContextFooter(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    installContextFooter(pi, ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    installContextFooter(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter(undefined);
  });
}
