import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jitiFactory from '@mariozechner/jiti';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const ast = await jiti.import('../extensions/code-intel/ast.ts');
const codeIntelExtensionModule = await jiti.import('../extensions/code-intel/index.ts');
const codeIntelExtension = codeIntelExtensionModule.default ?? codeIntelExtensionModule;

const {
  buildRepoMap,
  clearCodeIntelAstCache,
  inferSearchMode,
  isIgnoredFilePath,
  runAstSearch,
} = ast;

test('inferSearchMode distinguishes simple identifiers from structural patterns', () => {
  assert.equal(inferSearchMode('promptMasterInjection'), 'symbol');
  assert.equal(inferSearchMode('pi.registerTool($$$ARGS)'), 'pattern');
});

test('ignored path helper filters obvious noise paths', () => {
  assert.equal(isIgnoredFilePath('/repo/node_modules/pkg/index.ts'), true);
  assert.equal(isIgnoredFilePath('/repo/.git/config.ts'), true);
  assert.equal(isIgnoredFilePath('/repo/src/file.generated.ts'), true);
  assert.equal(isIgnoredFilePath('/repo/extensions/code-intel/index.ts'), false);
});

test('buildRepoMap returns bounded AST-backed summaries on this repo', async () => {
  clearCodeIntelAstCache();

  const result = await buildRepoMap({
    cwd: repoRoot,
    path: 'extensions',
    maxFiles: 10,
    maxSymbols: 30,
  });

  assert.ok(result.scannedFiles > 0);
  assert.ok(result.totalSymbols > 0);
  assert.ok(result.fileSummaries.length > 0);
  assert.ok(result.text.length <= 9_000, `repo map too large: ${result.text.length}`);
  assert.ok(result.fileSummaries.every((file) => !file.path.includes('node_modules')));
  assert.ok(result.fileSummaries.every((file) => !file.path.includes('.git')));
  assert.match(result.text, /extensions\//);
  assert.match(result.text, /function|class|interface|type|enum|const/);
});

test('runAstSearch supports symbol search and ignores noisy paths', async () => {
  const result = await runAstSearch({
    cwd: repoRoot,
    path: 'extensions',
    query: 'promptMasterInjection',
    mode: 'symbol',
    limit: 10,
  });

  assert.equal(result.mode, 'symbol');
  assert.ok(result.matchCount >= 1);
  assert.ok(result.matches.some((match) => match.path.includes('prompt-master-injection/index.ts')));
  assert.ok(result.matches.every((match) => !match.path.includes('node_modules')));
  assert.ok(result.text.length <= 9_000, `symbol search too large: ${result.text.length}`);
});

test('runAstSearch supports structural pattern search with bounded previews', async () => {
  const result = await runAstSearch({
    cwd: repoRoot,
    path: 'extensions',
    query: 'pi.registerTool($$$ARGS)',
    mode: 'pattern',
    limit: 10,
  });

  assert.equal(result.mode, 'pattern');
  assert.ok(result.matchCount >= 1);
  assert.ok(result.matches.every((match) => match.preview.split('\n').length <= 3));
  assert.ok(result.matches.every((match) => !match.path.includes('node_modules')));
  assert.ok(result.text.length <= 9_000, `pattern search too large: ${result.text.length}`);
  assert.match(result.text, /pi\.registerTool/);
});

test('code-intel extension registers the AST tools without duplicate names', () => {
  const registeredTools = [];
  const registeredEvents = [];
  const pi = {
    on(eventName) {
      registeredEvents.push(eventName);
    },
    registerTool(tool) {
      registeredTools.push(tool.name);
    },
  };

  codeIntelExtension(pi);

  assert.deepEqual(registeredTools, [
    'code_intel_repo_map',
    'code_intel_ast_search',
    'code_intel_definition',
    'code_intel_references',
    'code_intel_hover',
  ]);
  assert.ok(registeredEvents.includes('session_shutdown'));
});
