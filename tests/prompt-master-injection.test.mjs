import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const promptMasterInjectionModule = await jiti.import('../extensions/prompt-master-injection/index.ts');
const promptMasterInjection = promptMasterInjectionModule.default ?? promptMasterInjectionModule;

function setupHarness(branch = []) {
  const commands = new Map();
  const tools = new Map();
  const sentMessages = [];
  const notifications = [];

  const pi = {
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    sendUserMessage(text, options) {
      sentMessages.push({ text, options });
    },
  };

  promptMasterInjection(pi);

  const ctx = {
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      async editor() {
        return undefined;
      },
    },
    sessionManager: {
      getBranch: () => branch,
    },
    isIdle: () => true,
  };

  return { commands, tools, sentMessages, notifications, ctx };
}

test('prompt-improve command is blocked during active plan workflow', async () => {
  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: { mode: 'planning' },
  }];
  const { commands, ctx, sentMessages, notifications } = setupHarness(branch);

  await commands.get('prompt-improve').handler('tighten this prompt', ctx);

  assert.equal(sentMessages.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /disabled during an active plan workflow/i);
  assert.match(notifications[0].message, /rerun \/plan <request> to start a fresh planning session/i);
});

test('prompt_improve tool is blocked during execution workflow', async () => {
  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: { mode: 'executing' },
  }];
  const { tools, ctx, sentMessages } = setupHarness(branch);

  await assert.rejects(
    tools.get('prompt_improve').execute('call_prompt_improve_1', { request: 'tighten this prompt' }, undefined, undefined, ctx),
    /rerun \/plan <request> to start a fresh planning session/i,
  );
  assert.equal(sentMessages.length, 0);
});

test('prompt-improve command still works in normal mode', async () => {
  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: { mode: 'normal' },
  }];
  const { commands, ctx, sentMessages, notifications } = setupHarness(branch);

  await commands.get('prompt-improve').handler('tighten this prompt', ctx);

  assert.equal(notifications.length, 0);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /^\/skill:prompt-master /);
});

test('pm alias still works in normal mode', async () => {
  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: { mode: 'normal' },
  }];
  const { commands, ctx, sentMessages } = setupHarness(branch);

  await commands.get('pm').handler('tighten this prompt', ctx);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /^\/skill:prompt-master /);
});

test('prompt_improve tool still works in normal mode', async () => {
  const branch = [{
    type: 'custom',
    customType: 'opencode-plan-state',
    data: { mode: 'normal' },
  }];
  const { tools, ctx, sentMessages } = setupHarness(branch);

  const result = await tools.get('prompt_improve').execute(
    'call_prompt_improve_1',
    { request: 'tighten this prompt', targetTool: 'Cursor' },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /^\/skill:prompt-master /);
  assert.match(result.content[0].text, /Queued prompt-master to improve the prompt for Cursor\./);
  assert.equal(result.details.target, 'Cursor');
});
