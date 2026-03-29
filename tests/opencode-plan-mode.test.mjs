import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const utils = await jiti.import('../extensions/opencode-plan-mode/utils.ts');
const sidebar = await jiti.import('../extensions/opencode-plan-mode/sidebar.ts');

const {
  createPlanTemplate,
  deriveExecutionWarnings,
  executionInstructions,
  extractPlanArtifact,
  formatApprovalSummary,
  getExecutionFrontier,
  markCompletedSteps,
  normalizeAgentPreference,
  planInstructions,
  updateStepStatus,
} = utils;

const { getDockedSidebarLayout, renderPlanSidebar, renderPlanSidebarFallback } = sidebar;

test('plan template teaches the hardened approval contract and same-batch frontiers', () => {
  const template = createPlanTemplate('Ship the workflow redesign');
  assert.match(template, /## Success Criteria/);
  assert.match(template, /## Execution Policy/);
  assert.match(template, /## Re-review Triggers/);
  assert.match(template, /Scope:/);
  assert.match(template, /Checkpoint:/);
  assert.match(template, /Review gate:/);
  assert.match(template, /Agent: Explore/);
  assert.match(template, /Agent: general-purpose/);
  assert.match(template, /Agent: main session/);
  assert.match(template, /Batch: 2[\s\S]*Batch: 2/);
});

test('plan instructions prefer frontier-aware agent selection and the stronger contract fields', () => {
  const instructions = planInstructions('/repo/.pi/plans/example.md', '/repo', true);
  assert.match(instructions, /Choose Agent metadata deliberately instead of defaulting every step to main session/);
  assert.match(instructions, /fan-out\/fan-in explicit/);
  assert.match(instructions, /Explore and Plan stay read-only/);
  assert.match(instructions, /Scope/);
  assert.match(instructions, /Checkpoint metadata/);
  assert.match(instructions, /## Success Criteria, ## Execution Policy, ## Re-review Triggers/);
  assert.equal(normalizeAgentPreference(undefined), 'general-purpose');
});

test('extractPlanArtifact parses hardened contract sections and step metadata', () => {
  const markdown = `# Implementation Plan

## Goal
- Improve the workflow.

## Success Criteria
- The approval summary shows the operating envelope and execution contract.

## Plan
1. Inspect the current extension.
   - Agent: Explore
   - Batch: 1
   - Depends on: none
   - Scope: extensions/opencode-plan-mode/utils.ts
   - Verification: Confirm the parser hooks and validation seams.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
2. Implement the new state machine.
   - Agent: main session
   - Batch: 2
   - Depends on: 1
   - Scope: extensions/opencode-plan-mode/index.ts
   - Verification: Confirm the richer approval path and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
3. Validate the workflow.
   - Agent: Plan
   - Batch: 3
   - Depends on: 1, 2
   - Scope: extensions/opencode-plan-mode/utils.ts
   - Verification: Confirm the final contract and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: rereview_after
   - Review reason: Re-review if the execution contract shifts after validation.

## Execution Policy
- Stay inside the approved files and step scope anchors.
- Summaries must capture outcome, files, verification, blockers/risks, and unblock status.

## Re-review Triggers
- Changes outside the approved scope anchors.
- Contract edits after approval.

## Files
- extensions/opencode-plan-mode/index.ts
- extensions/opencode-plan-mode/utils.ts

## Verification
- Run the focused checks.

## Open Questions
- Should metadata stay in the plan file?
`;

  const artifact = extractPlanArtifact(markdown);
  assert.equal(artifact.goal, 'Improve the workflow.');
  assert.deepEqual(artifact.successCriteria, ['The approval summary shows the operating envelope and execution contract.']);
  assert.deepEqual(artifact.executionPolicy, [
    'Stay inside the approved files and step scope anchors.',
    'Summaries must capture outcome, files, verification, blockers/risks, and unblock status.',
  ]);
  assert.deepEqual(artifact.rereviewTriggers, [
    'Changes outside the approved scope anchors.',
    'Contract edits after approval.',
  ]);
  assert.deepEqual(artifact.files, [
    'extensions/opencode-plan-mode/index.ts',
    'extensions/opencode-plan-mode/utils.ts',
  ]);
  assert.deepEqual(artifact.openQuestions, ['Should metadata stay in the plan file?']);
  assert.equal(artifact.steps.length, 3);
  assert.deepEqual(artifact.steps[0], {
    step: 1,
    text: 'Inspect the current extension.',
    agent: 'Explore',
    batch: 1,
    dependsOn: [],
    scope: ['extensions/opencode-plan-mode/utils.ts'],
    verification: 'Confirm the parser hooks and validation seams.',
    rationale: undefined,
    blockers: undefined,
    checkpoint: ['outcome', 'files', 'verification', 'blockers/risks', 'unblock status'],
    reviewGate: undefined,
    reviewReason: undefined,
    status: 'pending',
    completed: false,
    note: undefined,
  });
  assert.deepEqual(artifact.steps[2].dependsOn, [1, 2]);
  assert.equal(artifact.steps[2].reviewGate, 'rereview_after');
  assert.match(artifact.steps[2].reviewReason, /execution contract shifts/);
  assert.equal(artifact.validation.errors.length, 0);
  assert.equal(artifact.validation.blocking.length, 0);
});

test('invalid numbering is rejected during artifact validation', () => {
  const markdown = `# Implementation Plan

## Plan
2. Second comes first.
1. First comes second.
1. Duplicate step.
   - Depends on: 3
`;

  const artifact = extractPlanArtifact(markdown);
  assert.ok(artifact.validation.errors.some((error) => error.includes('increase strictly')));
  assert.ok(artifact.validation.errors.some((error) => error.includes('appears more than once')));
});

test('artifact validation promotes missing contract fields into approval blockers', () => {
  const artifact = extractPlanArtifact(`## Goal
- Ship the redesign.

## Context
- Update the workflow state machine.

## Plan
1. Check things.
   - Agent: main session
   - Batch: 1
   - Depends on: none
2. Implement the scheduler.
   - Agent: main session
   - Batch: 2
   - Depends on: 1

## Files
- extensions/opencode-plan-mode/index.ts
`);

  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('vague')));
  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('verified')));
  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('Success Criteria')));
  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('Execution Policy')));
  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('Re-review Triggers')));
  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('Scope metadata')));
});

