import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const dockedEditorModule = await jiti.import('../extensions/opencode-plan-mode/docked-editor.ts');
const utils = await jiti.import('../extensions/opencode-plan-mode/utils.ts');
const opencodePlanModeModule = await jiti.import('../extensions/opencode-plan-mode/index.ts');

const { DockedPlanModeEditor } = dockedEditorModule;
const { extractPlanArtifact } = utils;
const opencodePlanMode = opencodePlanModeModule.default ?? opencodePlanModeModule;
const WORKFLOW_WIDGET_KEY = 'opencode-plan-workflow';

// Manual approval→execution debug recipe for the known rail glitch:
//   PI_TUI_WRITE_LOG=/tmp/pi-tui.log pi
//   /plan -> approve -> /plan
//   Repeat with /plan sidebar off, then resize between narrow and wide widths.

const editorTheme = {
  borderColor: (text) => text,
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

const keybindings = {
  matches() {
    return false;
  },
};

const basePlanMarkdown = `## Goal
- Stabilize the workflow rail.

## Plan
1. Reproduce the current lifecycle churn.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Verification: Capture the rail lifecycle transitions.
2. Start approved execution.
   - Agent: main session
   - Batch: 2
   - Depends on: 1
   - Verification: Confirm the handoff state.

## Files
- extensions/opencode-plan-mode/docked-editor.ts

## Verification
- Run the focused rail lifecycle tests.
`;

function createArtifact(markdown = basePlanMarkdown) {
  return extractPlanArtifact(markdown);
}

function createSidebarModel(mode, overrides = {}) {
  const artifact = createArtifact();
  if (mode === 'executing') {
    artifact.steps[0].status = 'in_progress';
  }

  return {
    mode,
    planPath: './.pi/plans/example.md',
    goal: artifact.goal,
    steps: artifact.steps,
    approval: mode === 'planning'
      ? undefined
      : {
          pendingSince: '2026-03-22T00:00:00.000Z',
          approvedAt: mode === 'approved_waiting_execution' || mode === 'executing' ? '2026-03-22T00:05:00.000Z' : undefined,
          approvedSignature: artifact.signature,
          summary: 'approved',
          validation: artifact.validation,
          handoff: artifact.handoff,
        },
    execution: mode === 'executing'
      ? {
          completedSteps: [],
          activeStep: 1,
          readySteps: [1],
          frontierStepNumbers: [1],
          frontierBatch: 1,
          blockedSteps: [],
          warnings: [],
        }
      : undefined,
    blockers: [],
    openQuestions: [],
    nextAction: `Next action for ${mode}.`,
    subagents: [],
    toggleHint: '/plan sidebar',
    ...overrides,
  };
}

function createStoredState(mode, artifact, planPath, overrides = {}) {
  return {
    mode,
    planPath,
    panelVisible: overrides.panelVisible ?? true,
    artifact,
    approval: mode === 'planning'
      ? undefined
      : {
          pendingSince: '2026-03-22T00:00:00.000Z',
          approvedAt: mode === 'approved_waiting_execution' || mode === 'executing' ? '2026-03-22T00:05:00.000Z' : undefined,
          approvedSignature: artifact.signature,
          summary: 'approved',
          validation: artifact.validation,
          handoff: artifact.handoff,
        },
    execution: mode === 'executing'
      ? {
          completedSteps: [],
          readySteps: [1],
          frontierStepNumbers: [1],
          frontierBatch: 1,
          blockedSteps: [],
          warnings: [],
          activeStep: 1,
        }
      : {
          completedSteps: [],
          readySteps: [],
          frontierStepNumbers: [],
          frontierBatch: undefined,
          blockedSteps: [],
          warnings: [],
        },
    subagents: [],
    ...overrides,
  };
}

function createOverlayHarness({ columns = 140, rows = 40 } = {}) {
  const calls = [];
  const handles = [];

  const tui = {
    terminal: { columns, rows },
    requestRender() {
      calls.push({ type: 'requestRender' });
    },
    showOverlay(component, options) {
      const handle = {
        component,
        options,
        hidden: false,
        hideCalls: 0,
        setHiddenCalls: [],
        hide() {
          this.hideCalls += 1;
          calls.push({ type: 'hide', handle: this });
        },
        setHidden(hidden) {
          if (this.hidden === hidden) return;
          this.hidden = hidden;
          this.setHiddenCalls.push(hidden);
          calls.push({ type: 'setHidden', hidden, handle: this });
        },
        isHidden() {
          return this.hidden;
        },
        focus() {
          calls.push({ type: 'focus', handle: this });
        },
      };

      handles.push(handle);
      calls.push({ type: 'showOverlay', component, options, handle });
      return handle;
    },
  };

  return { tui, calls, handles };
}

function createDockedEditorHarness() {
  const overlayHarness = createOverlayHarness();
  const editor = new DockedPlanModeEditor(overlayHarness.tui, editorTheme, keybindings, editorTheme, () => {});
  return { editor, ...overlayHarness };
}

function countCalls(calls, type) {
  return calls.filter((call) => call.type === type).length;
}

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
  let activeTools = ['read', 'bash', 'edit', 'write', 'Agent', 'get_subagent_result', 'steer_subagent'];

  return {
    commands,
    tools,
    handlers,
    subagentHandlers,
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
      branch.push({ type: 'message', message: { role: 'user', content: text }, options });
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
  };
}

