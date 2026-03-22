import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type Component, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import {
  getDockedSidebarLayout,
  renderPlanSidebar,
  renderPlanSidebarFallback,
  type PlanSidebarViewModel,
  type SidebarTheme,
} from "./sidebar.js";

const RAIL_MAX_HEIGHT_RATIO = 0.72;
const RAIL_MAX_LINES = 26;
const RAIL_MIN_LINES = 14;

function getRailMaxLines(rows: number): number {
  const available = Math.max(8, rows - 4);
  const preferred = Math.min(RAIL_MAX_LINES, Math.max(8, Math.floor(rows * RAIL_MAX_HEIGHT_RATIO)));
  return Math.max(Math.min(RAIL_MIN_LINES, available), Math.min(preferred, available));
}

class WorkflowRailOverlay implements Component {
  private model: PlanSidebarViewModel | undefined;

  constructor(private readonly tui: TUI, private readonly theme: SidebarTheme) {}

  setModel(model: PlanSidebarViewModel | undefined): void {
    this.model = model;
  }

  render(width: number): string[] {
    if (!this.model) return [];
    return renderPlanSidebar(this.model, this.theme, width, { maxLines: getRailMaxLines(this.tui.terminal.rows) });
  }
}

export class DockedPlanModeEditor extends CustomEditor {
  private sidebarState: PlanSidebarViewModel | undefined;
  private readonly railOverlay: WorkflowRailOverlay;
  private railHandle: OverlayHandle | undefined;
  private railWidth: number | undefined;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly sidebarTheme: SidebarTheme,
    private readonly onEmptyTab: () => void,
  ) {
    super(tui, theme, keybindings);
    this.railOverlay = new WorkflowRailOverlay(tui, sidebarTheme);
  }

  private syncRail(width?: number): void {
    const layout = typeof width === "number" ? getDockedSidebarLayout(width, this.sidebarState) : undefined;
    this.railOverlay.setModel(this.sidebarState);

    if (!this.sidebarState || !layout) {
      this.railHandle?.setHidden(true);
      return;
    }

    if (!this.railHandle || this.railWidth !== layout.sidebarWidth) {
      this.railHandle?.hide();
      this.railHandle = this.tui.showOverlay(this.railOverlay, {
        anchor: "right-center",
        width: layout.sidebarWidth,
        maxHeight: `${Math.round(RAIL_MAX_HEIGHT_RATIO * 100)}%`,
        margin: { top: 1, right: 1, bottom: 2 },
        nonCapturing: true,
        visible: (termWidth) => Boolean(this.sidebarState && getDockedSidebarLayout(termWidth, this.sidebarState)),
      });
      this.railWidth = layout.sidebarWidth;
    }

    this.railHandle.setHidden(false);
  }

  setSidebarState(state: PlanSidebarViewModel | undefined): void {
    this.sidebarState = state;
    this.syncRail();
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.syncRail(width);
    const editorLines = super.render(width);
    const layout = getDockedSidebarLayout(width, this.sidebarState);
    if (layout) {
      return editorLines;
    }

    if (!this.sidebarState) {
      return editorLines;
    }

    const fallback = renderPlanSidebarFallback(this.sidebarState, this.sidebarTheme, width);
    return [...editorLines, "", ...fallback];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) && this.getText().trim().length === 0) {
      this.onEmptyTab();
      return;
    }
    super.handleInput(data);
  }

  dispose(): void {
    this.railHandle?.hide();
    this.railHandle = undefined;
    this.railWidth = undefined;
  }
}
