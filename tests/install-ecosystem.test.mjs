import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS_PATCH,
  buildInstallPlan,
  isLikelyLocalSource,
  mergeSettings,
  parseArgs,
  settingsPathForScope,
} from '../scripts/install-pi-mobius-ecosystem.mjs';

test('parseArgs resolves local-scope options and subset filters', () => {
  const options = parseArgs([
    '--scope', 'local',
    '--project', '~/consumer-project',
    '--self-source', 'git:github.com/example/pi-mobius',
    '--only', 'pi-mobius,pi-context',
    '--pi-command', 'pi-beta',
    '--dry-run',
  ], {
    cwd: '/repo/pi-mobius',
    homeDir: '/Users/tester',
    repoRoot: '/repo/pi-mobius',
  });

  assert.equal(options.scope, 'local');
  assert.equal(options.projectPath, '/Users/tester/consumer-project');
  assert.equal(options.selfSource, 'git:github.com/example/pi-mobius');
  assert.deepEqual(options.only, ['pi-mobius', 'pi-context']);
  assert.equal(options.piCommand, 'pi-beta');
  assert.equal(options.dryRun, true);
});

test('buildInstallPlan includes the current ecosystem packages by default', () => {
  const plan = buildInstallPlan({
    cwd: '/repo/pi-mobius',
    homeDir: '/Users/tester',
    repoRoot: '/repo/pi-mobius',
    scope: 'global',
    projectPath: '/work/project',
    dryRun: false,
    help: false,
    only: undefined,
    piCommand: 'pi',
    selfSource: undefined,
    skipSelf: false,
    skipSettings: false,
  });

  assert.deepEqual(
    plan.packages.map((pkg) => [pkg.id, pkg.source]),
    [
      ['pi-mobius', '/repo/pi-mobius'],
      ['pi-tool-display', 'npm:pi-tool-display'],
      ['pi-context', 'npm:pi-context'],
      ['pi-web-access', 'npm:pi-web-access'],
      ['pi-mcp-adapter', 'npm:pi-mcp-adapter'],
    ],
  );
  assert.equal(plan.settingsPath, '/Users/tester/.pi/agent/settings.json');
  assert.deepEqual(plan.settingsPatch, DEFAULT_SETTINGS_PATCH);
});

test('buildInstallPlan supports targeted subsets and local settings path', () => {
  const plan = buildInstallPlan({
    cwd: '/repo/pi-mobius',
    homeDir: '/Users/tester',
    repoRoot: '/repo/pi-mobius',
    scope: 'local',
    projectPath: '/work/consumer',
    dryRun: false,
    help: false,
    only: ['pi-context'],
    piCommand: 'pi',
    selfSource: undefined,
    skipSelf: false,
    skipSettings: false,
  });

  assert.deepEqual(
    plan.packages.map((pkg) => pkg.id),
    ['pi-context'],
  );
  assert.equal(plan.settingsPath, '/work/consumer/.pi/settings.json');
});

test('mergeSettings preserves unrelated values while applying the ecosystem defaults', () => {
  const merged = mergeSettings({
    packages: ['npm:existing-package'],
    theme: 'other-theme',
    defaultProvider: 'openai-codex',
  }, DEFAULT_SETTINGS_PATCH);

  assert.deepEqual(merged.packages, ['npm:existing-package']);
  assert.equal(merged.theme, 'opencode-nord');
  assert.equal(merged.defaultProvider, 'openai-codex');
  assert.equal(merged.showHardwareCursor, true);
});

test('source helpers distinguish local sources from npm and git specs', () => {
  assert.equal(isLikelyLocalSource('/repo/pi-mobius'), true);
  assert.equal(isLikelyLocalSource('./pi-mobius'), true);
  assert.equal(isLikelyLocalSource('npm:pi-context'), false);
  assert.equal(isLikelyLocalSource('https://github.com/example/pi-mobius'), false);
});

test('settingsPathForScope returns global and local Pi settings locations', () => {
  assert.equal(
    settingsPathForScope('global', { projectPath: '/work/consumer', homeDir: '/Users/tester' }),
    '/Users/tester/.pi/agent/settings.json',
  );
  assert.equal(
    settingsPathForScope('local', { projectPath: '/work/consumer', homeDir: '/Users/tester' }),
    '/work/consumer/.pi/settings.json',
  );
});
