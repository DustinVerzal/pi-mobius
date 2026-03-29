export const SUBAGENT_PROGRESS_EVENT = "subagents:progress";

export type SubagentProgressStatus = "queued" | "running" | "background" | "completed" | "failed" | "steered" | "stopped";
export type SubagentChecklistItemStatus = "pending" | "active" | "completed";
export type SubagentChecklistItemSource = "description" | "step_association" | "normalized_result_summary";

export interface SubagentChecklistItem {
  id: string;
  label: string;
  status: SubagentChecklistItemStatus;
  source: SubagentChecklistItemSource;
  detail?: string;
}

export interface SubagentProgressSnapshot {
  id: string;
  type: string;
  description: string;
  status: SubagentProgressStatus;
  isBackground?: boolean;
  startedAt: number;
  completedAt?: number;
  updatedAt: number;
  toolUses?: number;
  durationMs?: number;
  error?: string;
  fallbackActivity?: string;
  stepAssociation?: string;
  normalizedSummary?: string;
  activeItemId?: string;
  items: SubagentChecklistItem[];
}

export interface SubagentProgressUpdate {
  id: string;
  type?: string;
  description?: string;
  status?: SubagentProgressStatus;
  isBackground?: boolean;
  startedAt?: number;
  completedAt?: number;
  toolUses?: number;
  durationMs?: number;
  error?: string;
  fallbackActivity?: string;
  stepAssociation?: string;
  normalizedSummary?: string;
}

const TERMINAL_STATUSES = new Set<SubagentProgressStatus>(["completed", "failed", "steered", "stopped"]);

function cleanText(value: string | undefined, maxLength = 160): string | undefined {
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > maxLength ? `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : collapsed;
}

function checklistStatus(status: SubagentProgressStatus): SubagentChecklistItemStatus {
  if (status === "completed" || status === "steered") return "completed";
  if (status === "queued") return "pending";
  return "active";
}

function dedupeItems(items: SubagentChecklistItem[]): SubagentChecklistItem[] {
  const seen = new Set<string>();
  const deduped: SubagentChecklistItem[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

export function isTerminalSubagentStatus(status: SubagentProgressStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function normalizeSubagentResultSummary(result: string | undefined): string | undefined {
  if (!result) return undefined;
  const firstMeaningfulLine = result
    .split(/\r?\n/)
    .map((line) => cleanText(line, 220))
    .find(Boolean);
  return cleanText(firstMeaningfulLine, 140);
}

export function buildChecklistItems(snapshot: Pick<SubagentProgressSnapshot, "description" | "status" | "normalizedSummary" | "stepAssociation">): SubagentChecklistItem[] {
  const items: SubagentChecklistItem[] = [];
  const description = cleanText(snapshot.description);
  const stepAssociation = cleanText(snapshot.stepAssociation);
  const normalizedSummary = cleanText(snapshot.normalizedSummary, 140);
  const itemStatus = checklistStatus(snapshot.status);

  if (description) {
    items.push({
      id: "description",
      label: description,
      status: itemStatus,
      source: "description",
      detail: stepAssociation,
    });
  } else if (stepAssociation) {
    items.push({
      id: "step-association",
      label: stepAssociation,
      status: itemStatus,
      source: "step_association",
    });
  }

  if (normalizedSummary && normalizedSummary.toLowerCase() !== description?.toLowerCase()) {
    items.push({
      id: "normalized-result-summary",
      label: normalizedSummary,
      status: "completed",
      source: "normalized_result_summary",
    });
  }

  return dedupeItems(items);
}

function buildSignature(snapshot: SubagentProgressSnapshot): string {
  return JSON.stringify({
    id: snapshot.id,
    description: snapshot.description,
    status: snapshot.status,
    isBackground: snapshot.isBackground,
    fallbackActivity: snapshot.fallbackActivity,
    stepAssociation: snapshot.stepAssociation,
    normalizedSummary: snapshot.normalizedSummary,
    error: snapshot.error,
    completedAt: snapshot.completedAt,
    items: snapshot.items.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      source: item.source,
      detail: item.detail,
    })),
    activeItemId: snapshot.activeItemId,
  });
}

function buildSnapshot(existing: SubagentProgressSnapshot | undefined, update: SubagentProgressUpdate): SubagentProgressSnapshot {
  const description = cleanText(update.description, 200) ?? existing?.description ?? update.id;
  const type = update.type ?? existing?.type ?? "general-purpose";
  const status = update.status ?? existing?.status ?? "queued";
  const startedAt = update.startedAt ?? existing?.startedAt ?? Date.now();
  const completedAt = isTerminalSubagentStatus(status)
    ? update.completedAt ?? existing?.completedAt ?? Date.now()
    : undefined;
  const fallbackActivity = isTerminalSubagentStatus(status)
    ? undefined
    : cleanText(update.fallbackActivity, 160) ?? existing?.fallbackActivity;
  const normalizedSummary = cleanText(update.normalizedSummary, 140) ?? existing?.normalizedSummary;
  const stepAssociation = cleanText(update.stepAssociation, 160) ?? existing?.stepAssociation;

  const snapshot: SubagentProgressSnapshot = {
    id: update.id,
    type,
    description,
    status,
    isBackground: update.isBackground ?? existing?.isBackground ?? status === "background",
    startedAt,
    completedAt,
    updatedAt: Date.now(),
    toolUses: update.toolUses ?? existing?.toolUses,
    durationMs: update.durationMs ?? existing?.durationMs,
    error: cleanText(update.error, 160) ?? existing?.error,
    fallbackActivity,
    stepAssociation,
    normalizedSummary,
    items: [],
    activeItemId: undefined,
  };

  snapshot.items = buildChecklistItems(snapshot);
  snapshot.activeItemId = snapshot.items.find((item) => item.status === "active")?.id;
  return snapshot;
}

export class SubagentProgressRegistry {
  private snapshots = new Map<string, SubagentProgressSnapshot>();
  private signatures = new Map<string, string>();

  upsert(update: SubagentProgressUpdate): { snapshot: SubagentProgressSnapshot; changed: boolean } {
    const existing = this.snapshots.get(update.id);
    const snapshot = buildSnapshot(existing, update);
    const signature = buildSignature(snapshot);
    const changed = this.signatures.get(update.id) !== signature;
    this.snapshots.set(update.id, snapshot);
    this.signatures.set(update.id, signature);
    return { snapshot, changed };
  }

  get(id: string): SubagentProgressSnapshot | undefined {
    return this.snapshots.get(id);
  }

  list(): SubagentProgressSnapshot[] {
    return [...this.snapshots.values()];
  }

  matchActiveAgent(type: string | undefined, description: string | undefined): SubagentProgressSnapshot | undefined {
    const normalizedType = type?.trim().toLowerCase();
    const normalizedDescription = cleanText(description, 200)?.toLowerCase();
    const candidates = [...this.snapshots.values()]
      .filter((snapshot) => !isTerminalSubagentStatus(snapshot.status))
      .sort((a, b) => b.startedAt - a.startedAt);
    return candidates.find((snapshot) => {
      if (normalizedType && snapshot.type.trim().toLowerCase() !== normalizedType) return false;
      if (normalizedDescription && snapshot.description.trim().toLowerCase() !== normalizedDescription) return false;
      return true;
    });
  }
}
