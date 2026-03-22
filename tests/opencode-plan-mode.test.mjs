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
  updateStepStatus,
} = utils;

const { getDockedSidebarLayout, renderPlanSidebar, renderPlanSidebarFallback } = sidebar;

test('plan template defaults to main-session metadata', () => {
  const template = createPlanTemplate('Ship the workflow redesign');
  assert.match(template, /Agent: main session/);
  assert.doesNotMatch(template, /Agent: Explore/);
});

test('extractPlanArtifact parses step metadata and sections', () => {
  const markdown = `# Implementation Plan

## Goal
- Improve the workflow.

## Plan
1. Inspect the current extension.
   - Agent: Explore
   - Batch: 1
   - Depends on: none
2. Implement the new state machine.
   - Agent: main session
   - Batch: 2
   - Depends on: 1
3. Validate the workflow.
   - Agent: Plan
   - Batch: 3
   - Depends on: 1, 2

## Files
- extensions/opencode-plan-mode/index.ts
- extensions/opencode-plan-mode/utils.ts

## Open Questions
- Should metadata stay in the plan file?
`;

  const artifact = extractPlanArtifact(markdown);
  assert.equal(artifact.goal, 'Improve the workflow.');
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
    verification: undefined,
    rationale: undefined,
    blockers: undefined,
    status: 'pending',
    completed: false,
    note: undefined,
  });
  assert.deepEqual(artifact.steps[2].dependsOn, [1, 2]);
  assert.equal(artifact.validation.errors.length, 0);
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

test('artifact validation warns about vague steps and missing verification intent', () => {
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

  assert.ok(artifact.validation.warnings.some((warning) => warning.includes('vague')));
  assert.ok(artifact.validation.warnings.some((warning) => warning.includes('verified')));
});

test('execution frontier groups same-batch ready steps', () => {
  const artifact = extractPlanArtifact(`## Goal
- Parallelize execution.

## Context
- Ready work should fan out by batch.

## Plan
1. Implement step one.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Verification: Record touched files and validation.
2. Implement step two.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Verification: Record touched files and validation.
3. Synthesize the fan-in.
   - Agent: main session
   - Batch: 2
   - Depends on: 1, 2
   - Verification: Confirm the merged result and blockers.

## Files
- extensions/opencode-plan-mode/index.ts

## Verification
- Run the focused checks.
`);

  const frontier = getExecutionFrontier(artifact.steps);
  assert.deepEqual(frontier.map((step) => step.step), [1, 2]);
  assert.equal(artifact.handoff.readySteps.join(','), '1,2');
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

test('execution instructions reflect updated subagent guidance and recovery path', () => {
  const artifact = extractPlanArtifact(`## Plan
1. Implement the change.
   - Agent: main session
2. Validate the result.
   - Depends on: 1
`);
  const instructions = executionInstructions('/repo/.pi/plans/example.md', '/repo', artifact);

  assert.match(instructions, /Use general-purpose subagents for most implementation work/);
  assert.match(instructions, /Use Explore only for discovery\/evidence gathering/);
  assert.match(instructions, /call plan_progress/);
});

test('approval summary includes goal, steps, files, and open questions', () => {
  const artifact = extractPlanArtifact(`## Goal
- Ship the redesign.

## Plan
1. Build it.

## Files
- extensions/opencode-plan-mode/index.ts

## Open Questions
- Do we need a sidecar file?
`);
  const summary = formatApprovalSummary('/repo/.pi/plans/example.md', '/repo', artifact);

  assert.match(summary, /Ship the redesign/);
  assert.match(summary, /1\. Build it/);
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
