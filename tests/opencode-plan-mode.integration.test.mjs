import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const utils = await jiti.import('../extensions/opencode-plan-mode/utils.ts');
const opencodePlanModeModule = await jiti.import('../extensions/opencode-plan-mode/index.ts');
const { convertResponsesMessages } = await import('../node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js');
const opencodePlanMode = opencodePlanModeModule.default ?? opencodePlanModeModule;

const { extractPlanArtifact } = utils;

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function latestState(branch) {
  const entries = branch.filter((entry) => entry.type === 'custom' && entry.customType === 'opencode-plan-state');
  return entries.at(-1)?.data;
}

function resolveRef(ref) {
  return typeof ref === 'function' ? ref() : ref;
}

function createFakePi(branchRef, sessionFileRef = undefined) {
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
      resolveRef(branchRef).push({ type: 'custom', customType, data });
    },
    sendUserMessage(text, options) {
      sentMessages.push({ text, options, sessionFile: resolveRef(sessionFileRef) });
      resolveRef(branchRef).push({
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

function createCtx({
  cwd,
  branch,
  sessionFile = join(cwd, 'session.jsonl'),
  selectResponses = [],
  customResponses = [],
  editorResponses = [],
  inputResponses = [],
  newSessionCancelled = false,
  newSessionImpl,
  waitForIdleImpl,
} = {}) {
  const ui = {
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
    },
    notifications: [],
    statuses: [],
    widgets: [],
    selectCalls: [],
    customCalls: [],
    editorText: '',
    setStatus(key, value) {
      this.statuses.push({ key, value });
    },
    setWidget(key, content, options) {
      this.widgets.push({ key, content, options });
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
    async custom(factory, options) {
      this.customCalls.push({ factory, options });
      return customResponses.shift();
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
      getSessionFile: () => resolveRef(sessionFile),
      getBranch: () => resolveRef(branch),
    },
    newSessionCalls: [],
    async newSession(options) {
      this.newSessionCalls.push(options);
      if (newSessionImpl) {
        return newSessionImpl.call(this, options);
      }
      if (!newSessionCancelled && options?.setup) {
        await options.setup({
          getSessionFile: () => resolveRef(sessionFile),
          getCwd: () => cwd,
          appendCustomEntry(customType, data) {
            resolveRef(branch).push({ type: 'custom', customType, data });
          },
          appendMessage(message) {
            resolveRef(branch).push({ type: 'message', message });
          },
        });
      }
      return { cancelled: newSessionCancelled };
    },
    isIdle: () => true,
    waitForIdle: async () => {
      if (waitForIdleImpl) {
        await waitForIdleImpl.call(this);
      }
    },
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

function createAssistantToolCallMessage(toolName, toolCallId, argumentsPayload = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: argumentsPayload }],
    api: 'responses',
    provider: 'openai',
    model: 'gpt-5',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

function createAssistantTextMessage(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'responses',
    provider: 'openai',
    model: 'gpt-5',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function createToolResultMessage(toolName, toolCallId, result) {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  };
}

function messageEntries(branch) {
  return branch.filter((entry) => entry.type === 'message').map((entry) => entry.message);
}

function findUnmatchedFunctionCallOutputs(messages) {
  const functionCalls = new Set(messages.filter((message) => message.type === 'function_call').map((message) => message.call_id));
  return messages
    .filter((message) => message.type === 'function_call_output' && !functionCalls.has(message.call_id))
    .map((message) => message.call_id);
}

function createResponsesReplayModel() {
  return {
    id: 'gpt-5',
    provider: 'openai',
    api: 'responses',
    reasoning: false,
    input: ['text'],
  };
}

function createHardenedPlanMarkdown({
  goal = 'Execute safely.',
  successCriteria = ['Ship the approved behavior without widening scope unexpectedly.'],
  executionPolicy = [
    'Stay inside the approved file and step scope anchors.',
    'Summaries must capture outcome, files, verification, blockers/risks, and unblock status.',
  ],
  rereviewTriggers = [
    'Scope changes after approval.',
    'Destructive or dependency-changing work.',
  ],
  files = ['extensions/opencode-plan-mode/index.ts', 'tests/opencode-plan-mode.integration.test.mjs'],
  verification = ['Run focused checks.'],
  stepOneText = 'Implement the first slice.',
  stepTwoText = 'Validate the result.',
  stepTwoReviewGate = 'pause_after',
  stepTwoReviewReason = 'Pause before downstream work continues.',
} = {}) {
  const successBlock = successCriteria.map((item) => `- ${item}`).join('\n');
  const policyBlock = executionPolicy.map((item) => `- ${item}`).join('\n');
  const rereviewBlock = rereviewTriggers.map((item) => `- ${item}`).join('\n');
  const filesBlock = files.map((item) => `- ${item}`).join('\n');
  const verificationBlock = verification.map((item) => `- ${item}`).join('\n');

  return `## Goal
- ${goal}

## Context
- Keep approval explicit.

## Success Criteria
${successBlock}

## Plan
1. ${stepOneText}
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Scope: ${files[0]}
   - Verification: Confirm files, verification, and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
2. ${stepTwoText}
   - Agent: main session
   - Batch: 2
   - Depends on: 1
   - Scope: ${files.join(', ')}
   - Verification: Confirm the final verification and blockers.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: ${stepTwoReviewGate}
   - Review reason: ${stepTwoReviewReason}

## Execution Policy
${policyBlock}

## Re-review Triggers
${rereviewBlock}

## Files
${filesBlock}

## Verification
${verificationBlock}
`;
}

async function setupExecutionHandoffHarness({ cwd, branch = [], selectResponses = [], customResponses = [], waitForIdleImpl } = {}) {
  const workingDir = cwd ?? await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const sessions = new Map();
  let currentSessionIndex = 0;
  let currentSessionFile = join(workingDir, 'session.jsonl');
  let currentBranch = branch;
  sessions.set(currentSessionFile, currentBranch);

  const pi = createFakePi(() => currentBranch, () => currentSessionFile);
  opencodePlanMode(pi);
  const ctx = createCtx({
    cwd: workingDir,
    branch: () => currentBranch,
    sessionFile: () => currentSessionFile,
    selectResponses,
    customResponses,
    waitForIdleImpl,
    newSessionImpl: async function (options) {
      const previousSessionFile = currentSessionFile;
      currentSessionIndex += 1;
      currentSessionFile = join(workingDir, `session-${currentSessionIndex}.jsonl`);
      currentBranch = [];
      sessions.set(currentSessionFile, currentBranch);

      if (options?.setup) {
        await options.setup({
          getSessionFile: () => currentSessionFile,
          getCwd: () => workingDir,
          appendCustomEntry(customType, data) {
            currentBranch.push({ type: 'custom', customType, data });
          },
          appendMessage(message) {
            currentBranch.push({ type: 'message', message });
          },
        });
      }

      await pi.emit('session_switch', { reason: 'new', previousSessionFile }, ctx);
      await flushMicrotasks();
      return { cancelled: false };
    },
  });

  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  return {
    cwd: workingDir,
    ctx,
    pi,
    sessions,
    getCurrentBranch: () => currentBranch,
    getCurrentSessionFile: () => currentSessionFile,
  };
}

test('planning mode injects stronger plan instructions and keeps authoring guardrails', async () => {
  const { pi, ctx } = await setupExtension();

  await pi.commands.get('plan').handler('', ctx);
  await flushMicrotasks();

  const beforeStart = await pi.emit('before_agent_start', {}, ctx);
  assert.match(beforeStart.message.content, /Every step should state a real deliverable/);
  assert.match(beforeStart.message.content, /Choose Agent metadata deliberately instead of defaulting every step to main session/);
  assert.match(beforeStart.message.content, /parallel fan-out\/fan-in explicit/);
  assert.match(beforeStart.message.content, /Explore and Plan stay read-only/);

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

test('plan workflow strips and blocks prompt_improve during active plan sessions', async () => {
  const { pi, ctx } = await setupExtension();
  pi.setActiveTools([...pi.getActiveTools(), 'prompt_improve']);

  await pi.commands.get('plan').handler('', ctx);
  await flushMicrotasks();

  assert.equal(pi.getActiveTools().includes('prompt_improve'), false);

  const blockedPromptImprove = await pi.emit('tool_call', {
    toolName: 'prompt_improve',
    input: { request: 'tighten this prompt' },
  }, ctx);
  assert.equal(blockedPromptImprove.block, true);
  assert.match(blockedPromptImprove.reason, /exit plan mode before invoking prompt_improve directly/i);
});

test('approved waiting execution also keeps prompt_improve disabled', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: {
      mode: 'approved_waiting_execution',
      previousActiveTools: ['read', 'bash', 'prompt_improve'],
      panelVisible: true,
      artifact: undefined,
      approval: undefined,
      execution: undefined,
      subagents: [],
    },
  }];
  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const ctx = createCtx({ cwd, branch });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  assert.equal(pi.getActiveTools().includes('prompt_improve'), false);

  const blockedPromptImprove = await pi.emit('tool_call', {
    toolName: 'prompt_improve',
    input: { request: 'tighten this prompt' },
  }, ctx);
  assert.equal(blockedPromptImprove.block, true);
  assert.match(blockedPromptImprove.reason, /exit plan mode before invoking prompt_improve directly/i);
});

test('approval still blocks structurally invalid plans even if the user asks to approve anyway', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const markdown = `## Goal
- Ship safely.

## Plan
2. Second comes first.
   - Agent: main session
   - Batch: 1
   - Depends on: none
1. First comes second.
   - Agent: main session
   - Batch: 2
   - Depends on: 2

## Files
- extensions/opencode-plan-mode/index.ts
`;
  await writeFile(planPath, markdown, 'utf8');

  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: {
      mode: 'planning',
      planPath,
      panelVisible: true,
      artifact: extractPlanArtifact(markdown),
      approval: undefined,
      execution: undefined,
      subagents: [],
    },
  }];
  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const ctx = createCtx({ cwd, branch, customResponses: ['Approve and start anyway'] });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  await pi.commands.get('plan').handler('approve', ctx);
  await flushMicrotasks();

  assert.equal(latestState(branch).mode, 'planning');
  assert.match(latestState(branch).approval.summary, /ERROR:/);
  assert.match(latestState(branch).approval.summary, /increase strictly/);
  assert.equal(ctx.newSessionCalls.length, 0);
});

