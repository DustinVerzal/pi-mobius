import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';
import { visibleWidth } from '@mariozechner/pi-tui';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const footerModule = await jiti.import('../extensions/opencode-context-footer/index.ts');

const { installContextFooter, renderContextFooterLines } = footerModule;

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test('renderContextFooterLines shows path, branch, runtime context, and PLAN-first statuses', () => {
  const lines = renderContextFooterLines(theme, 120, {
    cwd: '/tmp/pi-mobius/extensions/opencode-plan-mode',
    branch: 'main',
    statuses: new Map([
      ['lint', 'LINT OK'],
      ['opencode-plan', 'PLAN 2/5 · batch 3'],
    ]),
    modelId: 'gpt-5',
    provider: 'openai',
    thinkingLevel: 'low',
    usage: {
      input: 1540,
      output: 900,
      cacheRead: 2500,
      cacheWrite: 0,
      cost: 0.1234,
    },
    contextUsage: {
      percent: 48.2,
      contextWindow: 200000,
    },
  });

  assert.equal(lines.length, 3);
  assert.match(lines[0], /\/tmp\/pi-mobius\/extensions\/opencode-plan-mode/);
  assert.match(lines[0], /git main/);
  assert.match(lines[1], /usage ↑1\.5k ↓900 R2\.5k \$0\.123/);
  assert.match(lines[1], /ctx 48\.2%\/200k/);
  assert.match(lines[1], /openai:gpt-5/);
  assert.match(lines[1], /thinking low/);
  assert.match(lines[2], /^PLAN 2\/5 · batch 3 · LINT OK$/);
  assert.equal((lines.join('\n').match(/PLAN/g) ?? []).length, 1);
});

test('renderContextFooterLines keeps narrow layouts readable without powerline separators', () => {
  const lines = renderContextFooterLines(theme, 52, {
    cwd: '/Users/dustinverzal/repos/pi-mobius/extensions/opencode-plan-mode/sidebar.ts',
    branch: 'feature/footer',
    statuses: new Map([
      ['opencode-plan', 'PLAN READY'],
      ['qa', 'QA green'],
    ]),
    modelId: 'claude-sonnet-4',
    provider: 'anthropic',
    thinkingLevel: 'high',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    contextUsage: {
      percent: 74.9,
      contextWindow: 200000,
    },
  });

  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('.../') || lines[0].includes('/.../'));
  assert.match(lines[0], /git/);
  assert.match(lines[1], /usage idle/);
  assert.match(lines[1], /ctx 74\.9%\/200k/);
  assert.match(lines[2], /PLAN READY/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 52));
  assert.ok(lines.every((line) => !/[]/.test(line)));
});

test('installContextFooter renders from footerData branch and extension statuses and requests re-render on branch changes', () => {
  let footerFactory;
  const pi = {
    on() {},
    getThinkingLevel() {
      return 'medium';
    },
  };

  const ctx = {
    hasUI: true,
    cwd: '/tmp/pi-mobius',
    model: {
      id: 'gpt-5-mini',
      provider: 'openai',
    },
    sessionManager: {
      getEntries() {
        return [
          {
            type: 'message',
            message: {
              role: 'assistant',
              usage: {
                input: 400,
                output: 200,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0.01 },
              },
            },
          },
        ];
      },
    },
    getContextUsage() {
      return {
        percent: 18.5,
        contextWindow: 200000,
      };
    },
    ui: {
      setFooter(factory) {
        footerFactory = factory;
      },
    },
  };

  installContextFooter(pi, ctx);
  assert.equal(typeof footerFactory, 'function');

  let branchListener;
  let unsubscribed = false;
  let requestRenderCalls = 0;
  const footerData = {
    getGitBranch() {
      return 'topic/footer';
    },
    getExtensionStatuses() {
      return new Map([
        ['other', 'LINT OK'],
        ['opencode-plan', 'PLAN REVIEW'],
      ]);
    },
    onBranchChange(callback) {
      branchListener = callback;
      return () => {
        unsubscribed = true;
      };
    },
  };

  const component = footerFactory({
    requestRender() {
      requestRenderCalls += 1;
    },
  }, theme, footerData);

  const lines = component.render(100);
  assert.match(lines[0], /git topic\/footer/);
  assert.match(lines[1], /openai:gpt-5-mini/);
  assert.match(lines[1], /thinking medium/);
  assert.match(lines[2], /^PLAN REVIEW · LINT OK$/);

  branchListener();
  assert.equal(requestRenderCalls, 1);

  component.dispose();
  assert.equal(unsubscribed, true);
});
