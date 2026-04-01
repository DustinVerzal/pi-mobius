import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type Component, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import {
  getPlanWorkflowPresentation,
  renderPlanSidebar,
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

function getSidebarStateSignature(state: PlanSidebarViewModel | undefined): string {
  return JSON.stringify(state ?? null);
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
  private sidebarStateSignature = getSidebarStateSignature(undefined);
  private readonly railOverlay: WorkflowRailOverlay;
  private railHandle: OverlayHandle | undefined;
  private railWidth: number | undefined;
  private lastRenderWidth: number | undefined;

  private presentationKey: string | undefined;
  private disposed = false;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    sidebarTheme: SidebarTheme,
    private readonly onEmptyTab: () => void,
    private readonly onPresentationChange?: () => void,
  ) {
    super(tui, theme, keybindings);
    this.railOverlay = new WorkflowRailOverlay(tui, sidebarTheme);
    this.lastRenderWidth = tui.terminal.columns;
  }

  private getPresentationKey(width = this.lastRenderWidth, state = this.sidebarState): string {
    const presentation = getPlanWorkflowPresentation(width, state);
    if (presentation.mode === "docked") return `docked:${presentation.layout.sidebarWidth}`;
    if (presentation.mode === "compact") return `compact:${presentation.width}`;
    return presentation.mode;
  }

  private updatePresentationKey(): boolean {
    const nextKey = this.getPresentationKey();
    if (nextKey === this.presentationKey) return false;
    this.presentationKey = nextKey;
    return true;
  }

  private syncRail(width?: number): boolean {
    const resolvedWidth = typeof width === "number" ? width : this.lastRenderWidth;
    const presentation = getPlanWorkflowPresentation(resolvedWidth, this.sidebarState);
    this.railOverlay.setModel(this.sidebarState);

    if (presentation.mode !== "docked") {
      if (presentation.mode !== "pending" && this.railHandle && !this.railHandle.isHidden()) {
        this.railHandle.setHidden(true);
        return true;
      }
      return false;
    }

    let changed = false;
    if (!this.railHandle || this.railWidth !== presentation.layout.sidebarWidth) {
      this.railHandle?.hide();
      this.railHandle = this.tui.showOverlay(this.railOverlay, {
        anchor: "right-center",
        width: presentation.layout.sidebarWidth,
        maxHeight: `${Math.round(RAIL_MAX_HEIGHT_RATIO * 100)}%`,
        margin: { top: 1, right: 1, bottom: 2 },
        nonCapturing: true,
        visible: (termWidth) => getPlanWorkflowPresentation(termWidth, this.sidebarState).mode === "docked",
      });
      this.railWidth = presentation.layout.sidebarWidth;
      changed = true;
    }

    if (this.railHandle.isHidden()) {
      this.railHandle.setHidden(false);
      changed = true;
    }

    return changed;
  }

  setSidebarState(state: PlanSidebarViewModel | undefined): void {
    if (this.disposed) return;
    const nextSignature = getSidebarStateSignature(state);
    if (nextSignature === this.sidebarStateSignature) return;

    this.sidebarState = state;
    this.sidebarStateSignature = nextSignature;
    const railChanged = this.syncRail();
    if (this.updatePresentationKey()) {
      this.onPresentationChange?.();
    }
    if (!railChanged && this.getWorkflowPresentation().mode === "docked") {
      this.tui.requestRender();
    }
  }

  getWorkflowPresentation(
    state = this.sidebarState,
    options?: Parameters<typeof getPlanWorkflowPresentation>[2],
  ): ReturnType<typeof getPlanWorkflowPresentation> {
    return getPlanWorkflowPresentation(this.lastRenderWidth, state, options);
  }

  getLastRenderWidth(): number | undefined {
    return this.lastRenderWidth;
  }

  render(width: number): string[] {
    if (this.lastRenderWidth !== width) {
      this.lastRenderWidth = width;
      this.syncRail(width);
      if (this.updatePresentationKey()) {
        queueMicrotask(() => {
          if (!this.disposed) {
            this.onPresentationChange?.();
          }
        });
      }
    }
    return super.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) && this.getText().trim().length === 0) {
      this.onEmptyTab();
      return;
    }
    super.handleInput(data);
  }

  dispose(): void {
    this.disposed = true;
    this.railHandle?.hide();
    this.railHandle = undefined;
    this.railWidth = undefined;
    this.lastRenderWidth = undefined;
    this.presentationKey = undefined;
    this.sidebarState = undefined;
    this.sidebarStateSignature = getSidebarStateSignature(undefined);
  }
}
