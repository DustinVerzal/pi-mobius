import { access } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

export type PlanMode = "normal" | "planning" | "executing";

export interface PlanStep {
  step: number;
  text: string;
  completed: boolean;
}

export interface PlanState {
  mode: PlanMode;
  planPath?: string;
  previousActiveTools?: string[];
  panelVisible: boolean;
  steps: PlanStep[];
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
  return `# Implementation Plan\n\n## Goal\n${goalLine}\n## Context\n- Summarize the relevant code paths, architecture, and constraints.\n- Capture any user decisions or open questions.\n\n## Plan\n1. Investigate the relevant code paths and confirm scope.\n   - Agent: Explore\n   - Batch: 1\n   - Depends on: none\n2. Describe the implementation changes and files to modify.\n   - Agent: Explore\n   - Batch: 2\n   - Depends on: 1\n3. Outline validation steps and edge cases to verify.\n   - Agent: Explore\n   - Batch: 3\n   - Depends on: 1, 2\n\n## Files\n- path/to/file\n\n## Verification\n- Run focused checks and relevant tests.\n- Validate the end-to-end behavior after implementation.\n`;
}

export function cleanStepText(text: string): string {
  return text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlanSection(markdown: string): string {
  const match = markdown.match(/^##\s+Plan\s*$/im) ?? markdown.match(/^Plan:\s*$/im);
  if (!match || match.index === undefined) return markdown;
  return markdown.slice(match.index + match[0].length);
}

export function extractPlanSteps(markdown: string): PlanStep[] {
  const section = getPlanSection(markdown);
  const items: PlanStep[] = [];
  const pattern = /^\s*(\d+)[.)]\s+(.+)$/gm;
  for (const match of section.matchAll(pattern)) {
    const text = cleanStepText(match[2] ?? "");
    if (!text) continue;
    items.push({
      step: Number(match[1]),
      text,
      completed: false,
    });
  }
  return items;
}

export function extractDoneSteps(text: string): number[] {
  const steps = new Set<number>();
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.add(step);
  }
  return [...steps].sort((a, b) => a - b);
}

export function markCompletedSteps(text: string, steps: PlanStep[]): number {
  let completed = 0;
  const doneSteps = new Set(extractDoneSteps(text));
  for (const step of steps) {
    if (doneSteps.has(step.step) && !step.completed) {
      step.completed = true;
      completed += 1;
    }
  }
  return completed;
}

export function isSafeReadOnlyCommand(command: string): boolean {
  const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
  const safe = SAFE_READONLY_PATTERNS.some((pattern) => pattern.test(command));
  return safe && !destructive;
}

export function stripPlanOnlyTools(names: string[]): string[] {
  return names.filter((name) => name !== "question" && name !== "plan_exit");
}

export function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

export function formatPlanStatus(planPath: string | undefined, cwd: string, mode: PlanMode, panelVisible: boolean): string {
  const location = planPath ? toProjectRelative(planPath, cwd) : "(not created yet)";
  return `Plan mode: ${mode}\nPlan file: ${location}\nSidebar: ${panelVisible ? "visible" : "hidden"}`;
}

export function planInstructions(planPath: string, cwd: string, hasSubagentTool: boolean): string {
  const relativePlanPath = toProjectRelative(planPath, cwd);
  const subagentNote = hasSubagentTool
    ? "- If you delegate research to subagents, use read-only subagent types such as Explore or Plan only.\n"
    : "";
  return `You are in plan mode.\n\nRules:\n- Read and inspect freely.\n- Only modify the plan file at ${relativePlanPath}.\n- Do not edit any other file.\n- Use read-only bash commands only.\n${subagentNote}\nWrite the approved plan into ${relativePlanPath}.\nWhen the plan is ready for approval, call the plan_exit tool.\nUse [DONE:n] markers only after execution starts, not while planning.`;
}

export function executionInstructions(planPath: string, cwd: string, steps: PlanStep[]): string {
  const relativePlanPath = toProjectRelative(planPath, cwd);
  const remaining = steps.filter((step) => !step.completed);
  const checklist = remaining.length > 0 ? remaining.map((step) => `${step.step}. ${step.text}`).join("\n") : "- No remaining steps recorded.";
  return `Execution mode is active.\n\nApproved plan file: ${relativePlanPath}\n\nRemaining steps:\n${checklist}\n\nExecute the work in dependency order and emit [DONE:n] markers in normal assistant messages as each numbered step completes.`;
}