test('approval allows an explicit override when only contract blockers remain', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const markdown = `## Goal
- Ship safely.

## Plan
1. Check things.
   - Agent: main session
   - Batch: 1
   - Depends on: none

## Files
- extensions/opencode-plan-mode/index.ts
`;
  await writeFile(planPath, markdown, 'utf8');

  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: {
      mode: 'planning',
      planPath,
      panelVisible: true,
      artifact: extractPlanArtifact(markdown),
      approval: undefined,
      execution: undefined,
      subagents: [],
    },
  }];
  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const ctx = createCtx({ cwd, branch, customResponses: ['Approve and start anyway'] });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  await pi.commands.get('plan').handler('approve', ctx);
  await flushMicrotasks();

  assert.equal(ctx.newSessionCalls.length, 1);
  assert.equal(latestState(branch).mode, 'executing');
  assert.match(latestState(branch).approval.summary, /Approval blocker:/);
  assert.match(latestState(branch).approval.summary, /Scope metadata/);
  assert.ok(latestState(branch).execution.warnings.some((warning) => /Plan approval blocker:/.test(warning)));
  assert.ok(ctx.ui.notifications.some((entry) => /approved with override/i.test(entry.message)));
});

test('approval revise-and-reapprove flow refreshes the summary and starts execution with the richer contract', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const incompleteMarkdown = `## Goal
- Ship safely.

## Plan
1. Patch it.
   - Agent: main session
   - Batch: 1
   - Depends on: none

## Files
- extensions/opencode-plan-mode/index.ts
`;
  const revisedMarkdown = createHardenedPlanMarkdown({
    goal: 'Ship safely.',
    successCriteria: ['Expose the operating envelope before approval.'],
    files: ['extensions/opencode-plan-mode/index.ts', 'tests/opencode-plan-mode.integration.test.mjs'],
  });
  await writeFile(planPath, incompleteMarkdown, 'utf8');

  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: {
      mode: 'planning',
      planPath,
      panelVisible: true,
      artifact: extractPlanArtifact(incompleteMarkdown),
      approval: undefined,
      execution: undefined,
      subagents: [],
    },
  }];
  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const ctx = createCtx({
    cwd,
    branch,
    customResponses: ['Revise in editor', 'Approve and start execution'],
    editorResponses: [revisedMarkdown],
  });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  await pi.commands.get('plan').handler('approve', ctx);
  await flushMicrotasks();

  assert.equal(ctx.newSessionCalls.length, 1);
  assert.match(latestState(branch).approval.summary, /Expose the operating envelope before approval/);
  assert.match(pi.sentMessages.at(-1).text, /Success criteria:/);
  assert.match(pi.sentMessages.at(-1).text, /Scope anchors:/);
  assert.match(pi.sentMessages.at(-1).text, /Pause conditions:/);
  assert.equal(latestState(branch).mode, 'executing');
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
  assert.match(beforeStart.message.content, /Start from the current ready frontier/);
  assert.match(beforeStart.message.content, /multiple independent steps in the same batch/);

  const missingStepRef = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: {
      description: 'Implement patch',
      prompt: 'Return outcome, files, verification, blockers, and unblock status.',
      subagent_type: 'general-purpose',
      run_in_background: true,
      isolation: 'worktree',
      join_mode: 'group',
    },
  }, ctx);
  assert.equal(missingStepRef.block, true);
  assert.match(missingStepRef.reason, /reference a numbered plan step/);
  await flushMicrotasks();
  assert.equal(latestState(branch).execution.lastDelegation.status, 'blocked');
  assert.match(latestState(branch).execution.lastDelegation.reason, /reference a numbered plan step/);

  const missingIsolation = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: {
      description: 'Implement step 1',
      prompt: 'Work on step 1. Return outcome, files, verification, blockers, and unblock status.',
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
      description: 'Implement patch',
      prompt: 'Work on step 1. Return outcome, changed paths, tests run, risks, and unblock status.',
      subagent_type: 'general-purpose',
      run_in_background: true,
      isolation: 'worktree',
      join_mode: 'group',
    },
  }, ctx);
  assert.equal(allowed, undefined);
  await flushMicrotasks();
  assert.equal(latestState(branch).execution.lastDelegation.status, 'allowed');
  assert.match(latestState(branch).execution.lastDelegation.reason, /Delegating frontier step 1/);

  pi.emitSubagent('subagents:created', { id: 'agent-1', type: 'general-purpose', description: 'Implement patch', isBackground: true });
  pi.emitSubagent('subagents:started', { id: 'agent-1', type: 'general-purpose', description: 'Implement patch' });
  pi.emitSubagent('subagents:completed', { id: 'agent-1', type: 'general-purpose', description: 'Implement patch', toolUses: 3, durationMs: 1200 });
  await pi.emit('tool_result', {
    toolName: 'get_subagent_result',
    input: { agent_id: 'agent-1' },
    output: {
      content: [{ type: 'text', text: 'Outcome: patched workflow. Files: extensions/opencode-plan-mode/index.ts. Verification: focused test passed. Blockers: none. Unblock status: ready for fan-in.' }],
    },
  }, ctx);
  await flushMicrotasks();

  const state = latestState(branch);
  assert.deepEqual(state.subagents[0].stepNumbers, [1]);
  assert.match(state.subagents[0].stepAssociation, /delegated request|prompt text/);
  assert.match(state.subagents[0].normalizedSummary, /Files:/);
  assert.equal(state.subagents[0].status, 'completed');
  assert.equal(state.execution.checkpoints[0].step, 1);
  assert.equal(state.execution.checkpoints[0].status, 'complete');
  assert.match(state.execution.checkpoints[0].outcome, /patched workflow/);
  assert.deepEqual(state.execution.checkpoints[0].files, ['extensions/opencode-plan-mode/index.ts']);
  assert.deepEqual(state.execution.checkpoints[0].verification, ['focused test passed']);
  assert.equal(state.execution.checkpoints[0].blockers.length, 0);
  assert.match(state.execution.checkpoints[0].unblockStatus, /ready for fan-in/);
});

