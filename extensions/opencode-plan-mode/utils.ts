import { access } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { SubagentChecklistItem } from "../subagents-bridge/progress.js";

export type PlanMode = "normal" | "planning" | "approval_pending" | "approved_waiting_execution" | "executing";
export type PlanStepStatus = "pending" | "blocked" | "in_progress" | "completed";
export type ProgressSource = "done_marker" | "natural_language" | "tool";
export type SubagentStatus = "queued" | "running" | "background" | "completed" | "failed" | "steered" | "stopped";
export type PlanReviewGate = "pause_after" | "rereview_after";

export interface PlanStep {
  step: number;
  text: string;
  agent?: string;
  batch?: number;
  dependsOn: number[];
  scope: string[];
  verification?: string;
  rationale?: string;
  blockers?: string[];
  checkpoint: string[];
  reviewGate?: string;
  reviewReason?: string;
  status: PlanStepStatus;
  completed: boolean;
  note?: string;
}

export interface PlanValidation {
  errors: string[];
  blocking: string[];
  warnings: string[];
}

export interface PlanBlockedStep {
  step: number;
  waitingOn: number[];
  reason: string;
}

export interface PlanExecutionHandoff {
  goal?: string;
  constraints: string[];
  successCriteria: string[];
  blockers: string[];
  files: string[];
  scopeAnchors: string[];
  verification: string[];
  executionPolicy: string[];
  pauseConditions: string[];
  checkpointContract: string[];
  remainingSteps: number[];
  readySteps: number[];
  frontierBatch?: number;
  delegationGuidance: string[];
}

export interface PlanArtifact {
  goal?: string;
  context: string[];
  successCriteria: string[];
  executionPolicy: string[];
  rereviewTriggers: string[];
  blockers: string[];
  openQuestions: string[];
  files: string[];
  verification: string[];
  steps: PlanStep[];
  validation: PlanValidation;
  signature: string;
  handoff: PlanExecutionHandoff;
}

export interface PlanApprovalState {
  pendingSince?: string;
  approvedAt?: string;
  approvedSignature?: string;
  summary?: string;
  validation: PlanValidation;
  handoff?: PlanExecutionHandoff;
}

export interface PlanDelegationObservation {
  status: "allowed" | "blocked";
  reason: string;
  stepNumbers: number[];
  requestedAgent?: string;
  recordedAt: string;
}

export interface PlanExecutionState {
  completedSteps: number[];
  activeStep?: number;
  readySteps: number[];
  frontierStepNumbers: number[];
  frontierBatch?: number;
  blockedSteps: PlanBlockedStep[];
  checkpoints: PlanStepCheckpoint[];
  warnings: string[];
  lastProgressAt?: string;
  lastProgressSource?: ProgressSource;
  planChangedSinceApproval?: boolean;
  requiresReapproval?: boolean;
  lastDelegation?: PlanDelegationObservation;
}

export interface PlanSubagentActivity {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  isBackground?: boolean;
  startedAt: number;
  completedAt?: number;
  toolUses?: number;
  durationMs?: number;
  error?: string;
  stepNumbers?: number[];
  stepAssociation?: string;
  normalizedSummary?: string;
  progressItems?: SubagentChecklistItem[];
  activeProgressItemId?: string;
  fallbackActivity?: string;
}

export interface PlanState {
  mode: PlanMode;
  planPath?: string;
  previousActiveTools?: string[];
  panelVisible: boolean;
  artifact?: PlanArtifact;
  approval?: PlanApprovalState;
  execution?: PlanExecutionState;
  subagents: PlanSubagentActivity[];
}

export interface PlanDrift {
  changed: boolean;
  requiresReapproval: boolean;
  reasons: string[];
}

export interface PlanCheckpointSummary {
  outcome?: string;
  files: string[];
  verification: string[];
  blockers: string[];
  unblockStatus?: string;
  missing: string[];
}

export interface PlanStepCheckpoint extends PlanCheckpointSummary {
  step: number;
  source: "assistant" | "tool" | "subagent";
  status: "complete" | "partial";
  rawSummary: string;
  recordedAt: string;
}

export interface PlanSubagentPolicy {
  preferredAgent: string;
  runInBackground: boolean;
  joinMode?: "smart" | "group" | "async";
  isolation?: "worktree";
  resultContract: string[];
}

