import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const dockedEditorModule = await jiti.import('../extensions/opencode-plan-mode/docked-editor.ts');
const sidebarModule = await jiti.import('../extensions/opencode-plan-mode/sidebar.ts');
const approvalReviewModule = await jiti.import('../extensions/opencode-plan-mode/approval-review.ts');
const utils = await jiti.import('../extensions/opencode-plan-mode/utils.ts');
const opencodePlanModeModule = await jiti.import('../extensions/opencode-plan-mode/index.ts');

const { DockedPlanModeEditor } = dockedEditorModule;
const { renderPlanSidebarFallback } = sidebarModule;
const { renderApprovalReviewSnapshot } = approvalReviewModule;
const { extractPlanArtifact, formatApprovalSummary } = utils;
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

## Context
- Keep transcript-primary workflow surfaces stable during approval and execution handoff.

## Success Criteria
- Approval and execution keep the transcript-primary workflow stable.

## Plan
1. Reproduce the current lifecycle churn.
   - Agent: main session
   - Batch: 1
   - Depends on: none
   - Scope: extensions/opencode-plan-mode/docked-editor.ts
   - Verification: Confirm the rail lifecycle transitions.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
2. Start approved execution.
   - Agent: main session
   - Batch: 2
   - Depends on: 1
   - Scope: extensions/opencode-plan-mode/docked-editor.ts
   - Verification: Confirm the handoff state.
   - Checkpoint: outcome, files, verification, blockers/risks, unblock status
   - Review gate: pause_after
   - Review reason: Pause if the workflow rail contract changes during execution handoff.

## Execution Policy
- Keep the rail compact and transcript-primary.
- Summaries must capture outcome, files, verification, blockers/risks, and unblock status.

## Re-review Triggers
- Scope changes after approval.
- Rail/widget contract changes after approval.

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
          checkpoints: [],
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
          checkpoints: [],
          warnings: [],
          activeStep: 1,
        }
      : {
          completedSteps: [],
          readySteps: [],
          frontierStepNumbers: [],
          frontierBatch: undefined,
          blockedSteps: [],
          checkpoints: [],
          warnings: [],
        },
    subagents: [],
    ...overrides,
  };
}

test('compact rail summaries distinguish absent frontier delegation from historical delegation', () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
  };

  const noDelegation = renderPlanSidebarFallback(createSidebarModel('executing'), theme, 80).join('\n');
  assert.match(noDelegation, /no delegation yet/);

  const historicalDelegation = renderPlanSidebarFallback(createSidebarModel('executing', {
    subagents: [{ id: 'agent-1', type: 'general-purpose', description: 'Older frontier work', status: 'completed', startedAt: 1, completedAt: 2, stepNumbers: [2] }],
  }), theme, 80).join('\n');
  assert.match(historicalDelegation, /history only/);
});

test('approval review snapshot keeps the operating-envelope copy visible without crowding the transcript', () => {
  const artifact = createArtifact();
  const summary = formatApprovalSummary('/repo/.pi/plans/example.md', '/repo', artifact);
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };

  const rendered = renderApprovalReviewSnapshot({
    title: 'Review plan and operating envelope',
    summary,
    options: ['Approve plan', 'Revise in editor', 'Keep planning'],
    width: 120,
    rows: 34,
    theme,
  }).join('\n');

  assert.match(rendered, /Review plan and operating envelope/);
  assert.match(rendered, /plan and operating envelope/);
  assert.match(summary, /Success criteria:/);
  assert.match(summary, /Execution policy:/);
  assert.match(summary, /Re-review triggers:/);
  assert.match(rendered, /↑↓\/j\/k scroll/);
});

test('compact rail fallback keeps checklist progress readable for frontier subagents', () => {
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    strikethrough: (text) => text,
  };

  const rendered = renderPlanSidebarFallback(createSidebarModel('executing', {
    subagents: [{
      id: 'agent-1',
      type: 'general-purpose',
      description: 'Implement workflow rail rendering',
      status: 'running',
      startedAt: 1,
      stepNumbers: [1],
      progressItems: [
        { id: 'description', label: 'Implement workflow rail rendering', status: 'active', source: 'description', detail: 'linked from description (steps 1)' },
        { id: 'normalized-result-summary', label: 'Outcome: rail fallback stays readable in narrow terminals.', status: 'completed', source: 'normalized_result_summary' },
      ],
      activeProgressItemId: 'description',
      fallbackActivity: 'searching files…',
    }],
  }), theme, 80).join('\n');

  assert.match(rendered, /Agents:/);
  assert.match(rendered, /Implement workflow rail rendering/);
  assert.match(rendered, /→/);
});

