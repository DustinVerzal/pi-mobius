import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const guidanceModule = await jiti.import('../extensions/code-intel-guidance/index.ts');
const guidance = guidanceModule.default ?? guidanceModule;
const {
  buildCodeIntelRoutingInstructions,
  hasCodeIntelTooling,
} = guidanceModule;

function createTool(name) {
  return { name };
}

test('hasCodeIntelTooling returns true only when all shipped code-intel tools are available', () => {
  assert.equal(hasCodeIntelTooling({
    getAllTools() {
      return [
        createTool('code_intel_repo_map'),
        createTool('code_intel_ast_search'),
        createTool('code_intel_definition'),
        createTool('code_intel_references'),
        createTool('code_intel_hover'),
      ];
    },
  }), true);

  assert.equal(hasCodeIntelTooling({
    getAllTools() {
      return [
        createTool('code_intel_repo_map'),
        createTool('code_intel_ast_search'),
      ];
    },
  }), false);
});

test('buildCodeIntelRoutingInstructions emphasizes code-intel-first JS/TS exploration', () => {
  const text = buildCodeIntelRoutingInstructions();
  assert.match(text, /do not start with grep/i);
  assert.match(text, /code_intel_repo_map/);
  assert.match(text, /code_intel_ast_search/);
  assert.match(text, /code_intel_definition, code_intel_references, and code_intel_hover/);
});

test('guidance extension injects routing instructions into the system prompt for every turn when code-intel is available', async () => {
  let beforeAgentStart;
  const pi = {
    getAllTools() {
      return [
        createTool('read'),
        createTool('grep'),
        createTool('code_intel_repo_map'),
        createTool('code_intel_ast_search'),
        createTool('code_intel_definition'),
        createTool('code_intel_references'),
        createTool('code_intel_hover'),
      ];
    },
    on(eventName, handler) {
      if (eventName === 'before_agent_start') beforeAgentStart = handler;
    },
  };

  guidance(pi);

  assert.equal(typeof beforeAgentStart, 'function');
  const result = await beforeAgentStart({ systemPrompt: 'Base prompt', prompt: 'Inspect the repo' }, {});
  assert.match(result.systemPrompt, /^Base prompt/);
  assert.match(result.systemPrompt, /Tool routing guidance for better code exploration/);
  assert.match(result.systemPrompt, /Use code_intel_repo_map/);
  assert.match(result.systemPrompt, /do not start with grep/i);
});

test('guidance extension stays silent when code-intel tools are unavailable', async () => {
  let beforeAgentStart;
  const pi = {
    getAllTools() {
      return [createTool('read'), createTool('grep')];
    },
    on(eventName, handler) {
      if (eventName === 'before_agent_start') beforeAgentStart = handler;
    },
  };

  guidance(pi);

  const result = await beforeAgentStart({ systemPrompt: 'Base prompt', prompt: 'Inspect the repo' }, {});
  assert.equal(result, undefined);
});