test('step scope anchors must stay within top-level file anchors', () => {
  const artifact = extractPlanArtifact(`## Goal
- Keep scope explicit.

## Success Criteria
- Approval rejects out-of-scope step anchors.

## Plan
1. Patch the wrong place.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Scope: tests/opencode-plan-mode.test.mjs
   - Verification: Confirm the blocked scope anchor.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status

## Execution Policy
- Stay within the approved file anchors.

## Re-review Triggers
- Scope changes after approval.

## Files
- extensions/opencode-plan-mode/index.ts

## Verification
- Run focused checks.
`);

  assert.ok(artifact.validation.blocking.some((warning) => warning.includes('outside ## Files')));
});

test('execution frontier groups same-batch ready steps and carries the richer handoff fields', () => {
  const artifact = extractPlanArtifact(`## Goal
- Parallelize execution.

## Context
- Ready work should fan out by batch.

## Success Criteria
- The same-batch frontier is explicit and approval captures the operating envelope.

## Plan
1. Implement step one.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Scope: extensions/opencode-plan-mode/index.ts
   - Verification: Record touched files and validation.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
2. Implement step two.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Scope: tests/opencode-plan-mode.test.mjs
   - Verification: Record touched files and validation.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
3. Synthesize the fan-in.
   - Agent: main session
   - Batch: 2
   - Depends on: 1, 2
   - Scope: extensions/opencode-plan-mode/index.ts, tests/opencode-plan-mode.test.mjs
   - Verification: Confirm the merged result and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: pause_after
   - Review reason: Pause after fan-in before wider execution continues.

## Execution Policy
- Stay inside the approved files and scope anchors.
- Summaries must capture outcome, files, verification, blockers/risks, and unblock status.

## Re-review Triggers
- Scope changes after approval.
- Destructive or dependency-changing work.

## Files
- extensions/opencode-plan-mode/index.ts
- tests/opencode-plan-mode.test.mjs

## Verification
- Run the focused checks.
`);

  const frontier = getExecutionFrontier(artifact.steps);
  assert.deepEqual(frontier.map((step) => step.step), [1, 2]);
  assert.equal(artifact.handoff.readySteps.join(','), '1,2');
  assert.match(artifact.handoff.successCriteria.join(' | '), /operating envelope/);
  assert.match(artifact.handoff.scopeAnchors.join(' | '), /extensions\/opencode-plan-mode\/index.ts/);
  assert.match(artifact.handoff.pauseConditions.join(' | '), /Scope changes after approval/);
  assert.match(artifact.handoff.checkpointContract.join(' | '), /unblock status/);
});

