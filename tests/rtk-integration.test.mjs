import test from 'node:test';
import assert from 'node:assert/strict';
import jitiFactory from '@mariozechner/jiti';

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const rtk = await jiti.import('../extensions/rtk-integration/rewrite.ts');

const {
  RTK_BASH_ONLY_LIMITATION,
  createRtkSpawnHook,
  createRtkStatusSnapshot,
  formatRtkStatusReport,
  rewriteBashSpawnContextWithRtk,
  rewriteCommandWithRtk,
  rewriteModeSeverity,
} = rtk;

function createContext(command = 'git status') {
  return {
    command,
    cwd: '/repo',
    env: { PATH: '/usr/bin:/bin' },
  };
}

test('rewriteCommandWithRtk returns rewritten command when RTK succeeds', () => {
  const result = rewriteCommandWithRtk('git status', {
    runCommand: (_command, args) => ({
      stdout: `rtk exec -- ${args[1]}`,
      stderr: '',
      status: 0,
      signal: null,
    }),
  });

  assert.equal(result.status, 'rewritten');
  assert.equal(result.command, 'rtk exec -- git status');
  assert.equal(result.originalCommand, 'git status');
});

test('rewriteBashSpawnContextWithRtk preserves the original command when rewrite is unchanged', () => {
  const context = createContext('git status');
  const result = rewriteBashSpawnContextWithRtk(context, {
    runCommand: () => ({
      stdout: 'git status',
      stderr: '',
      status: 0,
      signal: null,
    }),
  });

  assert.equal(result, context);
  assert.equal(result.command, 'git status');
});

test('rewriteBashSpawnContextWithRtk preserves the original command when RTK is missing', () => {
  const context = createContext('rg TODO .');
  const result = rewriteBashSpawnContextWithRtk(context, {
    runCommand: () => {
      const error = new Error('spawn rtk ENOENT');
      error.code = 'ENOENT';
      return {
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error,
      };
    },
  });

  assert.equal(result, context);
  assert.equal(result.command, 'rg TODO .');
});

test('rewriteBashSpawnContextWithRtk preserves the original command when RTK rewrite fails', () => {
  const context = createContext('git status');
  const result = rewriteBashSpawnContextWithRtk(context, {
    runCommand: () => ({
      stdout: '',
      stderr: 'rtk backend unavailable',
      status: 1,
      signal: null,
    }),
  });

  assert.equal(result, context);
  assert.equal(result.command, 'git status');
});

test('createRtkSpawnHook fail-opens even if the runner throws unexpectedly', () => {
  const context = createContext('git status');
  const hook = createRtkSpawnHook({
    runCommand: () => {
      throw new Error('boom');
    },
  });

  const result = hook(context);
  assert.equal(result, context);
});

test('status snapshot reports active rewriting when RTK is available', () => {
  const snapshot = createRtkStatusSnapshot({
    runCommand: (_command, args) => ({
      stdout: args[0] === '--version' ? 'rtk 1.2.3' : '',
      stderr: '',
      status: 0,
      signal: null,
    }),
  });

  const report = formatRtkStatusReport(snapshot);

  assert.equal(snapshot.rewriteActive, true);
  assert.equal(snapshot.fallbackMode, 'disabled');
  assert.equal(rewriteModeSeverity(snapshot), 'info');
  assert.equal(snapshot.limitation, RTK_BASH_ONLY_LIMITATION);
  assert.match(report, /RTK binary: available/);
  assert.match(report, /Bash rewriting: active via rtk rewrite/);
  assert.match(report, /git status/);
});

test('status snapshot reports safe pass-through with concrete next steps when RTK is missing', () => {
  const snapshot = createRtkStatusSnapshot({
    runCommand: () => {
      const error = new Error('spawn rtk ENOENT');
      error.code = 'ENOENT';
      return {
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error,
      };
    },
  });

  const report = formatRtkStatusReport(snapshot);

  assert.equal(snapshot.rewriteActive, false);
  assert.equal(snapshot.fallbackMode, 'pass_through');
  assert.equal(rewriteModeSeverity(snapshot), 'warning');
  assert.match(report, /RTK binary: missing/);
  assert.match(report, /Bash rewriting: fail-open pass-through/);
  assert.match(report, /Install RTK separately and ensure `rtk` is on PATH/);
  assert.match(report, /run `\/reload` or restart Pi/);
  assert.match(report, /read, grep, find, ls/);
});
