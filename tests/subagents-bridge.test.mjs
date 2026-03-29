import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const bridge = await jiti.import('../extensions/subagents-bridge/index.ts');
const { getGraceTurns } = await jiti.import('@tintinweb/pi-subagents/dist/agent-runner.js');
const { DEFAULT_AGENTS } = await jiti.import('@tintinweb/pi-subagents/dist/default-agents.js');

bridge.applyBundledSubagentOverrides();

test('bundled bridge configures bundled agents for bounded checkpoint-driven execution', () => {
  const generalPurpose = DEFAULT_AGENTS.get('general-purpose');
  const explore = DEFAULT_AGENTS.get('Explore');
  const plan = DEFAULT_AGENTS.get('Plan');

  assert.ok(generalPurpose);
  assert.ok(explore);
  assert.ok(plan);
  assert.equal(explore.model, 'gpt-5.4-mini');
  assert.equal(plan.model, 'gpt-5.4');
  assert.equal(explore.maxTurns, 10);
  assert.equal(plan.maxTurns, 12);
  assert.ok(getGraceTurns() >= 12);
  assert.match(generalPurpose.systemPrompt, /Turn Limit Check-In/);
  assert.match(explore.systemPrompt, /CHECK-IN with: current outcome\/status/i);
  assert.match(plan.systemPrompt, /whether you recommend CONTINUE or WRAP UP/i);
  assert.match(plan.systemPrompt, /Resume hint/i);
  assert.match(plan.systemPrompt, /Agent\(\{ resume: "<agent_id>"/i);
  assert.match(plan.systemPrompt, /reuse this session's current agent ID/i);
  assert.match(plan.systemPrompt, /narrow validation or contract checks/i);
});