function createOverlayHarness({ columns = 140, rows = 40, timeline, record: externalRecord } = {}) {
  const calls = [];
  const handles = [];
  let sequence = 0;

  function record(event) {
    if (externalRecord) {
      const enriched = externalRecord(event);
      calls.push(enriched);
      return enriched;
    }

    const enriched = { seq: ++sequence, ...event };
    calls.push(enriched);
    timeline?.push(enriched);
    return enriched;
  }

  const tui = {
    terminal: { columns, rows },
    requestRender() {
      record({ type: 'requestRender' });
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
          record({ type: 'hide', handle: this });
        },
        setHidden(hidden) {
          if (this.hidden === hidden) return;
          this.hidden = hidden;
          this.setHiddenCalls.push(hidden);
          record({ type: 'setHidden', hidden, handle: this });
        },
        isHidden() {
          return this.hidden;
        },
        focus() {
          record({ type: 'focus', handle: this });
        },
      };

      handles.push(handle);
      record({ type: 'showOverlay', component, options, handle });
      return handle;
    },
  };

  return { tui, calls, handles };
}

function createDockedEditorHarness() {
  const timeline = [];
  const overlayHarness = createOverlayHarness({ timeline });
  const editor = new DockedPlanModeEditor(overlayHarness.tui, editorTheme, keybindings, editorTheme, () => {});
  return { editor, timeline, ...overlayHarness };
}

function countCalls(calls, type) {
  return calls.filter((call) => call.type === type).length;
}

function summarizeWidgetUpdate(update) {
  if (update.content === undefined) return 'clear workflow widget';
  const firstLine = update.content.find((line) => typeof line === 'string' && line.trim().length > 0) ?? '';
  return `set workflow widget: ${firstLine.trim()}`;
}