function createCtx({ cwd, branch }) {
  const mountedEditors = [];
  const overlayHarness = createOverlayHarness();

  const ui = {
    theme: editorTheme,
    statuses: [],
    notifications: [],
    widgets: new Map(),
    widgetUpdates: [],
    editorFactory: undefined,
    editorText: '',
    setStatus(key, value) {
      this.statuses.push({ key, value });
    },
    setWidget(key, content, options) {
      this.widgetUpdates.push({ key, content, options });
      if (content === undefined) {
        this.widgets.delete(key);
        return;
      }
      this.widgets.set(key, { content, options });
    },
    notify(message, level) {
      this.notifications.push({ message, level });
    },
    setEditorText(text) {
      this.editorText = text;
    },
    setEditorComponent(factory) {
      this.editorFactory = factory;
    },
    mountEditor() {
      if (!this.editorFactory) throw new Error('No editor factory was registered.');
      const editor = this.editorFactory(overlayHarness.tui, editorTheme, keybindings);
      mountedEditors.push(editor);
      return editor;
    },
    async select() {
      return undefined;
    },
    async editor() {
      return undefined;
    },
    async input() {
      return undefined;
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
    async newSession() {
      return { cancelled: false };
    },
    isIdle: () => true,
    waitForIdle: async () => {},
  };

  return { ctx, ui, overlayHarness, mountedEditors };
}

async function setupExtensionWithState(mode, { panelVisible = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mobius-rail-test-'));
  const planPath = join(cwd, '.pi', 'plans', 'session.md');
  await mkdir(join(cwd, '.pi', 'plans'), { recursive: true });
  await writeFile(planPath, basePlanMarkdown, 'utf8');

  const artifact = createArtifact();
  const branch = [
    {
      type: 'custom',
      customType: 'opencode-plan-state',
      data: createStoredState(mode, artifact, planPath, { panelVisible }),
    },
  ];

  const pi = createFakePi(branch);
  opencodePlanMode(pi);
  const { ctx, ui, overlayHarness } = createCtx({ cwd, branch });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();
  const editor = ui.mountEditor();

  return { cwd, planPath, artifact, branch, pi, ctx, ui, overlayHarness, editor };
}

test('rail lifecycle stays stable across planning, approval, and execution state syncs', () => {
  const { editor, calls, handles } = createDockedEditorHarness();
  const planning = createSidebarModel('planning');
  const approvalPending = createSidebarModel('approval_pending');
  const approvedWaiting = createSidebarModel('approved_waiting_execution');
  const executing = createSidebarModel('executing');

  editor.setSidebarState(planning);
  editor.render(140);
  const handle = handles[0];

  editor.setSidebarState(approvalPending);
  editor.render(140);
  editor.setSidebarState(approvedWaiting);
  editor.render(140);
  editor.setSidebarState(executing);
  editor.render(140);

  assert.deepEqual(handle.setHiddenCalls, []);
  assert.equal(handle.hideCalls, 0);
  assert.equal(handles.length, 1);
  assert.equal(countCalls(calls, 'showOverlay'), 1);
});

test('rail lifecycle harness pins narrow-width fallback churn without recreating the overlay', () => {
  const { editor, calls, handles, tui } = createDockedEditorHarness();
  editor.setSidebarState(createSidebarModel('executing'));
  editor.render(140);
  const handle = handles[0];

  tui.terminal.columns = 80;
  editor.render(80);
  tui.terminal.columns = 140;
  editor.render(140);

  assert.deepEqual(handle.setHiddenCalls, [true, false]);
  assert.equal(countCalls(calls, 'showOverlay'), 1);
  assert.equal(handle.hideCalls, 0);
});

test('execution handoff and narrow terminals use the workflow widget instead of appending fallback editor lines', async () => {
  const { ui, overlayHarness, editor } = await setupExtensionWithState('executing');

  const initialWidget = ui.widgets.get(WORKFLOW_WIDGET_KEY);
  assert.ok(initialWidget);
  assert.equal(initialWidget.options?.placement, 'belowEditor');
  assert.ok(initialWidget.content.some((line) => line.includes('PLAN')));

  editor.render(140);
  await flushMicrotasks();
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);
  assert.equal(overlayHarness.handles.length, 1);

  const narrowLines = editor.render(80);
  await flushMicrotasks();
  const compactWidget = ui.widgets.get(WORKFLOW_WIDGET_KEY);
  assert.ok(compactWidget);
  assert.ok(compactWidget.content.some((line) => line.includes('PLAN')));
  assert.ok(narrowLines.every((line) => !line.includes('PLAN')));

  editor.render(140);
  await flushMicrotasks();
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);
  assert.deepEqual(overlayHarness.handles[0].setHiddenCalls, [true, false]);
});

