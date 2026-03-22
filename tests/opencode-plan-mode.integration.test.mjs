import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const utils = await jiti.import('../extensions/opencode-plan-mode/utils.ts');
const opencodePlanModeModule = await jiti.import('../extensions/opencode-plan-mode/index.ts');
const opencodePlanMode = opencodePlanModeModule.default ?? opencodePlanModeModule;

const { extractPlanArtifact } = utils;

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function latestState(branch) {
  const entries = branch.filter((entry) => entry.type === 'custom' && entry.customType === 'opencode-plan-state');
  return entries.at(-1)?.data;
}

function createFakePi(branch) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const subagentHandlers = new Map();
  const flags = new Map();
  const sentMessages = [];
  let activeTools = ['read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent'];

  return {
    commands,
    tools,
    handlers,
    subagentHandlers,
    sentMessages,
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut() {},
    registerFlag(name, def) {
      flags.set(name, def.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
    setFlag(name, value) {
      flags.set(name, value);
    },
    getAllTools() {
      return [...new Set([...activeTools, ...tools.keys()])].map((name) => ({ name }));
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
    appendEntry(customType, data) {
      branch.push({ type: 'custom', customType, data });
    },
    sendUserMessage(text, options) {
      sentMessages.push({ text, options });
      branch.push({
        type: 'message',
        message: { role: 'user', content: text },
      });
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    async emit(name, event, ctx) {
      const handler = handlers.get(name);
      return handler ? handler(event, ctx) : undefined;
    },
    events: {
      on(name, handler) {
        subagentHandlers.set(name, handler);
      },
    },
    emitSubagent(name, data) {
      const handler = subagentHandlers.get(name);
      if (handler) handler(data);
    },
  };
}

function createCtx({ cwd, branch, selectResponses = [], editorResponses = [], inputResponses = [], newSessionCancelled = false }) {
  const ui = {
    theme: { fg: (_color, text) => text },
    notifications: [],
    statuses: [],
    selectCalls: [],
    editorText: '',
    setStatus(key, value) {
      this.statuses.push({ key, value });
    },
    notify(message, level) {
      this.notifications.push({ message, level });
    },
    setEditorText(text) {
      this.editorText = text;
    },
    setEditorComponent() {},
    async select(message, options) {
      this.selectCalls.push({ message, options });
      return selectResponses.shift();
    },
    async editor() {
      return editorResponses.shift();
    },
    async input() {
      return inputResponses.shift();
    },
  };

  const ctx = {
    cwd,
    hasUI: true,
    ui,
    sessionManager: {
      getSessionFile: () => join(cwd, 'session.jsonl'),
      getBranch: () => branch,
    },
    newSessionCalls: [],
    async newSession(options) {
      this.newSessionCalls.push(options);
      return { cancelled: newSessionCancelled };
    },
    isIdle: () => true,
    waitForIdle: async () => {},
  };

  return ctx;
}

async function setupExtension({ branch = [], cwd } = {}) {
  const workingDir = cwd ?? await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const effectiveBranch = branch;
  const pi = createFakePi(effectiveBranch);
  opencodePlanMode(pi);
  const ctx = createCtx({ cwd: workingDir, branch: effectiveBranch });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();
  return { cwd: workingDir, branch: effectiveBranch, pi, ctx };
}

test('planning mode injects stronger plan instructions and keeps authoring guardrails', async () => {
  const { pi, ctx } = await setupExtension();

  await pi.commands.get('plan').handler('', ctx);
  await flushMicrotasks();

  const beforeStart = await pi.emit('before_agent_start', {}, ctx);
  assert.match(beforeStart.message.content, /Every step should state a real deliverable/);
  assert.match(beforeStart.message.content, /Use Batch to mark the concurrency frontier/);

  const blockedBash = await pi.emit('tool_call', { toolName: 'bash', input: { command: 'rm -rf tmp' } }, ctx);
  assert.equal(blockedBash.block, true);
  assert.match(blockedBash.reason, /read-only bash commands/);

  const blockedSubagent = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: { subagent_type: 'general-purpose' },
  }, ctx);
  assert.equal(blockedSubagent.block, true);
  assert.match(blockedSubagent.reason, /read-only subagent types/);
});

test('execution mode exposes frontier orchestration and enforces delegated-work policy', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const markdown = `## Goal
- Parallelize execution safely.

## Context
- Frontier work should fan out before fan-in.

## Plan
1. Implement step one.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Verification: Report files, verification, and blockers.
2. Implement step two.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Verification: Report files, verification, and blockers.
3. Synthesize the results.
   - Agent: main session
   - Batch: 2
   - Depends on: 1, 2
   - Verification: Confirm merged files, verification, and blockers.

## Files
- extensions/opencode-plan-mode/index.ts

## Verification
- Run focused checks.
`;
  await writeFile(planPath, markdown, 'utf8');
  const artifact = extractPlanArtifact(markdown);
  const approval = {
    approvedAt: '2026-03-22T00:00:00.000Z',
    approvedSignature: artifact.signature,
    validation: artifact.validation,
    handoff: artifact.handoff,
    summary: 'approved',
  };
  const branch = [
    {
      type: 'custom',
      customType: 'opencode-plan-state',
      data: {
        mode: 'executing',
        planPath,
        panelVisible: true,
        artifact,
        approval,
        execution: {
          completedSteps: [],
          readySteps: [],
          frontierStepNumbers: [],
          frontierBatch: undefined,
          blockedSteps: [],
          warnings: [],
        },
        subagents: [],
      },
    },
    { type: 'custom', customType: 'opencode-plan-execute', data: { artifact, approval } },
  ];
  const { pi, ctx } = await setupExtension({ branch, cwd });

  const beforeStart = await pi.emit('before_agent_start', {}, ctx);
  assert.match(beforeStart.message.content, /Ready frontier:/);
  assert.match(beforeStart.message.content, /Subagent policy for the current frontier/);

  const missingStepRef = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: {
      description: 'Implement patch',
      prompt: 'Return files, verification, and blockers.',
      subagent_type: 'general-purpose',
      run_in_background: true,
      isolation: 'worktree',
      join_mode: 'group',
    },
  }, ctx);
  assert.equal(missingStepRef.block, true);
  assert.match(missingStepRef.reason, /reference a numbered plan step/);

  const missingIsolation = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: {
      description: 'Implement step 1',
      prompt: 'Work on step 1. Return files, verification, and blockers.',
      subagent_type: 'general-purpose',
      run_in_background: true,
      join_mode: 'group',
    },
  }, ctx);
  assert.equal(missingIsolation.block, true);
  assert.match(missingIsolation.reason, /isolation: worktree/);

  const allowed = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: {
      description: 'Implement step 1',
      prompt: 'Work on step 1. Return files touched, verification performed, and blockers or risks.',
      subagent_type: 'general-purpose',
      run_in_background: true,
      isolation: 'worktree',
      join_mode: 'group',
    },
  }, ctx);
  assert.equal(allowed, undefined);

  pi.emitSubagent('subagents:created', { id: 'agent-1', type: 'general-purpose', description: 'Step 1 implement patch', isBackground: true });
  pi.emitSubagent('subagents:started', { id: 'agent-1', type: 'general-purpose', description: 'Step 1 implement patch' });
  pi.emitSubagent('subagents:completed', { id: 'agent-1', type: 'general-purpose', description: 'Step 1 implement patch', toolUses: 3, durationMs: 1200 });
  await pi.emit('tool_result', {
    toolName: 'get_subagent_result',
    input: { agent_id: 'agent-1' },
    output: {
      content: [{ type: 'text', text: 'Outcome: patched workflow. Files: index.ts. Verification: focused test passed. Blockers: none.' }],
    },
  }, ctx);
  await flushMicrotasks();

  const state = latestState(branch);
  assert.deepEqual(state.subagents[0].stepNumbers, [1]);
  assert.match(state.subagents[0].normalizedSummary, /Files:/);
  assert.equal(state.subagents[0].status, 'completed');
});