function summarizeWorkflowMutations({ ui, overlayHarness, sidebarStateUpdates }) {
  return {
    statusWrites: ui.statuses.filter((entry) => entry.key === 'opencode-plan').map((entry) => entry.value),
    widgetWrites: ui.widgetUpdates.filter((entry) => entry.key === WORKFLOW_WIDGET_KEY).map(summarizeWidgetUpdate),
    sidebarPushes: sidebarStateUpdates.map((entry) => entry.mode),
    requestRenderCount: countCalls(overlayHarness.calls, 'requestRender'),
    showOverlayCount: countCalls(overlayHarness.calls, 'showOverlay'),
  };
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
  const timeline = [];
  let sequence = 0;
  const record = (event) => {
    const enriched = { seq: ++sequence, ...event };
    timeline.push(enriched);
    return enriched;
  };
  const overlayHarness = createOverlayHarness({ timeline, record });
  const sidebarStateUpdates = [];

  const ui = {
    theme: editorTheme,
    statuses: [],
    notifications: [],
    widgets: new Map(),
    widgetUpdates: [],
    editorFactory: undefined,
    editorText: '',
    setStatus(key, value) {
      const entry = { key, value, seq: record({ type: 'setStatus', key, value }).seq };
      this.statuses.push(entry);
    },
    setWidget(key, content, options) {
      const entry = { key, content, options, seq: record({ type: 'setWidget', key, action: content === undefined ? 'clear' : 'set' }).seq };
      this.widgetUpdates.push(entry);
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
      const originalPrototypeSetSidebarState = DockedPlanModeEditor.prototype.setSidebarState;
      DockedPlanModeEditor.prototype.setSidebarState = function patchedSetSidebarState(state) {
        sidebarStateUpdates.push({ mode: state?.mode ?? 'hidden', seq: record({ type: 'setSidebarState', mode: state?.mode ?? 'hidden' }).seq });
        return originalPrototypeSetSidebarState.call(this, state);
      };

      try {
        const editor = this.editorFactory(overlayHarness.tui, editorTheme, keybindings);
        const originalSetSidebarState = editor.setSidebarState.bind(editor);
        editor.setSidebarState = (state) => {
          sidebarStateUpdates.push({ mode: state?.mode ?? 'hidden', seq: record({ type: 'setSidebarState', mode: state?.mode ?? 'hidden' }).seq });
          return originalSetSidebarState(state);
        };
        mountedEditors.push(editor);
        return editor;
      } finally {
        DockedPlanModeEditor.prototype.setSidebarState = originalPrototypeSetSidebarState;
      }
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

  return { ctx, ui, overlayHarness, mountedEditors, sidebarStateUpdates, timeline };
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
  const { ctx, ui, overlayHarness, sidebarStateUpdates, timeline } = createCtx({ cwd, branch });
  await pi.emit('session_start', {}, ctx);
  await flushMicrotasks();
  const editor = ui.mountEditor();

  return { cwd, planPath, artifact, branch, pi, ctx, ui, overlayHarness, editor, sidebarStateUpdates, timeline };
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

test('approval -> execution wide handoff removes duplicate PLAN status/widget/sidebar/requestRender mutations once the rail takes over', async () => {
  const { ui, overlayHarness, editor, sidebarStateUpdates } = await setupExtensionWithState('executing');

  editor.render(140);
  await flushMicrotasks();

  const mutations = summarizeWorkflowMutations({ ui, overlayHarness, sidebarStateUpdates });
  assert.deepEqual(
    mutations.statusWrites,
    ['PLAN 0/2 · Batch 1: steps 1'],
    'remove duplicate PLAN status writes during the wide approval -> execution handoff',
  );
  assert.deepEqual(
    mutations.widgetWrites,
    [
      'set workflow widget: PLAN 0/2 · executing · approved',
      'clear workflow widget',
    ],
    'remove duplicate compact workflow widget writes before the wide rail takes over',
  );
  assert.deepEqual(
    mutations.sidebarPushes,
    ['executing'],
    'remove duplicate executing sidebar pushes once the rail model is already in sync',
  );
  assert.equal(
    mutations.requestRenderCount,
    1,
    'remove duplicate tui.requestRender() calls during the wide approval -> execution handoff',
  );
  assert.equal(mutations.showOverlayCount, 1);
});

test('approval -> execution compact fallback avoids duplicate PLAN status/widget/requestRender churn when the rail stays hidden', async () => {
  const { ui, overlayHarness, editor, sidebarStateUpdates } = await setupExtensionWithState('executing', { panelVisible: false });

  editor.render(140);
  await flushMicrotasks();

  const mutations = summarizeWorkflowMutations({ ui, overlayHarness, sidebarStateUpdates });
  assert.deepEqual(
    mutations.statusWrites,
    ['PLAN 0/2 · Batch 1: steps 1'],
    'remove duplicate PLAN status writes while /plan sidebar off keeps the compact widget active',
  );
  assert.deepEqual(
    mutations.widgetWrites,
    ['set workflow widget: PLAN 0/2 · executing · approved'],
    'remove duplicate compact workflow widget writes while the rail stays hidden during handoff',
  );
  assert.equal(
    mutations.requestRenderCount,
    0,
    'remove duplicate tui.requestRender() calls when the compact fallback already matches the hidden-rail presentation',
  );
  assert.equal(mutations.showOverlayCount, 0);
  assert.deepEqual(mutations.sidebarPushes, ['hidden']);
});

test('plan mode keeps PLAN status in setStatus while the workflow summary stays in the widget channel', async () => {
  const { ui } = await setupExtensionWithState('executing', { panelVisible: false });

  assert.equal(ui.statuses.at(-1)?.key, 'opencode-plan');
  assert.equal(ui.statuses.at(-1)?.value, 'PLAN 0/2 · Batch 1: steps 1');

  const compactWidget = ui.widgets.get(WORKFLOW_WIDGET_KEY);
  assert.ok(compactWidget);
  assert.equal(compactWidget.options?.placement, 'belowEditor');
  assert.ok(compactWidget.content.some((line) => line.includes('PLAN 0/2')));
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

test('restore into wide execution keeps the widget until the first rail activation and avoids editor fallback text', async () => {
  const { ui, overlayHarness, timeline, editor } = await setupExtensionWithState('executing');

  assert.equal(overlayHarness.handles.length, 0);
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), true);

  const wideLines = editor.render(140);
  await flushMicrotasks();

  assert.ok(wideLines.every((line) => !line.includes('PLAN')));
  assert.equal(overlayHarness.handles.length, 1);
  assert.equal(ui.widgets.has(WORKFLOW_WIDGET_KEY), false);

  const clearEvents = timeline.filter((event) => event.type === 'setWidget' && event.key === WORKFLOW_WIDGET_KEY && event.action === 'clear');
  assert.equal(clearEvents.length, 1);
  assert.ok(timeline.find((event) => event.type === 'showOverlay')?.seq < clearEvents[0].seq);
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
  assert.ok(countCalls(overlayHarness.calls, 'showOverlay') <= 1);
  assert.ok(countCalls(overlayHarness.calls, 'requestRender') <= 1 + (4 * 3));
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