test('missing DONE markers fall back to natural language detection with warning', () => {
  const artifact = extractPlanArtifact(`## Plan
1. Redesign the state machine.
2. Validate the workflow.
`);
  const result = markCompletedSteps('Completed step 1 and step 2 is done.', artifact.steps);

  assert.equal(result.count, 2);
  assert.equal(result.source, 'natural_language');
  assert.ok(result.warnings.some((warning) => warning.includes('Prefer explicit [DONE:n] markers')));
  assert.deepEqual(artifact.steps.map((step) => step.completed), [true, true]);
});

test('plan_progress style updates preserve warnings for dependency violations', () => {
  const artifact = extractPlanArtifact(`## Plan
1. Lay the groundwork.
2. Finish the feature.
   - Depends on: 1
`);
  const result = updateStepStatus(artifact.steps, 2, 'completed', 'Forced complete for recovery test');

  assert.equal(result.updated, true);
  assert.ok(result.warnings.some((warning) => warning.includes('dependency 1')));
  assert.equal(artifact.steps[1].completed, true);
  assert.equal(artifact.steps[1].status, 'completed');
});

test('execution warnings detect plan drift after approval', () => {
  const approved = extractPlanArtifact(`## Plan
1. Original first step.
2. Original second step.
`);
  const edited = extractPlanArtifact(`## Plan
1. Original first step.
2. Changed second step.
`);

  const warnings = deriveExecutionWarnings(edited, approved.signature, []);
  assert.ok(warnings.some((warning) => warning.includes('changed after approval')));
});

test('execution instructions reflect the richer handoff contract and frontier guidance', () => {
  const artifact = extractPlanArtifact(`## Goal
- Execute safely.

## Success Criteria
- The handoff exposes success criteria, scope anchors, pause conditions, and checkpoint expectations.

## Plan
1. Implement slice one.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Scope: extensions/opencode-plan-mode/index.ts
   - Verification: Confirm files, verification, and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
2. Implement slice two.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Scope: tests/opencode-plan-mode.test.mjs
   - Verification: Confirm files, verification, and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
3. Validate the result.
   - Agent: main session
   - Batch: 2
   - Depends on: 1, 2
   - Scope: extensions/opencode-plan-mode/index.ts, tests/opencode-plan-mode.test.mjs
   - Verification: Confirm the final verification and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: pause_after
   - Review reason: Pause for explicit human review before wider rollout.

## Execution Policy
- Stay inside the approved files and scope anchors.
- Summaries must capture outcome, files, verification, blockers/risks, and unblock status.

## Re-review Triggers
- Scope changes after approval.
- Destructive or dependency-changing work.

## Files
- extensions/opencode-plan-mode/index.ts
- tests/opencode-plan-mode.test.mjs

## Verification
- Run focused checks.
`);
  const instructions = executionInstructions('/repo/.pi/plans/example.md', '/repo', artifact);

  assert.match(instructions, /Success criteria:/);
  assert.match(instructions, /Scope anchors:/);
  assert.match(instructions, /Pause conditions:/);
  assert.match(instructions, /Checkpoint contract:/);
  assert.match(instructions, /Start from the current ready frontier/);
  assert.match(instructions, /multiple independent steps in the same batch/);
  assert.match(instructions, /Use main session for tightly-coupled edits/);
  assert.match(instructions, /Use general-purpose subagents for most implementation work/);
  assert.match(instructions, /planning\/synthesis stays read-only/);
  assert.match(instructions, /call plan_progress/);
  assert.match(instructions, /unblock status/);
});

