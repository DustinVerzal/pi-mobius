import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const progressModule = await jiti.import('../extensions/subagents-bridge/progress.ts');
const rendererModule = await jiti.import('../extensions/subagents-bridge/renderers.ts');

const { SubagentProgressRegistry } = progressModule;
const { renderSubagentWidget, renderAgentResultWithProgress } = rendererModule;

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test('subagent progress registry seeds checklist items from description and normalized summaries', () => {
  const registry = new SubagentProgressRegistry();

  const running = registry.upsert({
    id: 'agent-1',
    type: 'Explore',
    description: 'Inspect step 1 boundary',
    status: 'running',
    stepAssociation: 'linked from description (steps 1)',
    fallbackActivity: 'searching files…',
  }).snapshot;

  assert.equal(running.activeItemId, 'description');
  assert.equal(running.items[0].label, 'Inspect step 1 boundary');
  assert.equal(running.items[0].status, 'active');
  assert.match(running.items[0].detail, /steps 1/);

  const completed = registry.upsert({
    id: 'agent-1',
    status: 'completed',
    normalizedSummary: 'Outcome: boundary confirmed. Files touched: none. Verification: source files re-checked.',
    durationMs: 850,
  }).snapshot;

  assert.equal(completed.status, 'completed');
  assert.ok(completed.items.some((item) => item.source === 'normalized_result_summary'));
  assert.equal(completed.items.find((item) => item.source === 'normalized_result_summary')?.status, 'completed');
});

test('widget renderer shows active checklist lines and completed checkmarks without stale overflow spam', () => {
  const registry = new SubagentProgressRegistry();
  registry.upsert({
    id: 'agent-active',
    type: 'general-purpose',
    description: 'Implement step 3 widget rendering',
    status: 'running',
    stepAssociation: 'linked from delegated request (steps 3)',
  });
  registry.upsert({
    id: 'agent-done',
    type: 'Explore',
    description: 'Confirm step 1 boundary',
    status: 'completed',
    normalizedSummary: 'Outcome: repo-owned boundary confirmed.',
    durationMs: 1200,
  });

  const lines = renderSubagentWidget(registry, theme).join('\n');
  assert.match(lines, /Implement step 3 widget rendering/);
  assert.match(lines, /→ Inspect|→ Implement step 3 widget rendering|→/);
  assert.match(lines, /Outcome: repo-owned boundary confirmed/);
  assert.match(lines, /✓/);
});

test('agent result renderer falls back to activity text when checklist progress is absent', () => {
  const rendered = renderAgentResultWithProgress({
    content: [{ type: 'text', text: '1 tool uses...' }],
    details: {
      status: 'running',
      toolUses: 1,
      spinnerFrame: 0,
      activity: 'searching files…',
      turnCount: 2,
      maxTurns: 8,
    },
  }, { isPartial: true }, theme);

  assert.ok(rendered);
  assert.match(rendered.text, /searching files/);
  assert.doesNotMatch(rendered.text, /✓/);
});

test('agent result renderer shows checklist progress when progress snapshots are attached', () => {
  const registry = new SubagentProgressRegistry();
  const progress = registry.upsert({
    id: 'agent-2',
    type: 'general-purpose',
    description: 'Implement step 4 workflow rail',
    status: 'completed',
    normalizedSummary: 'Outcome: workflow rail now shows active checklist items and completed checkmarks.',
    durationMs: 1600,
  }).snapshot;

  const rendered = renderAgentResultWithProgress({
    content: [{ type: 'text', text: 'Agent completed.' }],
    details: {
      status: 'completed',
      toolUses: 4,
      durationMs: 1600,
      progress,
    },
  }, { expanded: false }, theme);

  assert.ok(rendered);
  assert.match(rendered.text, /workflow rail now shows active checklist items/);
  assert.match(rendered.text, /✓/);
});
