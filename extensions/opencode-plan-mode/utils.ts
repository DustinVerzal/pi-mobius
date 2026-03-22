import { access } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

export type PlanMode = "normal" | "planning" | "approval_pending" | "approved_waiting_execution" | "executing";
export type PlanStepStatus = "pending" | "blocked" | "in_progress" | "completed";
export type ProgressSource = "done_marker" | "natural_language" | "tool";
export type SubagentStatus = "queued" | "running" | "background" | "completed" | "failed" | "steered" | "stopped";

export interface PlanStep {
  step: number;
  text: string;
  agent?: string;
  batch?: number;
  dependsOn: number[];
  verification?: string;
  rationale?: string;
  blockers?: string[];
  status: PlanStepStatus;
  completed: boolean;
  note?: string;
}

export interface PlanValidation {
  errors: string[];
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
  blockers: string[];
  files: string[];
  verification: string[];
  remainingSteps: number[];
  readySteps: number[];
  frontierBatch?: number;
  delegationGuidance: string[];
}

export interface PlanArtifact {
  goal?: string;
  context: string[];
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

export interface PlanExecutionState {
  completedSteps: number[];
  activeStep?: number;
  readySteps: number[];
  frontierStepNumbers: number[];
  frontierBatch?: number;
  blockedSteps: PlanBlockedStep[];
  warnings: string[];
  lastProgressAt?: string;
  lastProgressSource?: ProgressSource;
  planChangedSinceApproval?: boolean;
  requiresReapproval?: boolean;
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
  normalizedSummary?: string;
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
    `blockers=${artifact.blockers.join("|")}`,
    `files=${artifact.files.join("|")}`,
    `verification=${artifact.verification.join("|")}`,
    `questions=${artifact.openQuestions.join("|")}`,
    ...artifact.steps.map((step) => [
      `${step.step}:${step.text}`,
      `agent=${step.agent ?? ""}`,
      `batch=${step.batch ?? ""}`,
      `deps=${step.dependsOn.join(",")}`,
      `verify=${step.verification ?? ""}`,
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

function validatePlanSteps(steps: PlanStep[]): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<number>();
  let previous = 0;

  if (steps.length === 0) {
    errors.push("The plan needs at least one numbered step in the ## Plan section.");
    return { errors, warnings };
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
      warnings.push(`Step ${step.step} is missing Batch metadata. Add it so ready-frontier orchestration is explicit.`);
    }

    if (step.agent === undefined) {
      warnings.push(`Step ${step.step} is missing Agent metadata. Specify main session, Explore, Plan, or general-purpose.`);
    }

    if (isVagueStepText(step.text)) {
      warnings.push(`Step ${step.step} is vague. Name the concrete deliverable, file, or behavior to change.`);
    }

    if (!hasVerificationIntent(step.text) && !hasVerificationIntent(step.verification)) {
      warnings.push(`Step ${step.step} does not say how completion will be verified. Add verification intent in the step text or Verification metadata.`);
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
    warnings: uniqueNames(warnings),
  };
}

function validateArtifactReadiness(artifact: Omit<PlanArtifact, "signature" | "handoff">): PlanValidation {
  const base = validatePlanSteps(artifact.steps);
  const warnings = [...base.warnings];

  if (!artifact.goal?.trim()) {
    warnings.push("Capture the execution goal in ## Goal so approval and handoff have a clear target.");
  }
  if (artifact.context.length === 0) {
    warnings.push("Add a ## Context section with relevant code paths, constraints, or prior decisions.");
  }
  if (artifact.files.length === 0) {
    warnings.push("List the expected files of interest in ## Files so review and execution start from the same scope.");
  }
  const hasVerification = artifact.verification.length > 0 || artifact.steps.some((step) => hasVerificationIntent(step.text) || hasVerificationIntent(step.verification));
  if (!hasVerification) {
    warnings.push("Add a ## Verification section or step-level verification metadata so approval can confirm the exit criteria.");
  }

  return { errors: base.errors, warnings: uniqueNames(warnings) };
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

export function createPlanTemplate(goal?: string): string {
  const goalLine = goal?.trim() ? `- ${goal.trim()}\n` : "- Capture the approved execution plan for this session.\n";
  return `# Implementation Plan\n\n## Goal\n${goalLine}## Context\n- Summarize the relevant code paths, constraints, and decisions already made.\n- Call out any risks, unknowns, or dependencies that shape execution.\n\n## Plan\n1. Inspect the concrete code paths and define the first execution-ready deliverable.\n   - Agent: main session\n   - Batch: 1\n   - Depends on: none\n   - Verification: Confirm the target files, hooks, and constraints before implementation.\n   - Why: Establish scope before changing behavior.\n2. Implement the primary change set and note any safe parallel follow-up work.\n   - Agent: main session\n   - Batch: 2\n   - Depends on: 1\n   - Verification: Name the focused checks, tests, or manual proof for this change.\n   - Why: Turn the scoped plan into concrete code changes.\n3. Validate the result, edge cases, and execution handoff expectations.\n   - Agent: main session\n   - Batch: 3\n   - Depends on: 1, 2\n   - Verification: Run or describe the final proof that the workflow is complete.\n   - Why: Close the loop before execution approval.\n\n## Blockers\n- None right now.\n\n## Files\n- path/to/file\n\n## Verification\n- Run focused checks and relevant tests.\n- Validate the end-to-end behavior after implementation.\n\n## Open Questions\n- None right now.\n`;
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

    steps.push({
      step: currentStep,
      text: cleanStepText(currentText),
      agent: metadata.get("agent") ?? previous?.agent,
      batch: parseBatch(metadata.get("batch")) ?? previous?.batch,
      dependsOn: parseDependsOn(metadata.get("depends on")) ?? previous?.dependsOn ?? [],
      verification: metadata.get("verification") ?? previous?.verification,
      rationale: metadata.get("why") ?? metadata.get("rationale") ?? previous?.rationale,
      blockers: parseTextList(metadata.get("blockers")).length > 0 ? parseTextList(metadata.get("blockers")) : previous?.blockers,
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
  const filesSection = getSection(markdown, "Files");
  const verificationSection = getSection(markdown, "Verification");
  const openQuestionsSection = getSection(markdown, "Open Questions");
  const blockersSection = getSection(markdown, "Blockers");
  const artifact = normalizePlanArtifact({
    goal: extractBulletItems(goalSection)[0] ?? extractParagraph(goalSection),
    context: extractBulletItems(contextSection),
    blockers: extractBulletItems(blockersSection),
    openQuestions: extractBulletItems(openQuestionsSection),
    files: extractBulletItems(filesSection),
    verification: extractBulletItems(verificationSection),
    steps: extractPlanSteps(markdown, previousSteps),
    validation: { errors: [], warnings: [] },
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

export function buildExecutionHandoff(artifact: Pick<PlanArtifact, "goal" | "context" | "blockers" | "files" | "verification" | "steps">): PlanExecutionHandoff {
  const frontier = getExecutionFrontier(artifact.steps);
  const blocked = getBlockedSteps(artifact.steps);
  const frontierPolicies = frontier.map((step) => deriveSubagentPolicy(step, frontier.length));
  const delegationGuidance = uniqueNames([
    ...frontierPolicies.flatMap((policy) => [`Prefer ${policy.preferredAgent} for the current frontier.`, ...policy.resultContract]),
    frontier.length > 1
      ? "Current ready steps can run in parallel. Fan out within the frontier, then synthesize results before unlocking downstream work."
      : "Keep tightly-coupled work in the main session unless discovery or synthesis is clearly separable.",
  ]);

  return {
    goal: artifact.goal,
    constraints: artifact.context,
    blockers: uniqueNames([
      ...artifact.blockers,
      ...blocked.map((item) => `Step ${item.step}: ${item.reason}`),
    ]),
    files: artifact.files,
    verification: uniqueNames([
      ...artifact.verification,
      ...frontier.map((step) => step.verification).filter((value): value is string => Boolean(value?.trim())),
    ]),
    remainingSteps: artifact.steps.filter((step) => !step.completed).map((step) => step.step),
    readySteps: frontier.map((step) => step.step),
    frontierBatch: frontier[0]?.batch,
    delegationGuidance,
  };
}

export function detectPlanDrift(artifact: PlanArtifact | undefined, approvedSignature?: string): PlanDrift {
  if (!artifact || !approvedSignature) {
    return { changed: false, requiresReapproval: false, reasons: [] };
  }
  if (artifact.signature === approvedSignature) {
    return { changed: false, requiresReapproval: false, reasons: [] };
  }
  return {
    changed: true,
    requiresReapproval: true,
    reasons: [
      "The approved execution contract changed after approval.",
      "Re-review the plan or explicitly override before continuing execution.",
    ],
  };
}

export function deriveExecutionWarnings(artifact: PlanArtifact | undefined, approvedSignature?: string, existingWarnings: string[] = []): string[] {
  const warnings = [...existingWarnings];
  if (!artifact) return uniqueNames(warnings);

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

export function stripPlanOnlyTools(names: string[]): string[] {
  return names.filter((name) => !new Set(["question", "plan_exit", "plan_progress"]).has(name));
}

export function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

export function normalizeAgentPreference(agent: string | undefined): string {
  const normalized = agent?.trim() ?? "";
  if (!normalized) return "main session";
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
      "Return a concise normalized summary with: outcome, files touched, verification, and blockers/risks.",
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
      "- Use the main agent first for small or obvious planning work.",
      "- If you delegate, use Explore only for codebase discovery/evidence gathering.",
      "- Use Plan only for architecture trade-offs or synthesis.",
      "- Do not assume every step should say Agent: Explore.",
    ].join("\n") + "\n"
    : "";
  return `You are in plan mode.\n\nRules:\n- Read and inspect freely.\n- Only modify the plan file at ${relativePlanPath}.\n- Do not edit any other file.\n- Use read-only bash commands only.\n${subagentNote}Write the approved plan into ${relativePlanPath}.\n- The numbered steps are the execution contract; make them concrete, dependency-aware, and ready to execute without reinterpretation.\n- Every step should state a real deliverable, Agent, Batch, Depends on, and how completion will be verified (either in the text or Verification metadata).\n- Use Batch to mark the concurrency frontier: steps in the same batch must be independently runnable and must not depend on each other.\n- Explain blocker/dependency rationale when it matters for approval.\n- Keep ## Context, ## Files, ## Verification, and ## Blockers current so approval has enough evidence.\n- When the plan is ready for approval, call the plan_exit tool.\n- Use [DONE:n] markers only after execution starts, not while planning.`;
}

export function formatStepForExecution(step: PlanStep): string {
  const metadata: string[] = [];
  if (step.agent) metadata.push(`agent=${step.agent}`);
  if (typeof step.batch === "number") metadata.push(`batch=${step.batch}`);
  if (step.dependsOn.length > 0) metadata.push(`depends_on=${step.dependsOn.join(",")}`);
  if (step.verification) metadata.push(`verify=${step.verification}`);
  return `${step.step}. ${step.text}${metadata.length > 0 ? ` (${metadata.join(" • ")})` : ""}`;
}

function formatStepForApproval(step: PlanStep): string[] {
  const lines = [`  ${formatStepForExecution(step)}`];
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
  const warnings = artifact?.validation.warnings.length ? `\nPlan warnings:\n- ${artifact.validation.warnings.join("\n- ")}\n` : "";
  const handoff = artifact?.handoff;
  const handoffBlock = handoff
    ? `\nExecution handoff:\n- Goal: ${handoff.goal ?? "(not captured)"}\n- Constraints: ${handoff.constraints.length > 0 ? handoff.constraints.join(" | ") : "none recorded"}\n- Files: ${handoff.files.length > 0 ? handoff.files.join(", ") : "none listed"}\n- Verification: ${handoff.verification.length > 0 ? handoff.verification.join(" | ") : "none recorded"}\n- Blockers: ${handoff.blockers.length > 0 ? handoff.blockers.join(" | ") : "none"}\n`
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
    ? `Subagent policy for the current frontier:\n${policyLines}\n- Delegated work must reference its step number(s) and return outcome/files/verification/blockers before downstream steps proceed.\n- If multiple write-capable tasks run in parallel, prefer general-purpose background subagents with isolation: worktree and grouped fan-in.\n- Retry or escalate failed delegated work before advancing dependent steps.\n`
    : "";

  return `Execution mode is active.\n\nApproved plan file: ${relativePlanPath}\n\nReady frontier:\n${readyNow}\n\nRemaining steps:\n${checklist}\n\n${blockedBlock}${warnings}${handoffBlock}${policyBlock}Execution guidance:\n- Execute the plan by dependency frontier, not just a single active step.\n- Prefer the main agent first for obvious or tightly-coupled edits.\n- Use Explore only for discovery/evidence gathering.\n- Use Plan only when you need architecture comparison or synthesis.\n- Use general-purpose subagents for most implementation work.\n- When the ready frontier has multiple independent steps, fan out delegated work in parallel, wait for results, normalize/summarize them back into the main flow, then move to the next frontier.\n- Emit [DONE:n] markers in normal assistant messages as each numbered step completes.\n- If you already finished a step but forgot a marker, call plan_progress for that step immediately, then keep going.`;
}

export function formatApprovalSummary(planPath: string, cwd: string, artifact?: PlanArtifact): string {
  const relativePlanPath = toProjectRelative(planPath, cwd);
  const goal = artifact?.goal ?? "No goal captured yet.";
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
    ...(artifact?.validation.warnings ?? []).map((item) => `  - Warning: ${item}`),
  ];
  const issueBlock = issues.length > 0 ? `\nValidation:\n${issues.join("\n")}` : "";
  const handoff = artifact?.handoff;
  const handoffBlock = handoff ? `\nExecution handoff:\n  - Remaining steps: ${handoff.remainingSteps.join(", ") || "none"}\n  - Ready now: ${handoff.readySteps.join(", ") || "none"}\n  - Delegation guidance: ${handoff.delegationGuidance.join(" | ")}` : "";

  return `Plan summary for ${relativePlanPath}\n\nGoal:\n  ${goal}\n\nSteps:\n${steps}\n\nFiles:\n${files}\n\nBlockers:\n${blockers}\n\nVerification:\n${verification}\n\nOpen questions:\n${questions}${readyNow ? `\n\nReady frontier:\n${readyNow}` : ""}${handoffBlock}${issueBlock}`;
}