test('subagent progress events persist checklist items and fallback activity during execution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const markdown = `## Goal
- Render richer subagent progress.

## Plan
1. Implement the progress plumbing.
   - Agent: general-purpose
   - Batch: 1
   - Depends on: none
   - Verification: Persist the checklist items in plan state.
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
          readySteps: [1],
          frontierStepNumbers: [1],
          frontierBatch: 1,
          blockedSteps: [],
          warnings: [],
          activeStep: 1,
        },
        subagents: [],
      },
    },
    { type: 'custom', customType: 'opencode-plan-execute', data: { artifact, approval } },
  ];

  const { pi, ctx } = await setupExtension({ branch, cwd });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();

  pi.emitSubagent('subagents:progress', {
    id: 'agent-progress',
    type: 'general-purpose',
    description: 'Implement step 1 progress plumbing',
    status: 'running',
    fallbackActivity: 'searching files…',
    items: [
      {
        id: 'description',
        label: 'Implement step 1 progress plumbing',
        status: 'active',
        source: 'description',
        detail: 'linked from description (steps 1)',
      },
    ],
    activeItemId: 'description',
  });
  await flushMicrotasks();

  let state = latestState(branch);
  assert.equal(state.subagents[0].activeProgressItemId, 'description');
  assert.equal(state.subagents[0].progressItems[0].label, 'Implement step 1 progress plumbing');
  assert.match(state.subagents[0].fallbackActivity, /searching files/);
  assert.deepEqual(state.subagents[0].stepNumbers, [1]);

  pi.emitSubagent('subagents:progress', {
    id: 'agent-progress',
    type: 'general-purpose',
    description: 'Implement step 1 progress plumbing',
    status: 'completed',
    normalizedSummary: 'Outcome: progress plumbing landed with focused tests.',
    items: [
      {
        id: 'description',
        label: 'Implement step 1 progress plumbing',
        status: 'completed',
        source: 'description',
      },
      {
        id: 'normalized-result-summary',
        label: 'Outcome: progress plumbing landed with focused tests.',
        status: 'completed',
        source: 'normalized_result_summary',
      },
    ],
  });
  await flushMicrotasks();

  state = latestState(branch);
  assert.equal(state.subagents[0].status, 'completed');
  assert.equal(state.subagents[0].progressItems.filter((item) => item.status === 'completed').length, 2);
  assert.match(state.subagents[0].normalizedSummary, /focused tests/);
});

