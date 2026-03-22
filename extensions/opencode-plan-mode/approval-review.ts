import type { ExtensionContext, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@mariozechner/pi-tui";

interface ApprovalReviewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ApprovalReviewConfig {
  title: string;
  summary: string;
  options: string[];
}

interface ApprovalReviewState {
  selectedIndex?: number;
  scrollOffset?: number;
}

interface ApprovalReviewLayout {
  width: number;
  maxHeight: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

const MIN_OVERLAY_WIDTH = 72;
const MAX_OVERLAY_WIDTH = 108;
const MIN_OVERLAY_HEIGHT = 18;
const MAX_OVERLAY_HEIGHT = 34;
const OVERLAY_HEIGHT_RATIO = 0.78;
const OVERLAY_MARGIN = { top: 1, right: 2, bottom: 2, left: 2 };
const MIN_BODY_HEIGHT = 6;

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "...", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function getApprovalReviewLayout(termWidth: number, termHeight: number): ApprovalReviewLayout {
  const availableWidth = Math.max(36, termWidth - OVERLAY_MARGIN.left - OVERLAY_MARGIN.right);
  const preferredWidth = Math.max(MIN_OVERLAY_WIDTH, Math.min(MAX_OVERLAY_WIDTH, availableWidth));
  const width = Math.max(36, Math.min(availableWidth, preferredWidth));
  const availableHeight = Math.max(10, termHeight - OVERLAY_MARGIN.top - OVERLAY_MARGIN.bottom);
  const preferredHeight = Math.max(MIN_OVERLAY_HEIGHT, Math.min(MAX_OVERLAY_HEIGHT, Math.floor(termHeight * OVERLAY_HEIGHT_RATIO)));
  const maxHeight = Math.max(10, Math.min(availableHeight, preferredHeight));

  return {
    width,
    maxHeight,
    margin: OVERLAY_MARGIN,
  };
}

function wrapSummary(summary: string, innerWidth: number): string[] {
  const wrapped: string[] = [];
  for (const line of summary.split(/\r?\n/)) {
    if (line.length === 0) {
      wrapped.push("");
      continue;
    }
    const lines = wrapTextWithAnsi(line, innerWidth, { trim: false });
    wrapped.push(...(lines.length > 0 ? lines : [""]));
  }
  return wrapped;
}

function renderButton(theme: ApprovalReviewTheme, label: string, selected: boolean): string {
  return selected
    ? theme.bold(theme.fg("accent", `[ ${label} ]`))
    : theme.fg("muted", `[ ${label} ]`);
}

function wrapActionLines(theme: ApprovalReviewTheme, innerWidth: number, options: string[], selectedIndex: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (let i = 0; i < options.length; i += 1) {
    const button = renderButton(theme, options[i], i === selectedIndex);
    const candidate = current.length === 0 ? button : `${current} ${button}`;
    if (visibleWidth(candidate) > innerWidth && current.length > 0) {
      lines.push(current);
      current = button;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

class ApprovalReviewComponent implements Component {
  private selectedIndex = 0;
  private scrollOffset = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: ApprovalReviewTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly title: string,
    private readonly summary: string,
    private readonly options: string[],
    private readonly onDone: (result: string | undefined) => void,
    initialState: ApprovalReviewState = {},
  ) {
    this.selectedIndex = Math.max(0, Math.min(initialState.selectedIndex ?? 0, Math.max(0, options.length - 1)));
    this.scrollOffset = Math.max(0, initialState.scrollOffset ?? 0);
  }

  private getRenderState(width: number): {
    innerWidth: number;
    bodyHeight: number;
    actionLines: string[];
    wrappedSummary: string[];
  } {
    const layout = getApprovalReviewLayout(this.tui.terminal.columns, this.tui.terminal.rows);
    const innerWidth = Math.max(24, width - 2);
    const actionLines = wrapActionLines(this.theme, innerWidth, this.options, this.selectedIndex);
    const chromeLines = 8 + actionLines.length;
    const bodyHeight = Math.max(MIN_BODY_HEIGHT, layout.maxHeight - chromeLines);
    const wrappedSummary = wrapSummary(this.summary, innerWidth);
    return { innerWidth, bodyHeight, actionLines, wrappedSummary };
  }

  private clampScroll(width: number): { maxOffset: number; wrappedSummary: string[]; bodyHeight: number } {
    const { wrappedSummary, bodyHeight } = this.getRenderState(width);
    const maxOffset = Math.max(0, wrappedSummary.length - bodyHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    return { maxOffset, wrappedSummary, bodyHeight };
  }

  private moveScroll(delta: number, width: number): void {
    this.scrollOffset += delta;
    this.clampScroll(width);
  }

  private pageSize(width: number): number {
    return Math.max(1, this.getRenderState(width).bodyHeight - 1);
  }

  render(width: number): string[] {
    const { innerWidth, actionLines } = this.getRenderState(width);
    const { maxOffset, wrappedSummary, bodyHeight } = this.clampScroll(width);
    const start = this.scrollOffset;
    const end = Math.min(wrappedSummary.length, start + bodyHeight);
    const visibleSummary = wrappedSummary.slice(start, end);
    const topOverflow = start > 0
      ? this.theme.fg("dim", `↑ ${start} line${start === 1 ? "" : "s"} above`)
      : this.theme.fg("dim", "Top of summary");
    const bottomOverflowCount = Math.max(0, wrappedSummary.length - end);
    const bottomOverflow = bottomOverflowCount > 0
      ? this.theme.fg("dim", `↓ ${bottomOverflowCount} more line${bottomOverflowCount === 1 ? "" : "s"}`)
      : this.theme.fg("dim", "End of summary");
    const position = this.theme.fg("muted", `${Math.min(wrappedSummary.length, start + 1)}-${end}/${Math.max(1, wrappedSummary.length)}`);

    const lines: string[] = [
      this.theme.fg("border", "╭") + padAnsi(this.theme.bold(this.theme.fg("warning", ` ${this.title} `)), innerWidth) + this.theme.fg("border", "╮"),
      this.theme.fg("border", "│") + padAnsi(this.theme.fg("muted", "Scrollable review keeps the transcript readable while exposing the full plan."), innerWidth) + this.theme.fg("border", "│"),
      this.theme.fg("border", "│") + padAnsi(`${topOverflow}${this.theme.fg("dim", " · ")}${position}`, innerWidth) + this.theme.fg("border", "│"),
      this.theme.fg("border", "├") + this.theme.fg("border", "─".repeat(innerWidth)) + this.theme.fg("border", "┤"),
    ];

    for (let i = 0; i < bodyHeight; i += 1) {
      lines.push(this.theme.fg("border", "│") + padAnsi(visibleSummary[i] ?? "", innerWidth) + this.theme.fg("border", "│"));
    }

    lines.push(this.theme.fg("border", "├") + this.theme.fg("border", "─".repeat(innerWidth)) + this.theme.fg("border", "┤"));
    for (const actionLine of actionLines) {
      lines.push(this.theme.fg("border", "│") + padAnsi(actionLine, innerWidth) + this.theme.fg("border", "│"));
    }
    lines.push(this.theme.fg("border", "│") + padAnsi(bottomOverflow, innerWidth) + this.theme.fg("border", "│"));
    lines.push(
      this.theme.fg("border", "│") + padAnsi(
        this.theme.fg("dim", "↑↓/j/k scroll  PgUp/PgDn jump  Tab/←→ choose  Enter confirm  Esc cancel"),
        innerWidth,
      ) + this.theme.fg("border", "│"),
    );
    lines.push(this.theme.fg("border", "╰") + this.theme.fg("border", "─".repeat(innerWidth)) + this.theme.fg("border", "╯"));

    if (maxOffset === 0) this.scrollOffset = 0;
    return lines;
  }

  handleInput(data: string): void {
    const width = getApprovalReviewLayout(this.tui.terminal.columns, this.tui.terminal.rows).width;

    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
      this.onDone(undefined);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.onDone(this.options[this.selectedIndex]);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.moveScroll(-1, width);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.moveScroll(1, width);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
      this.moveScroll(-this.pageSize(width), width);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
      this.moveScroll(this.pageSize(width), width);
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.clampScroll(width);
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || data === "l") {
      this.selectedIndex = (this.selectedIndex + 1) % this.options.length;
      return;
    }

    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || data === "h") {
      this.selectedIndex = (this.selectedIndex - 1 + this.options.length) % this.options.length;
    }
  }
}

export function renderApprovalReviewSnapshot(
  config: ApprovalReviewConfig & {
    width: number;
    rows: number;
    theme: ApprovalReviewTheme;
    selectedIndex?: number;
    scrollOffset?: number;
  },
): string[] {
  const fakeTui = { terminal: { columns: config.width, rows: config.rows } } as TUI;
  const fakeKeybindings = { matches: () => false } as KeybindingsManager;
  const component = new ApprovalReviewComponent(
    fakeTui,
    config.theme,
    fakeKeybindings,
    config.title,
    config.summary,
    config.options,
    () => {},
    { selectedIndex: config.selectedIndex, scrollOffset: config.scrollOffset },
  );
  const layout = getApprovalReviewLayout(config.width, config.rows);
  return component.render(layout.width);
}

export async function showApprovalReview(ctx: ExtensionContext, config: ApprovalReviewConfig): Promise<string | undefined> {
  let overlayTui: TUI | undefined;

  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => {
      overlayTui = tui;
      return new ApprovalReviewComponent(tui, theme, keybindings, config.title, config.summary, config.options, done);
    },
    {
      overlay: true,
      overlayOptions: () => {
        const layout = getApprovalReviewLayout(overlayTui?.terminal.columns ?? 120, overlayTui?.terminal.rows ?? 40);
        return {
          anchor: "center" as const,
          width: layout.width,
          maxHeight: layout.maxHeight,
          margin: layout.margin,
        };
      },
    },
  );
}