test('approved execution start requires explicit override when the plan drifts after approval', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });

  const original = `## Goal
- Execute safely.

## Context
- Keep approval explicit.

## Plan
1. Original first step.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Verification: Confirm the changed file and blockers.
2. Original second step.
   - Agent: main session
   - Batch: 2
   - Depends on: 1
   - Verification: Confirm the final verification.

## Files
- extensions/opencode-plan-mode/index.ts

## Verification
- Run focused checks.
`;
  const edited = original.replace('Original second step.', 'Changed second step.');
  await writeFile(planPath, edited, 'utf8');

  const approvedArtifact = extractPlanArtifact(original);
  const branch = [
    {
      type: 'custom',
      customType: 'opencode-plan-state',
      data: {
        mode: 'approved_waiting_execution',
        planPath,
        panelVisible: true,
        artifact: approvedArtifact,
        approval: {
          approvedAt: '2026-03-22T00:00:00.000Z',
          approvedSignature: approvedArtifact.signature,
          validation: approvedArtifact.validation,
          handoff: approvedArtifact.handoff,
          summary: 'approved',
        },
        execution: {
          completedSteps: [],
          readySteps: [],
          frontierStepNumbers: [],
          frontierBatch: undefined,
          blockedSteps: [],
          warnings: [],
        },
        subagents: [],
      },
    },
  ];
  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const ctx = createCtx({ cwd, branch, selectResponses: ['Cancel'] });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  await pi.commands.get('plan').handler('start', ctx);
  await flushMicrotasks();

  assert.equal(ctx.newSessionCalls.length, 0);
  assert.match(ctx.ui.selectCalls[0].message, /changed after approval|contract changed/i);
});

test('override path starts fresh execution with the richer handoff packet', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });

  const original = `## Goal
- Execute safely.

## Context
- Keep approval explicit.

## Plan
1. Original first step.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Verification: Confirm files, verification, and blockers.
2. Original second step.
   - Agent: main session
   - Batch: 2
   - Depends on: 1
   - Verification: Confirm the final verification and blockers.

## Files
- extensions/opencode-plan-mode/index.ts

## Verification
- Run focused checks.
`;
  const edited = original.replace('Original second step.', 'Changed second step.');
  await writeFile(planPath, edited, 'utf8');

  const approvedArtifact = extractPlanArtifact(original);
  const branch = [
    {
      type: 'custom',
      customType: 'opencode-plan-state',
      data: {
        mode: 'approved_waiting_execution',
        planPath,
        panelVisible: true,
        artifact: approvedArtifact,
        approval: {
          approvedAt: '2026-03-22T00:00:00.000Z',
          approvedSignature: approvedArtifact.signature,
          validation: approvedArtifact.validation,
          handoff: approvedArtifact.handoff,
          summary: 'approved',
        },
        execution: {
          completedSteps: [],
          readySteps: [],
          frontierStepNumbers: [],
          frontierBatch: undefined,
          blockedSteps: [],
          warnings: [],
        },
        subagents: [],
      },
    },
  ];
  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const ctx = createCtx({ cwd, branch, selectResponses: ['Override and start execution'] });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  await pi.commands.get('plan').handler('start', ctx);
  await flushMicrotasks();

  assert.equal(ctx.newSessionCalls.length, 1);
  assert.match(pi.sentMessages.at(-1).text, /Ready frontier:/);
  assert.match(pi.sentMessages.at(-1).text, /Delegation guidance:/);
  assert.equal(latestState(branch).mode, 'executing');
});