test('assistant completion records partial checkpoints, warns on missing fields, and preserves resume frontier state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const markdown = createHardenedPlanMarkdown({
    goal: 'Resume safely.',
    successCriteria: ['Checkpoint data survives resume.'],
    files: ['extensions/opencode-plan-mode/index.ts'],
    verification: ['Run focused checks.'],
    stepOneText: 'Land the first slice.',
    stepTwoText: 'Resume from the next frontier.',
    stepTwoReviewGate: 'rereview_after',
    stepTwoReviewReason: 'Re-review if the checkpoint expands scope.',
  });
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
          readySteps: [1],
          frontierStepNumbers: [1],
          frontierBatch: 1,
          blockedSteps: [],
          checkpoints: [],
          warnings: [],
          activeStep: 1,
        },
        subagents: [],
      },
    },
    { type: 'custom', customType: 'opencode-plan-execute', data: { artifact, approval } },
  ];

  const { pi, ctx } = await setupExtension({ branch, cwd });
  await pi.emit('turn_end', { message: createAssistantTextMessage('[DONE:1] Outcome: landed the first slice.') }, ctx);
  await flushMicrotasks();

  let state = latestState(branch);
  assert.deepEqual(state.execution.completedSteps, [1]);
  assert.deepEqual(state.execution.frontierStepNumbers, [2]);
  assert.equal(state.execution.checkpoints[0].step, 1);
  assert.equal(state.execution.checkpoints[0].status, 'partial');
  assert.match(state.execution.warnings.join(' | '), /missing files, verification, blockers\/risks, unblock status/i);

  const resumedPi = createFakePi(branch);
  opencodePlanMode(resumedPi);
  const resumedCtx = createCtx({ cwd, branch });
  await resumedPi.emit('session_start', {}, resumedCtx);
  await flushMicrotasks();

  state = latestState(branch);
  assert.deepEqual(state.execution.frontierStepNumbers, [2]);
  assert.equal(state.execution.checkpoints[0].step, 1);
  assert.equal(state.execution.checkpoints[0].status, 'partial');
});