test('approval summary includes the operating envelope and validation blockers', () => {
  const artifact = extractPlanArtifact(`## Goal
- Ship the redesign.

## Success Criteria
- The approval summary exposes the done contract without hiding the transcript.

## Plan
1. Build it.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Scope: extensions/opencode-plan-mode/index.ts
   - Verification: Confirm the touched files and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: rereview_after
   - Review reason: Re-review if the plan contract changes.

## Execution Policy
- Stay inside the approved file anchors.

## Re-review Triggers
- Contract edits after approval.

## Files
- extensions/opencode-plan-mode/index.ts

## Verification
- Run focused checks.

## Open Questions
- Do we need a sidecar file?
`);
  const summary = formatApprovalSummary('/repo/.pi/plans/example.md', '/repo', artifact);

  assert.match(summary, /Ship the redesign/);
  assert.match(summary, /Success criteria:/);
  assert.match(summary, /Execution policy:/);
  assert.match(summary, /Re-review triggers:/);
  assert.match(summary, /review gate: rereview_after/);
  assert.match(summary, /Scope anchors:/);
  assert.match(summary, /Pause conditions:/);
  assert.match(summary, /extensions\/opencode-plan-mode\/index.ts/);
  assert.match(summary, /Do we need a sidecar file/);
});

test('wide terminals keep the workflow rail constrained and transcript-first', () => {
  const artifact = extractPlanArtifact(`## Goal
- Keep chat primary.

## Plan
1. Active step.
2. Follow-up step.
   - Depends on: 1
3. Final verification.
   - Depends on: 2
`);
  artifact.steps[0].status = 'in_progress';

  const model = {
    mode: 'executing',
    planPath: './.pi/plans/example.md',
    goal: artifact.goal,
    steps: artifact.steps,
    approval: undefined,
    execution: { completedSteps: [], activeStep: 1, warnings: [], lastProgressSource: 'tool' },
    blockers: [],
    openQuestions: [],
    nextAction: 'Finish step 1.',
    subagents: [],
    toggleHint: '/plan sidebar',
  };

  const layout = getDockedSidebarLayout(140, model);
  assert.ok(layout);
  assert.ok(layout.sidebarWidth <= 42);
  assert.ok(layout.sidebarWidth >= 30);
  assert.ok(layout.editorWidth > layout.sidebarWidth * 2);
});

test('workflow rail aggressively summarizes warnings, subagents, and step overflow', () => {
  const artifact = extractPlanArtifact(`## Goal
- Keep progress glanceable.

## Plan
1. Active step.
2. Second step.
   - Depends on: 1
3. Third step.
   - Depends on: 2
4. Fourth step.
   - Depends on: 3
5. Fifth step.
   - Depends on: 4
`);
  artifact.steps[0].status = 'in_progress';
  artifact.steps[4].note = 'Hidden note';

  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
  };

  const model = {
    mode: 'executing',
    planPath: './.pi/plans/example.md',
    goal: artifact.goal,
    steps: artifact.steps,
    approval: undefined,
    execution: {
      completedSteps: [],
      activeStep: 1,
      warnings: ['First warning', 'Second warning', 'Third warning'],
      lastProgressSource: 'tool',
    },
    blockers: ['Blocked by API review', 'Blocked by release timing'],
    openQuestions: ['Should we compact more?', 'Should we expose a toggle?'],
    nextAction: 'Finish step 1.',
    subagents: [
      { id: 'a', type: 'Explore', description: 'Inspect repo', status: 'running', startedAt: 1 },
      { id: 'b', type: 'general-purpose', description: 'Implement patch', status: 'completed', startedAt: 2, completedAt: 3 },
      { id: 'c', type: 'Plan', description: 'Draft validation', status: 'queued', startedAt: 4 },
    ],
    toggleHint: '/plan sidebar',
  };

  const lines = renderPlanSidebar(model, theme, 36).join('\n');
  assert.match(lines, /\+2 more warnings/);
  assert.match(lines, /\+1 more subagents/);
  assert.match(lines, /\+2 more steps/);
  assert.match(lines, /1 blocker\(s\)|2 blocker\(s\)/);
  assert.doesNotMatch(lines, /5\. Fifth step\./);
});