test('session switches keep the mounted rail handle stable across execution handoff', async () => {
  const { artifact, branch, pi, ctx, overlayHarness, editor, planPath } = await setupExtensionWithState('approval_pending');

  editor.render(140);
  const handle = overlayHarness.handles[0];
  assert.deepEqual(handle.setHiddenCalls, []);
  assert.equal(countCalls(overlayHarness.calls, 'showOverlay'), 1);

  branch.push({
    type: 'custom',
    customType: 'opencode-plan-state',
    data: {
      mode: 'approved_waiting_execution',
      planPath,
      panelVisible: true,
      artifact,
      approval: {
        pendingSince: '2026-03-22T00:00:00.000Z',
        approvedAt: '2026-03-22T00:05:00.000Z',
        approvedSignature: artifact.signature,
        summary: 'approved',
        validation: artifact.validation,
        handoff: artifact.handoff,
      },
      execution: latestState(branch).execution,
      subagents: [],
    },
  });

  await pi.emit('session_switch', {}, ctx);
  await flushMicrotasks();
  assert.deepEqual(handle.setHiddenCalls, []);
  assert.equal(handle.hideCalls, 0);
  assert.equal(countCalls(overlayHarness.calls, 'showOverlay'), 1);

  editor.render(140);
  assert.deepEqual(handle.setHiddenCalls, []);
});

test('/plan sidebar off/on reuses the same rail handle and re-shows it without recreating the overlay', async () => {
  const { branch, pi, ctx, overlayHarness, editor } = await setupExtensionWithState('planning');

  editor.render(140);
  const handle = overlayHarness.handles[0];
  assert.deepEqual(handle.setHiddenCalls, []);

  await pi.commands.get('plan').handler('sidebar off', ctx);
  await flushMicrotasks();
  assert.equal(latestState(branch).panelVisible, false);
  assert.deepEqual(handle.setHiddenCalls, [true]);

  await pi.commands.get('plan').handler('sidebar on', ctx);
  await flushMicrotasks();
  assert.equal(latestState(branch).panelVisible, true);
  assert.deepEqual(handle.setHiddenCalls, [true, false]);

  editor.render(140);
  assert.deepEqual(handle.setHiddenCalls, [true, false]);
  assert.equal(overlayHarness.handles.length, 1);
});

test('/plan off clears status, widget fallback, and hides the existing rail handle', async () => {
  const { branch, pi, ctx, ui, overlayHarness, editor } = await setupExtensionWithState('executing');

  editor.render(140);
  await flushMicrotasks();
  const handle = overlayHarness.handles[0];
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);

  await pi.commands.get('plan').handler('off', ctx);
  await flushMicrotasks();

  assert.equal(latestState(branch).mode, 'normal');
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);
  assert.equal(ui.statuses.at(-1)?.value, undefined);
  assert.deepEqual(handle.setHiddenCalls, [true]);
  assert.equal(handle.hideCalls, 0);
});

test('repeated session switches and sidebar toggle loops reuse a single overlay handle', async () => {
  const { artifact, branch, planPath, pi, ctx, ui, overlayHarness, editor } = await setupExtensionWithState('planning');

  editor.render(140);
  await flushMicrotasks();
  const handle = overlayHarness.handles[0];

  for (const mode of ['approval_pending', 'approved_waiting_execution', 'executing', 'planning']) {
    branch.push({
      type: 'custom',
      customType: 'opencode-plan-state',
      data: createStoredState(mode, artifact, planPath),
    });
    await pi.emit('session_switch', {}, ctx);
    await flushMicrotasks();
    editor.render(140);
    await flushMicrotasks();

    await pi.commands.get('plan').handler('sidebar off', ctx);
    await flushMicrotasks();
    await pi.commands.get('plan').handler('sidebar on', ctx);
    await flushMicrotasks();
  }

  assert.equal(overlayHarness.handles.length, 1);
  assert.equal(handle.hideCalls, 0);
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);
  assert.ok(handle.setHiddenCalls.length >= 2);
});

test('session shutdown hides and disposes the mounted rail handle exactly once', async () => {
  const { pi, ctx, ui, overlayHarness, editor } = await setupExtensionWithState('executing');

  editor.render(140);
  await flushMicrotasks();
  const handle = overlayHarness.handles[0];
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);

  await pi.emit('session_shutdown', {}, ctx);
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);
  assert.deepEqual(handle.setHiddenCalls, [true]);
  assert.equal(handle.hideCalls, 1);
});