test('execution mode keeps main-session frontier steps out of delegated subagents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  const markdown = `## Plan
1. Keep this edit in the main session.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Verification: Confirm the coupled edit remains local.
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

  const blocked = await pi.emit('tool_call', {
    toolName: 'Agent',
    input: {
      description: 'Implement coupled edit',
      prompt: 'Work on step 1. Return outcome, files, verification, blockers, and unblock status.',
      subagent_type: 'general-purpose',
    },
  }, ctx);

  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /should stay in the main session/);
  await flushMicrotasks();
  assert.equal(latestState(branch).execution.lastDelegation.status, 'blocked');
});

test('plan_exit approval handoff pins the orphaned tool-result replay seam before the first continuation turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });

  const markdown = createHardenedPlanMarkdown({
    goal: 'Reproduce the approval handoff seam.',
    successCriteria: ['Fresh-session execution starts without replaying the approval tool result.'],
    executionPolicy: [
      'Keep approval explicit and move execution into a fresh session.',
      'Summaries must capture outcome, files, verification, blockers/risks, and unblock status.',
    ],
    rereviewTriggers: ['Execution contract edits after approval.', 'Scope changes after approval.'],
    files: ['extensions/opencode-plan-mode/index.ts', 'tests/opencode-plan-mode.integration.test.mjs'],
    verification: ['Recreate the approval -> fresh-session -> follow-up seam.'],
    stepOneText: 'Start approved execution in a fresh session.',
    stepTwoText: 'Continue with the next step.',
    stepTwoReviewGate: 'pause_after',
    stepTwoReviewReason: 'Pause if the execution handoff widens scope or changes replay behavior.',
  });
  await writeFile(planPath, markdown, 'utf8');

  const { pi, ctx, sessions, getCurrentBranch, getCurrentSessionFile } = await setupExecutionHandoffHarness({
    cwd,
    customResponses: ['Approve plan'],
  });

  await pi.commands.get('plan').handler('', ctx);
  await flushMicrotasks();

  const parentSessionFile = getCurrentSessionFile();
  const parentBranch = getCurrentBranch();
  const toolCallId = 'call_plan_exit_1|fc_plan_exit_1';
  parentBranch.push({
    type: 'message',
    message: createAssistantToolCallMessage('plan_exit', toolCallId),
  });

  const planExitResult = await pi.tools.get('plan_exit').execute(toolCallId, {}, undefined, undefined, ctx);
  parentBranch.push({
    type: 'message',
    message: createToolResultMessage('plan_exit', toolCallId, planExitResult),
  });
  await flushMicrotasks();

  assert.equal(latestState(parentBranch).mode, 'approved_waiting_execution');
  assert.equal(ctx.ui.editorText, '/plan');

  await pi.commands.get('plan').handler('', ctx);
  await flushMicrotasks();

  const childSessionFile = getCurrentSessionFile();
  const childBranch = getCurrentBranch();
  assert.notEqual(childSessionFile, parentSessionFile);
  assert.equal(ctx.newSessionCalls.length, 1);
  assert.equal(ctx.newSessionCalls[0].parentSession, parentSessionFile);
  assert.equal(typeof ctx.newSessionCalls[0].setup, 'function');
  assert.equal(latestState(childBranch).mode, 'executing');
  assert.equal(childBranch.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult'), false);
  assert.match(pi.sentMessages.at(-1).text, /Execute the approved plan/);
  assert.equal(pi.sentMessages.at(-1).sessionFile, childSessionFile);

  childBranch.push({
    type: 'message',
    message: createAssistantTextMessage('Started step 1 in the fresh execution session.'),
  });
  pi.sendUserMessage("Let's go to the next step");

  const childMessages = messageEntries(childBranch);
  assert.equal(childMessages[0].role, 'user');
  assert.equal(childMessages.at(-1).role, 'user');
  assert.equal(parentBranch.at(-1).message.role, 'toolResult');
  assert.equal(parentBranch.at(-1).message.toolName, 'plan_exit');

  const childResponsesMessages = convertResponsesMessages(
    createResponsesReplayModel(),
    { messages: childMessages },
    new Set(['openai']),
    { includeSystemPrompt: false },
  );
  assert.deepEqual(findUnmatchedFunctionCallOutputs(childResponsesMessages), []);

  const replayCandidateMessages = [parentBranch.at(-1).message, ...childMessages];
  const responsesMessages = convertResponsesMessages(
    createResponsesReplayModel(),
    { messages: replayCandidateMessages },
    new Set(['openai']),
    { includeSystemPrompt: false },
  );

  assert.deepEqual(findUnmatchedFunctionCallOutputs(responsesMessages), ['call_plan_exit_1']);
  assert.equal(sessions.get(parentSessionFile), parentBranch);
  assert.equal(sessions.get(childSessionFile), childBranch);
});