const SAFE_READONLY_PATTERNS = [
  /^\s*cat\b/i,
  /^\s*head\b/i,
  /^\s*tail\b/i,
  /^\s*less\b/i,
  /^\s*more\b/i,
  /^\s*grep\b/i,
  /^\s*find\b/i,
  /^\s*ls\b/i,
  /^\s*pwd\b/i,
  /^\s*echo\b/i,
  /^\s*printf\b/i,
  /^\s*wc\b/i,
  /^\s*sort\b/i,
  /^\s*uniq\b/i,
  /^\s*diff\b/i,
  /^\s*file\b/i,
  /^\s*stat\b/i,
  /^\s*du\b/i,
  /^\s*df\b/i,
  /^\s*tree\b/i,
  /^\s*which\b/i,
  /^\s*whereis\b/i,
  /^\s*type\b/i,
  /^\s*env\b/i,
  /^\s*printenv\b/i,
  /^\s*uname\b/i,
  /^\s*whoami\b/i,
  /^\s*id\b/i,
  /^\s*date\b/i,
  /^\s*uptime\b/i,
  /^\s*ps\b/i,
  /^\s*top\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version\b/i,
  /^\s*python\s+--version\b/i,
  /^\s*python3\s+--version\b/i,
  /^\s*curl\b/i,
  /^\s*wget\s+-O\s*-\b/i,
  /^\s*jq\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/i,
  /^\s*rg\b/i,
  /^\s*fd\b/i,
  /^\s*bat\b/i,
  /^\s*exa\b/i,
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
  /\byarn\s+(add|remove|install|publish)\b/i,
  /\bpnpm\s+(add|remove|install|publish)\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
  /\bbrew\s+(install|uninstall|upgrade)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\bservice\s+\S+\s+(start|stop|restart)\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const VAGUE_STEP_PATTERNS = [
  /\b(?:do the thing|handle it|misc|various|stuff|something|everything|all the things)\b/i,
  /\b(?:investigate|look into|review|check)\b(?:\s+(?:it|things|code|repo))?\.?$/i,
  /\b(?:update|improve|fix|refactor|clean up)\b\s*(?:things|code|workflow|system)?\.?$/i,
  /\b(?:finalize|complete|wrap up)\b\s*(?:implementation|work)?\.?$/i,
];

const VERIFICATION_HINT_PATTERN = /\b(?:test|verify|validation|validated?|assert|check|exercise|confirm|proof|qa|regression|smoke)\b/i;
const MAIN_AGENT_PATTERN = /\bmain\s+session\b/i;
const PLAN_REVIEW_GATES = new Set<PlanReviewGate>(["pause_after", "rereview_after"]);
const DEFAULT_CHECKPOINT_CONTRACT = [
  "Outcome: what changed for this step.",
  "Files: the touched files, directories, or approved scope anchors.",
  "Verification: the tests, checks, or manual proof used.",
  "Blockers/Risks: what remains risky, blocked, or unresolved.",
  "Unblock status: whether downstream work is now unblocked.",
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNumberList(text: string): number[] {
  return [...new Set((text.match(/\d+/g) ?? []).map((value) => Number(value)).filter((value) => Number.isFinite(value)))];
}

function parseTextList(text: string | undefined): string[] {
  if (!text) return [];
  if (/^none(?:\s+right\s+now)?$/i.test(text.trim())) return [];
  return uniqueNames(text
    .split(/\s*(?:,|;|\|)\s*/)
    .map((item) => item.trim())
    .filter(Boolean));
}

function parseReviewGate(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized || undefined;
}

function normalizeScopeAnchor(text: string): string {
  return text.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function isScopeAnchored(scope: string, fileAnchors: string[]): boolean {
  const normalizedScope = normalizeScopeAnchor(scope);
  if (!normalizedScope) return false;
  return fileAnchors
    .map(normalizeScopeAnchor)
    .filter(Boolean)
    .some((anchor) => anchor === "." || normalizedScope === anchor || normalizedScope.startsWith(`${anchor}/`));
}

function extractLabeledValue(text: string, labels: string[], stopLabels: string[]): string | undefined {
  const labelPattern = labels.map(escapeRegex).join("|");
  const stopPattern = stopLabels.map(escapeRegex).join("|");
  const regex = new RegExp(`(?:^|\\b)(?:${labelPattern})\\s*:\\s*([\\s\\S]*?)(?=(?:\\b(?:${stopPattern})\\s*:)|$)`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim();
}

function parseSummaryList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^[\-•]\s*/gm, "")
    .split(/\s*(?:,|;|\|)\s*/)
    .map((item) => item.trim().replace(/[.]+$/, ""))
    .filter(Boolean)
    .filter((item) => !/^none(?:\s+right\s+now)?[.!]?$/i.test(item));
}

export function normalizeCheckpointSummary(text: string): PlanCheckpointSummary {
  const labels = {
    outcome: ["Outcome", "Result"],
    files: ["Files", "File", "Paths", "Path", "Touched files", "Touched paths"],
    verification: ["Verification", "Tests", "Checks", "Proof"],
    blockers: ["Blockers", "Blocker", "Risks", "Risk", "Issues", "Issue", "Follow-ups", "Follow-up"],
    unblockStatus: ["Unblock status", "Unblocked", "Downstream status", "Next frontier"],
  } as const;
  const allLabels = Object.values(labels).flat();
  const outcome = extractLabeledValue(text, labels.outcome, allLabels)
    ?? (!text.includes(":") && text.trim() ? text.trim() : undefined);
  const files = parseSummaryList(extractLabeledValue(text, labels.files, allLabels));
  const verification = parseSummaryList(extractLabeledValue(text, labels.verification, allLabels));
  const blockers = parseSummaryList(extractLabeledValue(text, labels.blockers, allLabels));
  const unblockStatus = extractLabeledValue(text, labels.unblockStatus, allLabels);
  const missing = [
    outcome ? "" : "outcome",
    files.length > 0 ? "" : "files",
    verification.length > 0 ? "" : "verification",
    blockers.length > 0 || /\bnone\b/i.test(extractLabeledValue(text, labels.blockers, allLabels) ?? "") ? "" : "blockers/risks",
    unblockStatus ? "" : "unblock status",
  ].filter(Boolean);

  return {
    outcome,
    files,
    verification,
    blockers,
    unblockStatus,
    missing,
  };
}

function getSection(markdown: string, title: string): string {
  const pattern = new RegExp(`^##\\s+${escapeRegex(title)}\\s*$`, "im");
  const match = markdown.match(pattern);
  if (!match || match.index === undefined) return "";

  const start = match.index + match[0].length;
  const remainder = markdown.slice(start);
  const nextHeading = remainder.match(/^##\s+/m);
  if (!nextHeading || nextHeading.index === undefined) return remainder.trim();
  return remainder.slice(0, nextHeading.index).trim();
}

function extractBulletItems(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function extractParagraph(section: string): string | undefined {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.join(" ");
}

function parseDependsOn(text: string | undefined): number[] {
  if (!text) return [];
  if (/^none$/i.test(text.trim())) return [];
  return parseNumberList(text);
}

function parseBatch(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function hasVerificationIntent(text: string | undefined): boolean {
  if (!text) return false;
  return VERIFICATION_HINT_PATTERN.test(text);
}

function isVagueStepText(text: string): boolean {
  const normalized = cleanStepText(text);
  if (normalized.length < 18) return true;
  return VAGUE_STEP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildPlanSignature(artifact: Omit<PlanArtifact, "signature" | "handoff">): string {
  return [
    `goal=${artifact.goal ?? ""}`,
    `context=${artifact.context.join("|")}`,
    `success=${artifact.successCriteria.join("|")}`,
    `policy=${artifact.executionPolicy.join("|")}`,
    `rereview=${artifact.rereviewTriggers.join("|")}`,
    `blockers=${artifact.blockers.join("|")}`,
    `files=${artifact.files.join("|")}`,
    `verification=${artifact.verification.join("|")}`,
    `questions=${artifact.openQuestions.join("|")}`,
    ...artifact.steps.map((step) => [
      `${step.step}:${step.text}`,
      `agent=${step.agent ?? ""}`,
      `batch=${step.batch ?? ""}`,
      `deps=${step.dependsOn.join(",")}`,
      `scope=${step.scope.join("|")}`,
      `verify=${step.verification ?? ""}`,
      `checkpoint=${step.checkpoint.join("|")}`,
      `review_gate=${step.reviewGate ?? ""}`,
      `review_reason=${step.reviewReason ?? ""}`,
      `why=${step.rationale ?? ""}`,
      `blockers=${(step.blockers ?? []).join("|")}`,
    ].join("|")),
  ].join("\n");
}

function collectAncestors(stepNumber: number, stepMap: Map<number, PlanStep>, visiting = new Set<number>()): Set<number> {
  if (visiting.has(stepNumber)) return new Set();
  visiting.add(stepNumber);

  const ancestors = new Set<number>();
  const step = stepMap.get(stepNumber);
  for (const dependency of step?.dependsOn ?? []) {
    ancestors.add(dependency);
    for (const ancestor of collectAncestors(dependency, stepMap, visiting)) ancestors.add(ancestor);
  }

  visiting.delete(stepNumber);
  return ancestors;
}

function validatePlanSteps(steps: PlanStep[], fileAnchors: string[] = []): PlanValidation {
  const errors: string[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<number>();
  let previous = 0;

  if (steps.length === 0) {
    errors.push("The plan needs at least one numbered step in the ## Plan section.");
    return { errors, blocking, warnings };
  }

  const stepMap = new Map<number, PlanStep>(steps.map((step) => [step.step, step]));
  const ancestorMap = new Map<number, Set<number>>();

  for (const step of steps) {
    if (seen.has(step.step)) {
      errors.push(`Step ${step.step} appears more than once.`);
    }
    seen.add(step.step);

    if (step.step <= previous) {
      errors.push(`Step numbering must increase strictly. Found step ${step.step} after step ${previous}.`);
    }
    previous = Math.max(previous, step.step);

    if (step.batch === undefined) {
      blocking.push(`Step ${step.step} is missing Batch metadata. Add it so ready-frontier orchestration is explicit.`);
    }

    if (step.agent === undefined) {
      blocking.push(`Step ${step.step} is missing Agent metadata. Specify main session, Explore, Plan, or general-purpose.`);
    }

    if (isVagueStepText(step.text)) {
      blocking.push(`Step ${step.step} is vague. Name the concrete deliverable, file, or behavior to change.`);
    }

    if (!hasVerificationIntent(step.text) && !hasVerificationIntent(step.verification)) {
      blocking.push(`Step ${step.step} does not say how completion will be verified. Add verification intent in the step text or Verification metadata.`);
    }

    if ((step.scope?.length ?? 0) === 0) {
      blocking.push(`Step ${step.step} is missing Scope metadata. Anchor it to the approved files or directories for this step.`);
    }

    if ((step.scope?.length ?? 0) > 0 && fileAnchors.length > 0) {
      const unanchored = step.scope.filter((scope) => !isScopeAnchored(scope, fileAnchors));
      if (unanchored.length > 0) {
        blocking.push(`Step ${step.step} scope is outside ## Files: ${unanchored.join(", ")}. Add or adjust the approved file anchors first.`);
      }
    }

    if ((step.checkpoint?.length ?? 0) === 0) {
      warnings.push(`Step ${step.step} is missing Checkpoint metadata. Add the step-specific completion summary emphasis if downstream work depends on it.`);
    }

    if (step.reviewGate && !PLAN_REVIEW_GATES.has(step.reviewGate as PlanReviewGate)) {
      errors.push(`Step ${step.step} has an invalid Review gate: ${step.reviewGate}. Use pause_after or rereview_after.`);
    }

    if (step.reviewGate && !step.reviewReason?.trim()) {
      blocking.push(`Step ${step.step} sets Review gate=${step.reviewGate} but is missing Review reason.`);
    }

    if (!step.reviewGate && step.reviewReason?.trim()) {
      blocking.push(`Step ${step.step} has a Review reason but no Review gate. Add pause_after or rereview_after.`);
    }

    for (const dependency of step.dependsOn) {
      const dependencyStep = stepMap.get(dependency);
      if (dependency === step.step) {
        errors.push(`Step ${step.step} cannot depend on itself.`);
      }
      if (!dependencyStep) {
        errors.push(`Step ${step.step} depends on missing step ${dependency}.`);
        continue;
      }
      if (dependency > step.step) {
        warnings.push(`Step ${step.step} depends on future step ${dependency}; consider reordering for clarity.`);
      }
      if (dependencyStep.batch !== undefined && step.batch !== undefined) {
        if (dependencyStep.batch === step.batch) {
          errors.push(`Step ${step.step} shares batch ${step.batch} with dependency ${dependency}. Steps in the same batch must be independently runnable.`);
        }
        if (dependencyStep.batch > step.batch) {
          errors.push(`Step ${step.step} is in batch ${step.batch} but depends on step ${dependency} in later batch ${dependencyStep.batch}.`);
        }
      }
    }
  }

  const sorted = [...steps].sort((a, b) => a.step - b.step).map((step) => step.step);
  const expected = Array.from({ length: sorted.length }, (_unused, index) => sorted[0] + index);
  if (sorted.some((value, index) => value !== expected[index])) {
    warnings.push("Step numbers are not contiguous. Progress tracking works best with sequential numbering.");
  }

  const adjacency = new Map<number, number[]>();
  for (const step of steps) {
    adjacency.set(step.step, step.dependsOn.filter((value) => stepMap.has(value)));
    ancestorMap.set(step.step, collectAncestors(step.step, stepMap));
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (stepNumber: number): void => {
    if (visited.has(stepNumber)) return;
    if (visiting.has(stepNumber)) {
      errors.push(`Detected a dependency cycle involving step ${stepNumber}.`);
      return;
    }

    visiting.add(stepNumber);
    for (const dependency of adjacency.get(stepNumber) ?? []) {
      visit(dependency);
    }
    visiting.delete(stepNumber);
    visited.add(stepNumber);
  };

  for (const step of steps) visit(step.step);

  const sortedSteps = [...steps].sort((a, b) => a.step - b.step);
  let highestBatchSeen = 0;
  for (const step of sortedSteps) {
    if (typeof step.batch === "number") {
      if (step.batch < highestBatchSeen) {
        warnings.push(`Batch numbering is non-monotonic near step ${step.step}. Keep batches in dependency order for clearer execution frontiers.`);
      }
      highestBatchSeen = Math.max(highestBatchSeen, step.batch);
    }
  }

  for (let index = 1; index < sortedSteps.length; index += 1) {
    const previousStep = sortedSteps[index - 1];
    const currentStep = sortedSteps[index];
    if (previousStep.batch === undefined || currentStep.batch === undefined) continue;
    if (currentStep.batch <= previousStep.batch) continue;

    const currentAncestors = ancestorMap.get(currentStep.step) ?? new Set<number>();
    const previousAncestors = ancestorMap.get(previousStep.step) ?? new Set<number>();
    const independent = !currentAncestors.has(previousStep.step) && !previousAncestors.has(currentStep.step);
    if (independent) {
      warnings.push(`Steps ${previousStep.step} and ${currentStep.step} are serialized across batches ${previousStep.batch} -> ${currentStep.batch} without a dependency edge. Consider the same batch if they can run in parallel.`);
    }
  }

  return {
    errors: uniqueNames(errors),
    blocking: uniqueNames(blocking),
    warnings: uniqueNames(warnings),
  };
}

function validateArtifactReadiness(artifact: Omit<PlanArtifact, "signature" | "handoff">): PlanValidation {
  const base = validatePlanSteps(artifact.steps, artifact.files);
  const blocking = [...base.blocking];
  const warnings = [...base.warnings];

  if (!artifact.goal?.trim()) {
    blocking.push("Capture the execution goal in ## Goal so approval and handoff have a clear target.");
  }
  if (artifact.context.length === 0) {
    warnings.push("Add a ## Context section with relevant code paths, constraints, or prior decisions.");
  }
  if (artifact.successCriteria.length === 0) {
    blocking.push("Add a ## Success Criteria section so approval captures the done contract, not just the task list.");
  }
  if (artifact.files.length === 0) {
    blocking.push("List the approved file or directory anchors in ## Files so review and execution start from the same scope.");
  }
  if (artifact.executionPolicy.length === 0) {
    blocking.push("Add a ## Execution Policy section that states the operating envelope and summary/checkpoint expectations.");
  }
  if (artifact.rereviewTriggers.length === 0) {
    blocking.push("Add a ## Re-review Triggers section that names when execution must pause or return for human review.");
  }
  if (artifact.verification.length === 0) {
    blocking.push("Add a ## Verification section so approval carries explicit proof obligations for the final result.");
  }

  return { errors: base.errors, blocking: uniqueNames(blocking), warnings: uniqueNames(warnings) };
}

function deriveStepStatus(step: PlanStep, stepMap: Map<number, PlanStep>): PlanStepStatus {
  if (step.completed) return "completed";
  const depsSatisfied = step.dependsOn.every((dependency) => stepMap.get(dependency)?.completed === true);
  if (!depsSatisfied) return "blocked";
  if (step.status === "in_progress" || step.status === "blocked") return step.status;
  return "pending";
}

function deriveBlockedReason(step: PlanStep, stepMap: Map<number, PlanStep>): PlanBlockedStep | undefined {
  if (step.completed) return undefined;
  const waitingOn = step.dependsOn.filter((dependency) => stepMap.get(dependency)?.completed !== true);
  if (waitingOn.length === 0) return undefined;
  return {
    step: step.step,
    waitingOn,
    reason: `Waiting on step${waitingOn.length === 1 ? "" : "s"} ${waitingOn.join(", ")}.`,
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function planPathForSession(sessionFile: string | undefined, cwd: string): string {
  const base = sessionFile ? basename(sessionFile).replace(/\.jsonl$/i, "") : `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return resolve(cwd, ".pi", "plans", `${base}.md`);
}

export function toProjectRelative(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  if (!rel || rel === "") return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function buildPlanningKickoffPrompt(request: string): string {
  const originalRequest = request.trim() || request;
  return `Create the implementation plan for the request below. This is a planning-only kickoff for a fresh session; do not execute code changes yet.

Concrete goal:
- Produce a high-quality implementation plan for the exact request below.
- Preserve the user's request verbatim and plan only within its intended scope.

Original request (verbatim):
<<<ORIGINAL_REQUEST
${originalRequest}
ORIGINAL_REQUEST>>>

Expected plan output contract:
- Write the plan into the session plan file using the required plan template/sections.
- Make the plan concrete enough that execution can start without reinterpretation.
- Include a dependency-aware numbered step list with explicit Agent, Batch, Depends on, Scope, and Verification metadata for each step.
- Make parallel-ready work explicit with same-batch steps only when they are independently runnable.

Scope and files:
- Inspect the repo enough to identify the concrete files/directories likely involved.
- Record those anchors in ## Files and keep each step Scope aligned to them.
- If scope is unclear, resolve it through planning discovery and document the approved anchors instead of leaving vague placeholders.

Verification expectations:
- Capture both focused per-step verification and the final verification needed to prove the request is done.
- Name tests, checks, or manual proof obligations wherever possible.

Approval envelope and handoff expectations:
- Keep ## Success Criteria, ## Execution Policy, ## Re-review Triggers, ## Files, ## Verification, ## Blockers, and ## Open Questions current for approval.
- Call out dependencies, blockers, risks, and pause/re-review points needed for safe execution.
- When the plan and approval envelope are ready, call plan_exit to trigger review/approval. Do not start execution yourself.`;
}

export function createPlanTemplate(goal?: string): string {
  const goalLine = goal?.trim() ? `- ${goal.trim()}\n` : "- Capture the approved execution plan for this session.\n";
  return `# Implementation Plan

## Goal
${goalLine}## Context
- Summarize the relevant code paths, constraints, and decisions already made.
- Call out any risks, unknowns, or dependencies that shape execution.

## Success Criteria
- Describe the user-visible or repo-visible outcomes that must be true when execution is done.
- Keep these criteria distinct from the tests or checks used to verify them.

## Plan
1. Inspect the concrete code paths, confirm the ready frontier, and capture any discovery needed before implementation.
   - Agent: Explore
   - Batch: 1
   - Depends on: none
   - Scope: path/to/file, path/to/tests
   - Verification: Confirm the target files, hooks, and constraints before implementation.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Why: Establish scope before changing behavior.
2. Implement the primary change set for the first independent slice.
   - Agent: general-purpose
   - Batch: 2
   - Depends on: 1
   - Scope: path/to/file
   - Verification: Name the focused checks, tests, or manual proof for this slice.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Why: Turn the scoped plan into concrete code changes.
3. Implement any same-frontier follow-up slice that can safely run in parallel with step 2.
   - Agent: general-purpose
   - Batch: 2
   - Depends on: 1
   - Scope: path/to/tests
   - Verification: Confirm the files touched and the proof for this parallel-ready slice.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: pause_after
   - Review reason: Pause before fan-in if this slice expands scope or changes execution risk.
   - Why: Make same-batch parallel work explicit when it exists.
4. Synthesize the fan-in, validate the result, and capture execution handoff expectations.
   - Agent: main session
   - Batch: 3
   - Depends on: 2, 3
   - Scope: path/to/file, path/to/tests
   - Verification: Run or describe the final proof that the workflow is complete.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Why: Close the loop after same-batch work is merged back together.

## Execution Policy
- Stay within the listed files and step scope anchors unless a human approves broader scope.
- Pause for human review before destructive commands, dependency changes, migrations, or other high-risk actions.
- Completion updates must summarize outcome, files touched, verification, blockers/risks, and whether downstream work is unblocked.

## Re-review Triggers
- A change touches files or directories outside ## Files or the active step Scope.
- The plan contract, success criteria, or execution policy changes after approval.
- Execution needs destructive commands, dependency changes, schema/data migrations, or secrets/production access.

## Blockers
- None right now.

## Files
- path/to/file
- path/to/tests

## Verification
- Run focused checks and relevant tests.
- Validate the end-to-end behavior after implementation.

## Open Questions
- None right now.
`;
}

export function cleanStepText(text: string): string {
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractPlanSteps(markdown: string, previousSteps: PlanStep[] = []): PlanStep[] {
  const section = getSection(markdown, "Plan");
  if (!section) return [];

  const previousByStep = new Map(previousSteps.map((step) => [step.step, step]));
  const lines = section.split(/\r?\n/);
  const steps: PlanStep[] = [];

  let currentStep: number | undefined;
  let currentText = "";
  let metadataLines: string[] = [];

  const flush = (): void => {
    if (currentStep === undefined || !currentText.trim()) return;
    const previous = previousByStep.get(currentStep);
    const metadata = new Map<string, string>();
    for (const line of metadataLines) {
      const match = line.match(/^\s*-\s*([^:]+):\s*(.+)$/);
      if (!match) continue;
      metadata.set(match[1].trim().toLowerCase(), match[2].trim());
    }

    const scope = parseTextList(metadata.get("scope"));
    const checkpoint = parseTextList(metadata.get("checkpoint"));
    steps.push({
      step: currentStep,
      text: cleanStepText(currentText),
      agent: metadata.get("agent") ?? previous?.agent,
      batch: parseBatch(metadata.get("batch")) ?? previous?.batch,
      dependsOn: parseDependsOn(metadata.get("depends on")) ?? previous?.dependsOn ?? [],
      scope: scope.length > 0 ? scope : previous?.scope ?? [],
      verification: metadata.get("verification") ?? previous?.verification,
      rationale: metadata.get("why") ?? metadata.get("rationale") ?? previous?.rationale,
      blockers: parseTextList(metadata.get("blockers")).length > 0 ? parseTextList(metadata.get("blockers")) : previous?.blockers,
      checkpoint: checkpoint.length > 0 ? checkpoint : previous?.checkpoint ?? [],
      reviewGate: parseReviewGate(metadata.get("review gate")) ?? previous?.reviewGate,
      reviewReason: metadata.get("review reason") ?? previous?.reviewReason,
      status: previous?.status ?? "pending",
      completed: previous?.completed ?? false,
      note: previous?.note,
    });
  };

  for (const line of lines) {
    const stepMatch = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (stepMatch) {
      flush();
      currentStep = Number(stepMatch[1]);
      currentText = stepMatch[2] ?? "";
      metadataLines = [];
      continue;
    }

    if (currentStep !== undefined) {
      if (/^##\s+/.test(line)) break;
      metadataLines.push(line);
    }
  }

  flush();

  const stepMap = new Map<number, PlanStep>(steps.map((step) => [step.step, step]));
  for (const step of steps) {
    step.status = deriveStepStatus(step, stepMap);
  }
  return steps;
}

export function normalizePlanArtifact(artifact: Omit<PlanArtifact, "signature" | "handoff">): PlanArtifact {
  const normalized = {
    ...artifact,
    validation: validateArtifactReadiness(artifact),
  };
  return {
    ...normalized,
    signature: buildPlanSignature(normalized),
    handoff: buildExecutionHandoff(normalized),
  };
}

export function extractPlanArtifact(markdown: string, previousSteps: PlanStep[] = []): PlanArtifact {
  const goalSection = getSection(markdown, "Goal");
  const contextSection = getSection(markdown, "Context");
  const successCriteriaSection = getSection(markdown, "Success Criteria");
  const executionPolicySection = getSection(markdown, "Execution Policy");
  const rereviewTriggersSection = getSection(markdown, "Re-review Triggers");
  const filesSection = getSection(markdown, "Files");
  const verificationSection = getSection(markdown, "Verification");
  const openQuestionsSection = getSection(markdown, "Open Questions");
  const blockersSection = getSection(markdown, "Blockers");
  const artifact = normalizePlanArtifact({
    goal: extractBulletItems(goalSection)[0] ?? extractParagraph(goalSection),
    context: extractBulletItems(contextSection),
    successCriteria: extractBulletItems(successCriteriaSection),
    executionPolicy: extractBulletItems(executionPolicySection),
    rereviewTriggers: extractBulletItems(rereviewTriggersSection),
    blockers: extractBulletItems(blockersSection),
    openQuestions: extractBulletItems(openQuestionsSection),
    files: extractBulletItems(filesSection),
    verification: extractBulletItems(verificationSection),
    steps: extractPlanSteps(markdown, previousSteps),
    validation: { errors: [], blocking: [], warnings: [] },
  });
  return artifact;
}

export function getReadySteps(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map<number, PlanStep>(steps.map((step) => [step.step, step]));
  return steps.filter((step) => !step.completed && step.dependsOn.every((dependency) => stepMap.get(dependency)?.completed === true));
}

export function getExecutionFrontier(steps: PlanStep[]): PlanStep[] {
  const ready = getReadySteps(steps);
  if (ready.length === 0) return [];
  const frontierOrder = Math.min(...ready.map((step) => step.batch ?? step.step));
  return ready
    .filter((step) => (step.batch ?? step.step) === frontierOrder)
    .sort((a, b) => a.step - b.step);
}

export function getBlockedSteps(steps: PlanStep[]): PlanBlockedStep[] {
  const stepMap = new Map<number, PlanStep>(steps.map((step) => [step.step, step]));
  return steps
    .map((step) => deriveBlockedReason(step, stepMap))
    .filter((item): item is PlanBlockedStep => Boolean(item));
}

export function summarizeStepNumbers(stepNumbers: number[]): string {
  if (stepNumbers.length === 0) return "none";
  return stepNumbers.join(", ");
}

export function formatFrontierLabel(steps: PlanStep[]): string {
  if (steps.length === 0) return "No ready steps.";
  const batch = steps[0]?.batch;
  const prefix = typeof batch === "number" ? `Batch ${batch}` : "Ready now";
  return `${prefix}: steps ${summarizeStepNumbers(steps.map((step) => step.step))}`;
}

export function findCurrentStep(steps: PlanStep[]): PlanStep | undefined {
  return getExecutionFrontier(steps)[0];
}

export function buildExecutionHandoff(artifact: Pick<PlanArtifact, "goal" | "context" | "successCriteria" | "executionPolicy" | "rereviewTriggers" | "blockers" | "files" | "verification" | "steps">): PlanExecutionHandoff {
  const frontier = getExecutionFrontier(artifact.steps);
  const blocked = getBlockedSteps(artifact.steps);
  const frontierPolicies = frontier.map((step) => deriveSubagentPolicy(step, frontier.length));
  const frontierScopeAnchors = uniqueNames(frontier.flatMap((step) => step.scope ?? []));
  const frontierPauseConditions = uniqueNames([
    ...artifact.rereviewTriggers,
    ...frontier
      .filter((step) => step.reviewGate)
      .map((step) => `Step ${step.step}: ${step.reviewGate}${step.reviewReason ? ` — ${step.reviewReason}` : ""}`),
  ]);
  const checkpointContract = uniqueNames([
    ...DEFAULT_CHECKPOINT_CONTRACT,
    ...frontier.flatMap((step) => step.checkpoint ?? []),
  ]);
  const delegationGuidance = uniqueNames([
    ...frontierPolicies.flatMap((policy) => [`Prefer ${policy.preferredAgent} for the current frontier.`, ...policy.resultContract]),
    frontier.length > 1
      ? "Current ready steps can run in parallel. Fan out within the frontier, then synthesize results before unlocking downstream work."
      : "Keep tightly-coupled work in the main session unless discovery or synthesis is clearly separable.",
  ]);

  return {
    goal: artifact.goal,
    constraints: artifact.context,
    successCriteria: artifact.successCriteria,
    blockers: uniqueNames([
      ...artifact.blockers,
      ...blocked.map((item) => `Step ${item.step}: ${item.reason}`),
    ]),
    files: artifact.files,
    scopeAnchors: frontierScopeAnchors.length > 0 ? frontierScopeAnchors : artifact.files,
    verification: uniqueNames([
      ...artifact.verification,
      ...frontier.map((step) => step.verification).filter((value): value is string => Boolean(value?.trim())),
    ]),
    executionPolicy: artifact.executionPolicy,
    pauseConditions: frontierPauseConditions,
    checkpointContract,
    remainingSteps: artifact.steps.filter((step) => !step.completed).map((step) => step.step),
    readySteps: frontier.map((step) => step.step),
    frontierBatch: frontier[0]?.batch,
    delegationGuidance,
  };
}

function parseSignatureEntries(signature: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of signature.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const stepMatch = line.match(/^(\d+):/);
    if (stepMatch) {
      entries.set(`step:${stepMatch[1]}`, line);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return entries;
}

export function detectPlanDrift(artifact: PlanArtifact | undefined, approvedSignature?: string): PlanDrift {
  if (!artifact || !approvedSignature) {
    return { changed: false, requiresReapproval: false, reasons: [] };
  }
  if (artifact.signature === approvedSignature) {
    return { changed: false, requiresReapproval: false, reasons: [] };
  }

  const current = parseSignatureEntries(artifact.signature);
  const approved = parseSignatureEntries(approvedSignature);
  const changedSteps = uniqueNames([
    ...[...current.keys()].filter((key) => key.startsWith("step:") && current.get(key) !== approved.get(key)).map((key) => key.replace("step:", "")),
    ...[...approved.keys()].filter((key) => key.startsWith("step:") && current.get(key) !== approved.get(key)).map((key) => key.replace("step:", "")),
  ]).map((value) => Number(value)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);

  const reasons = uniqueNames([
    current.get("goal") !== approved.get("goal") ? "The execution goal changed after approval." : "",
    current.get("success") !== approved.get("success") ? "The success criteria changed after approval." : "",
    current.get("files") !== approved.get("files") ? "The approved file/scope anchors changed after approval." : "",
    current.get("policy") !== approved.get("policy") ? "The execution policy changed after approval." : "",
    current.get("rereview") !== approved.get("rereview") ? "The pause or re-review triggers changed after approval." : "",
    current.get("verification") !== approved.get("verification") ? "The verification contract changed after approval." : "",
    changedSteps.length > 0 ? `Plan steps changed after approval: ${changedSteps.join(", ")}.` : "",
    "Re-review the plan or explicitly override before continuing execution.",
  ]);

  return {
    changed: true,
    requiresReapproval: true,
    reasons,
  };
}

export function deriveExecutionWarnings(artifact: PlanArtifact | undefined, approvedSignature?: string, existingWarnings: string[] = []): string[] {
  const warnings = [...existingWarnings];
  if (!artifact) return uniqueNames(warnings);

  warnings.push(...artifact.validation.blocking.map((item) => `Approval blocker: ${item}`));
  warnings.push(...artifact.validation.warnings);
  const drift = detectPlanDrift(artifact, approvedSignature);
  warnings.push(...drift.reasons);
  return uniqueNames(warnings);
}

export function extractDoneSteps(text: string): number[] {
  const steps = new Set<number>();
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.add(step);
  }
  return [...steps].sort((a, b) => a - b);
}

export function extractNaturalLanguageDoneSteps(text: string): number[] {
  const steps = new Set<number>();
  const patterns = [
    /\b(?:completed|finished|wrapped up)\s+step(?:s)?\s+([\d,\sand]+)/gi,
    /\bdone with\s+step(?:s)?\s+([\d,\sand]+)/gi,
    /\bstep(?:s)?\s+([\d,\sand]+)\s+(?:is|are)?\s*(?:completed|complete|finished|done)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const step of parseNumberList(match[1] ?? "")) steps.add(step);
    }
  }

  return [...steps].sort((a, b) => a - b);
}

export function markCompletedSteps(text: string, steps: PlanStep[]): { count: number; completedSteps: number[]; source?: ProgressSource; warnings: string[] } {
  const warnings: string[] = [];
  const knownSteps = new Set(steps.map((step) => step.step));
  const markerSteps = extractDoneSteps(text).filter((step) => knownSteps.has(step));
  const naturalSteps = markerSteps.length === 0 ? extractNaturalLanguageDoneSteps(text).filter((step) => knownSteps.has(step)) : [];
  const source: ProgressSource | undefined = markerSteps.length > 0 ? "done_marker" : naturalSteps.length > 0 ? "natural_language" : undefined;
  const doneSteps = new Set(source === "done_marker" ? markerSteps : naturalSteps);

  if (source === "natural_language") {
    warnings.push("Detected step completion from natural language. Prefer explicit [DONE:n] markers.");
  }

  const mentionedUnknown = [
    ...extractDoneSteps(text).filter((step) => !knownSteps.has(step)),
    ...extractNaturalLanguageDoneSteps(text).filter((step) => !knownSteps.has(step)),
  ];
  if (mentionedUnknown.length > 0) {
    warnings.push(`Ignored completion signals for unknown step numbers: ${uniqueNames(mentionedUnknown.map(String)).join(", ")}.`);
  }

  let completed = 0;
  const completedSteps: number[] = [];
  const stepMap = new Map<number, PlanStep>(steps.map((step) => [step.step, step]));

  for (const step of steps) {
    if (doneSteps.has(step.step) && !step.completed) {
      step.completed = true;
      step.status = "completed";
      completed += 1;
      completedSteps.push(step.step);
    }
  }

  for (const step of steps) {
    step.status = deriveStepStatus(step, stepMap);
  }

  return { count: completed, completedSteps, source, warnings: uniqueNames(warnings) };
}

export function updateStepStatus(
  steps: PlanStep[],
  stepNumber: number,
  status: PlanStepStatus,
  note?: string,
): { updated: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const target = steps.find((step) => step.step === stepNumber);
  if (!target) {
    return { updated: false, warnings: [`Step ${stepNumber} does not exist in the approved plan.`] };
  }

  target.note = note?.trim() || undefined;
  target.completed = status === "completed";
  target.status = status;

  if (status === "completed") {
    for (const dependency of target.dependsOn) {
      const dependencyStep = steps.find((step) => step.step === dependency);
      if (dependencyStep && !dependencyStep.completed) {
        warnings.push(`Step ${stepNumber} was marked complete before dependency ${dependency} was completed.`);
      }
    }
  }

  const stepMap = new Map<number, PlanStep>(steps.map((step) => [step.step, step]));
  for (const step of steps) {
    step.status = deriveStepStatus(step, stepMap);
  }

  if (status === "blocked" && target.dependsOn.every((dependency) => stepMap.get(dependency)?.completed === true)) {
    target.status = "blocked";
  }
  if (status === "in_progress") {
    target.status = "in_progress";
  }
  if (status === "completed") {
    target.status = "completed";
  }

  return { updated: true, warnings: uniqueNames(warnings) };
}

export function isSafeReadOnlyCommand(command: string): boolean {
  const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
  const safe = SAFE_READONLY_PATTERNS.some((pattern) => pattern.test(command));
  return safe && !destructive;
}

const PLAN_ONLY_TOOL_NAMES = new Set(["question", "plan_enter", "plan_exit", "plan_progress"]);
const PROMPT_MASTER_TOOL_NAMES = new Set(["prompt_improve"]);

export function stripPlanOnlyTools(names: string[]): string[] {
  return names.filter((name) => !PLAN_ONLY_TOOL_NAMES.has(name));
}

export function stripPromptMasterTools(names: string[]): string[] {
  return names.filter((name) => !PROMPT_MASTER_TOOL_NAMES.has(name));
}

export function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

export function normalizeAgentPreference(agent: string | undefined): string {
  const normalized = agent?.trim() ?? "";
  if (!normalized) return "general-purpose";
  if (/^general-purpose$/i.test(normalized)) return "general-purpose";
  if (/^explore$/i.test(normalized)) return "Explore";
  if (/^plan$/i.test(normalized)) return "Plan";
  if (MAIN_AGENT_PATTERN.test(normalized)) return "main session";
  return normalized;
}

export function deriveSubagentPolicy(step: PlanStep, frontierSize = 1): PlanSubagentPolicy {
  const preferredAgent = normalizeAgentPreference(step.agent);
  const writeCapable = preferredAgent === "general-purpose";
  const runInBackground = preferredAgent !== "main session" && frontierSize > 1;
  return {
    preferredAgent,
    runInBackground,
    joinMode: frontierSize > 1 && preferredAgent !== "main session" ? "group" : "smart",
    isolation: writeCapable && frontierSize > 1 ? "worktree" : undefined,
    resultContract: [
      `Reference step ${step.step} in the description/prompt for delegated work.`,
      "Return a concise normalized summary with: outcome, files touched, verification, blockers/risks, and unblock status.",
      "Do not advance dependent steps until delegated results are synthesized back into the main flow.",
    ],
  };
}

export function extractReferencedStepsFromText(text: string, knownSteps: number[] = []): number[] {
  const all = parseNumberList(text);
  if (knownSteps.length === 0) return all;
  const known = new Set(knownSteps);
  return all.filter((step) => known.has(step));
}

export function formatPlanStatus(planPath: string | undefined, cwd: string, mode: PlanMode, panelVisible: boolean, artifact?: PlanArtifact): string {
  const location = planPath ? toProjectRelative(planPath, cwd) : "(not created yet)";
  const progress = artifact?.steps.length ? `${artifact.steps.filter((step) => step.completed).length}/${artifact.steps.length}` : "0/0";
  const frontier = artifact ? formatFrontierLabel(getExecutionFrontier(artifact.steps)) : "No ready steps.";
  return `Plan mode: ${mode}\nPlan file: ${location}\nPanel: ${panelVisible ? "visible" : "hidden"}\nProgress: ${progress}\nFrontier: ${frontier}`;
}

export function planInstructions(planPath: string, cwd: string, hasSubagentTool: boolean): string {
  const relativePlanPath = toProjectRelative(planPath, cwd);
  const subagentNote = hasSubagentTool
    ? [
      "- Choose Agent metadata deliberately instead of defaulting every step to main session.",
      "- Use general-purpose for most implementation or write-capable execution work.",
      "- Use Explore only for codebase discovery/evidence gathering.",
      "- Use Plan only for architecture trade-offs or synthesis.",
      "- Use main session for tightly-coupled edits, final fan-in, or tiny changes that would add more delegation friction than value.",
    ].join("\n") + "\n"
    : "";
  return `You are in plan mode.

Rules:
- Read and inspect freely.
- Only modify the plan file at ${relativePlanPath}.
- Do not edit any other file.
- Use read-only bash commands only.
${subagentNote}Write the approved plan into ${relativePlanPath}.
- The numbered steps are the execution contract; make them concrete, dependency-aware, and ready to execute without reinterpretation.
- Every step should state a real deliverable, Agent, Batch, Depends on, Scope, and how completion will be verified (either in the text or Verification metadata).
- Add Checkpoint metadata when the step needs a specific completion-summary emphasis, and use Review gate / Review reason for steps that must pause or return for human review.
- Plan by dependency frontier: use Batch to show what becomes ready together, and keep same-batch steps independently runnable with no dependency edges between them.
- When multiple steps are ready in the same batch, make the parallel fan-out/fan-in explicit so execution can delegate them together and synthesize results before unlocking downstream work.
- Preserve safety boundaries in the plan: Explore and Plan stay read-only, while write-capable implementation should stay in main session or general-purpose execution steps.
- Explain blocker/dependency rationale when it matters for approval.
- Keep ## Success Criteria, ## Execution Policy, ## Re-review Triggers, ## Files, and ## Verification current so approval captures both the plan and the operating envelope.
- When the plan is ready for approval, call the plan_exit tool.
- Use [DONE:n] markers only after execution starts, not while planning.`;
}

export function formatStepForExecution(step: PlanStep): string {
  const metadata: string[] = [];
  if (step.agent) metadata.push(`agent=${step.agent}`);
  if (typeof step.batch === "number") metadata.push(`batch=${step.batch}`);
  if (step.dependsOn.length > 0) metadata.push(`depends_on=${step.dependsOn.join(",")}`);
  if (step.scope.length > 0) metadata.push(`scope=${step.scope.join(", ")}`);
  if (step.verification) metadata.push(`verify=${step.verification}`);
  return `${step.step}. ${step.text}${metadata.length > 0 ? ` (${metadata.join(" • ")})` : ""}`;
}

function formatStepForApproval(step: PlanStep): string[] {
  const lines = [`  ${formatStepForExecution(step)}`];
  if (step.checkpoint.length > 0) lines.push(`    - checkpoint: ${step.checkpoint.join("; ")}`);
  if (step.reviewGate) lines.push(`    - review gate: ${step.reviewGate}${step.reviewReason ? ` — ${step.reviewReason}` : ""}`);
  if (step.rationale) lines.push(`    - why: ${step.rationale}`);
  if (step.blockers && step.blockers.length > 0) lines.push(`    - blockers: ${step.blockers.join("; ")}`);
  return lines;
}

export function executionInstructions(planPath: string, cwd: string, artifact?: PlanArtifact): string {
  const relativePlanPath = toProjectRelative(planPath, cwd);
  const steps = artifact?.steps ?? [];
  const frontier = getExecutionFrontier(steps);
  const remaining = steps.filter((step) => !step.completed);
  const blocked = getBlockedSteps(steps);
  const checklist = remaining.length > 0 ? remaining.map(formatStepForExecution).join("\n") : "- No remaining steps recorded.";
  const readyNow = frontier.length > 0 ? frontier.map(formatStepForExecution).join("\n") : "- No ready steps. Investigate blockers or update plan progress.";
  const validationItems = [
    ...(artifact?.validation.blocking ?? []).map((item) => `Approval blocker: ${item}`),
    ...(artifact?.validation.warnings ?? []).map((item) => `Warning: ${item}`),
  ];
  const warnings = validationItems.length > 0 ? `\nPlan warnings:\n- ${validationItems.join("\n- ")}\n` : "";
  const handoff = artifact?.handoff;
  const handoffBlock = handoff
    ? `\nExecution handoff:\n- Goal: ${handoff.goal ?? "(not captured)"}\n- Constraints: ${handoff.constraints.length > 0 ? handoff.constraints.join(" | ") : "none recorded"}\n- Success criteria: ${handoff.successCriteria.length > 0 ? handoff.successCriteria.join(" | ") : "none recorded"}\n- Scope anchors: ${handoff.scopeAnchors.length > 0 ? handoff.scopeAnchors.join(" | ") : "none recorded"}\n- Verification: ${handoff.verification.length > 0 ? handoff.verification.join(" | ") : "none recorded"}\n- Execution policy: ${handoff.executionPolicy.length > 0 ? handoff.executionPolicy.join(" | ") : "none recorded"}\n- Pause conditions: ${handoff.pauseConditions.length > 0 ? handoff.pauseConditions.join(" | ") : "none recorded"}\n- Checkpoint contract: ${handoff.checkpointContract.join(" | ")}\n- Blockers: ${handoff.blockers.length > 0 ? handoff.blockers.join(" | ") : "none"}\n`
    : "";
  const blockedBlock = blocked.length > 0 ? `Blocked steps:\n- ${blocked.map((item) => `Step ${item.step}: ${item.reason}`).join("\n- ")}\n` : "";
  const policyLines = frontier.map((step) => {
    const policy = deriveSubagentPolicy(step, frontier.length);
    const guidance = [
      `step ${step.step} -> ${policy.preferredAgent}`,
      policy.runInBackground ? "background" : "foreground/main",
      policy.isolation ? `isolation=${policy.isolation}` : undefined,
      policy.joinMode ? `join=${policy.joinMode}` : undefined,
    ].filter(Boolean).join(" • ");
    return `- ${guidance}`;
  }).join("\n");
  const policyBlock = frontier.length > 0
    ? `Subagent policy for the current frontier:
${policyLines}
- Delegated work must reference its step number(s) and return outcome/files/verification/blockers/unblock status before downstream steps proceed.
- If multiple write-capable tasks run in parallel, prefer general-purpose background subagents with isolation: worktree and grouped fan-in.
- Retry or escalate failed delegated work before advancing dependent steps.
`
    : "";

  return `Execution mode is active.

Approved plan file: ${relativePlanPath}

Ready frontier:
${readyNow}

Remaining steps:
${checklist}

${blockedBlock}${warnings}${handoffBlock}${policyBlock}Execution guidance:
- Start from the current ready frontier, not just the next single unfinished step in plan order.
- Use main session for tightly-coupled edits, tiny fixes, or final fan-in work that would not benefit from delegation.
- Use Explore only for discovery/evidence gathering.
- Use Plan only when you need architecture comparison or synthesis.
- Use general-purpose subagents for most implementation work.
- When the ready frontier has multiple independent steps in the same batch, fan out delegated work in parallel, wait for results, normalize/summarize them back into the main flow, then move to the next frontier.
- Keep the read-only planning boundary intact: planning/synthesis stays read-only, while execution handoff should delegate only the write-capable frontier work.
- Emit [DONE:n] markers in normal assistant messages as each numbered step completes.
- If you already finished a step but forgot a marker, call plan_progress for that step immediately, then keep going.`;
}

export function formatApprovalSummary(planPath: string, cwd: string, artifact?: PlanArtifact): string {
  const relativePlanPath = toProjectRelative(planPath, cwd);
  const goal = artifact?.goal ?? "No goal captured yet.";
  const successCriteria = artifact?.successCriteria.length ? artifact.successCriteria.map((item) => `  - ${item}`).join("\n") : "  - None captured";
  const executionPolicy = artifact?.executionPolicy.length ? artifact.executionPolicy.map((item) => `  - ${item}`).join("\n") : "  - None captured";
  const rereviewTriggers = artifact?.rereviewTriggers.length ? artifact.rereviewTriggers.map((item) => `  - ${item}`).join("\n") : "  - None captured";
  const steps = artifact?.steps.length
    ? artifact.steps.flatMap(formatStepForApproval).join("\n")
    : "  (No numbered steps found)";
  const files = artifact?.files.length ? artifact.files.map((file) => `  - ${file}`).join("\n") : "  - None listed";
  const blockers = artifact?.blockers.length ? artifact.blockers.map((item) => `  - ${item}`).join("\n") : "  - None";
  const verification = artifact?.verification.length ? artifact.verification.map((item) => `  - ${item}`).join("\n") : "  - None captured";
  const questions = artifact?.openQuestions.length ? artifact.openQuestions.map((item) => `  - ${item}`).join("\n") : "  - None";
  const readyNow = artifact ? getExecutionFrontier(artifact.steps).map((step) => `  - ${formatStepForExecution(step)}`).join("\n") : "";
  const issues = [
    ...(artifact?.validation.errors ?? []).map((item) => `  - ERROR: ${item}`),
    ...(artifact?.validation.blocking ?? []).map((item) => `  - Approval blocker: ${item}`),
    ...(artifact?.validation.warnings ?? []).map((item) => `  - Warning: ${item}`),
  ];
  const issueBlock = issues.length > 0 ? `\nValidation:\n${issues.join("\n")}` : "";
  const handoff = artifact?.handoff;
  const handoffBlock = handoff
    ? `\nExecution handoff:\n  - Remaining steps: ${handoff.remainingSteps.join(", ") || "none"}\n  - Ready now: ${handoff.readySteps.join(", ") || "none"}\n  - Scope anchors: ${handoff.scopeAnchors.join(" | ") || "none"}\n  - Pause conditions: ${handoff.pauseConditions.join(" | ") || "none"}\n  - Delegation guidance: ${handoff.delegationGuidance.join(" | ")}`
    : "";

  return `Plan summary for ${relativePlanPath}\n\nGoal:\n  ${goal}\n\nSuccess criteria:\n${successCriteria}\n\nSteps:\n${steps}\n\nFiles:\n${files}\n\nExecution policy:\n${executionPolicy}\n\nRe-review triggers:\n${rereviewTriggers}\n\nBlockers:\n${blockers}\n\nVerification:\n${verification}\n\nOpen questions:\n${questions}${readyNow ? `\n\nReady frontier:\n${readyNow}` : ""}${handoffBlock}${issueBlock}`;
}