test('sidebar fan-in distinguishes no delegation, blocked delegation, and historical delegation', () => {
  const artifact = extractPlanArtifact(`## Plan
1. Active step.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
2. Historical step.
   - Agent: general-purpose
   - Batch: 2
   - Depends on: 1
`);
  artifact.steps[0].status = 'in_progress';
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
  };

  const baseModel = {
    mode: 'executing',
    planPath: './.pi/plans/example.md',
    goal: artifact.goal,
    steps: artifact.steps,
    approval: undefined,
    execution: { completedSteps: [], activeStep: 1, frontierStepNumbers: [1], frontierBatch: 1, warnings: [], lastProgressSource: 'tool' },
    blockers: [],
    openQuestions: [],
    nextAction: 'Finish step 1.',
    subagents: [],
    toggleHint: '/plan sidebar',
  };

  const noDelegation = renderPlanSidebarFallback(baseModel, theme, 80).join('\n');
  assert.match(noDelegation, /no delegation yet/);

  const blockedDelegation = renderPlanSidebarFallback({
    ...baseModel,
    execution: {
      ...baseModel.execution,
      lastDelegation: { status: 'blocked', reason: 'missing step reference', stepNumbers: [], recordedAt: '2026-03-23T00:00:00.000Z' },
    },
  }, theme, 80).join('\n');
  assert.match(blockedDelegation, /delegation blocked/);

  const historicalDelegation = renderPlanSidebarFallback({
    ...baseModel,
    subagents: [{ id: 'a', type: 'general-purpose', description: 'Finished historical step', status: 'completed', startedAt: 1, completedAt: 2, stepNumbers: [2] }],
  }, theme, 80).join('\n');
  assert.match(historicalDelegation, /history only/);
});

test('narrow terminals fall back to a compact workflow summary', () => {
  const artifact = extractPlanArtifact(`## Goal
- Keep status visible.

## Plan
1. Active step.
2. Follow-up step.
   - Depends on: 1
`);
  artifact.steps[0].status = 'in_progress';

  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
  };

  const model = {
    mode: 'executing',
    planPath: './.pi/plans/example.md',
    goal: artifact.goal,
    steps: artifact.steps,
    approval: undefined,
    execution: { completedSteps: [], activeStep: 1, warnings: ['One warning'], lastProgressSource: 'tool' },
    blockers: [],
    openQuestions: [],
    nextAction: 'Finish step 1.',
    subagents: [{ id: 'a', type: 'Explore', description: 'Inspect repo', status: 'running', startedAt: 1 }],
    toggleHint: '/plan sidebar',
  };

  assert.equal(getDockedSidebarLayout(80, model), undefined);
  const lines = renderPlanSidebarFallback(model, theme, 80);
  assert.ok(lines.some((line) => line.includes('PLAN')));
  assert.ok(lines.some((line) => line.includes('Finish step 1.')));
  assert.ok(lines.some((line) => line.includes('Warnings: 1')));
  assert.ok(lines.some((line) => line.includes('Agents:')));
});