test('/plan <request> seeds the child planning session with the native request bootstrap contract and no replayable plan-only tool results', async () => {
  const request = 'Restore the planning request handoff.';
  const ignoredAssistantText = 'Produce a dependency-aware execution plan for the request handoff regression.';
  const { pi, ctx, sessions, getCurrentBranch, getCurrentSessionFile } = await setupExecutionHandoffHarness({
    waitForIdleImpl: async function () {
      getCurrentBranch().push({
        type: 'message',
        message: createAssistantTextMessage(`\
\`\`\`
${ignoredAssistantText}
\`\`\`

🎯 Target: GPT-5.4 / Pi / agentic planning`),
      });
    },
  });

  const parentSessionFile = getCurrentSessionFile();
  const parentBranch = getCurrentBranch();
  const toolCallId = 'call_plan_enter_1|fc_plan_enter_1';
  parentBranch.push({
    type: 'message',
    message: createAssistantToolCallMessage('plan_enter', toolCallId, { goal: request }),
  });

  const planEnterResult = await pi.tools.get('plan_enter').execute(toolCallId, { goal: request }, undefined, undefined, ctx);
  parentBranch.push({
    type: 'message',
    message: createToolResultMessage('plan_enter', toolCallId, planEnterResult),
  });
  await flushMicrotasks();

  assert.match(ctx.ui.editorText, /^\/plan /);

  await pi.commands.get('plan').handler(request, ctx);
  await flushMicrotasks();

  const childSessionFile = getCurrentSessionFile();
  const childBranch = getCurrentBranch();
  assert.notEqual(childSessionFile, parentSessionFile);
  assert.equal(ctx.newSessionCalls.length, 1);
  assert.equal(ctx.newSessionCalls[0].parentSession, parentSessionFile);
  assert.equal(typeof ctx.newSessionCalls[0].setup, 'function');
  assert.equal(latestState(childBranch).mode, 'planning');
  assert.equal(childBranch.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult'), false);
  assert.match(pi.sentMessages.at(-1).text, /Create the implementation plan for the request below/);
  assert.match(pi.sentMessages.at(-1).text, /Original request \(verbatim\):/);
  assert.match(pi.sentMessages.at(-1).text, /Restore the planning request handoff\./);
  assert.equal(pi.sentMessages.at(-1).sessionFile, childSessionFile);

  childBranch.push({
    type: 'message',
    message: createAssistantTextMessage('Drafted the fresh planning scaffold in the new session.'),
  });
  pi.sendUserMessage('Add verification and blockers to the plan.');

  const childMessages = messageEntries(childBranch);
  assert.equal(childMessages[0].role, 'user');
  assert.match(childMessages[0].content, /Create the implementation plan for the request below/);
  assert.match(childMessages[0].content, /Expected plan output contract:/);
  assert.doesNotMatch(childMessages[0].content, new RegExp(ignoredAssistantText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(childMessages.at(-1).role, 'user');
  const planEnterToolResult = parentBranch.findLast(
    (entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'plan_enter',
  )?.message;
  assert.ok(planEnterToolResult);

  const childResponsesMessages = convertResponsesMessages(
    createResponsesReplayModel(),
    { messages: childMessages },
    new Set(['openai']),
    { includeSystemPrompt: false },
  );
  assert.deepEqual(findUnmatchedFunctionCallOutputs(childResponsesMessages), []);

  const replayCandidateMessages = [planEnterToolResult, ...childMessages];
  const responsesMessages = convertResponsesMessages(
    createResponsesReplayModel(),
    { messages: replayCandidateMessages },
    new Set(['openai']),
    { includeSystemPrompt: false },
  );
  assert.deepEqual(findUnmatchedFunctionCallOutputs(responsesMessages), ['call_plan_enter_1']);
  assert.equal(sessions.get(parentSessionFile), parentBranch);
  assert.equal(sessions.get(childSessionFile), childBranch);
});

test('approved execution start requires explicit override when the plan drifts after approval', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });

  const original = createHardenedPlanMarkdown({
    goal: 'Execute safely.',
    successCriteria: ['Keep approval explicit.'],
    files: ['extensions/opencode-plan-mode/index.ts'],
    verification: ['Run focused checks.'],
    stepOneText: 'Original first step.',
    stepTwoText: 'Original second step.',
    stepTwoReviewGate: 'rereview_after',
    stepTwoReviewReason: 'Re-review if the approved contract changes.',
  });
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

  const original = createHardenedPlanMarkdown({
    goal: 'Execute safely.',
    successCriteria: ['Keep approval explicit.'],
    files: ['extensions/opencode-plan-mode/index.ts'],
    verification: ['Run focused checks.'],
    stepOneText: 'Original first step.',
    stepTwoText: 'Original second step.',
    stepTwoReviewGate: 'rereview_after',
    stepTwoReviewReason: 'Re-review if the approved contract changes.',
  });
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
  assert.equal(typeof ctx.newSessionCalls[0].setup, 'function');
  assert.match(pi.sentMessages.at(-1).text, /Start from the ready frontier/);
  assert.doesNotMatch(pi.sentMessages.at(-1).text, /Start with the first unfinished numbered step/);
  assert.match(pi.sentMessages.at(-1).text, /Ready frontier:/);
  assert.match(pi.sentMessages.at(-1).text, /Success criteria:/);
  assert.match(pi.sentMessages.at(-1).text, /Scope anchors:/);
  assert.match(pi.sentMessages.at(-1).text, /Pause conditions:/);
  assert.match(pi.sentMessages.at(-1).text, /Delegation guidance:/);
  assert.equal(latestState(branch).mode, 'executing');
});
