import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import jitiFactory from '@mariozechner/jiti';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const tsLanguageServerPath = resolve(repoRoot, 'node_modules/.bin/typescript-language-server');
const tsLanguageServerWindowsPath = `${tsLanguageServerPath}.cmd`;

const hasLanguageServer = existsSync(tsLanguageServerPath) || existsSync(tsLanguageServerWindowsPath);
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const lsp = await jiti.import('../extensions/code-intel/lsp.ts');

if (!hasLanguageServer) {
  test('typescript language server dependency is installed for LSP tests', { skip: 'typescript-language-server is not installed' }, () => {});
} else {
  test('definition lookup resolves a local helper function', async () => {
    const result = await lsp.lookupTypeScriptDefinition({
      cwd: repoRoot,
      filePath: 'extensions/code-intel/lsp.ts',
      line: 487,
      column: 22,
    });

    assert.match(result.text, /TypeScript definition lookup/);
    assert.match(result.text, /extensions\/code-intel\/lsp.ts:L219:10/);
    assert.match(result.text, /function renderTruncatedText/);
    await lsp.clearCodeIntelLspClients();
  });

  test('references lookup groups semantic references without protocol dumps', async () => {
    const result = await lsp.lookupTypeScriptReferences({
      cwd: repoRoot,
      filePath: 'extensions/code-intel/lsp.ts',
      line: 502,
      column: 5,
    });

    assert.match(result.text, /TypeScript references/);
    assert.match(result.text, /Found 4 reference\(s\) across 1 file\(s\)/);
    assert.match(result.text, /ensureSupportedTypeScriptFile/);
    assert.doesNotMatch(result.text, /"uri"\s*:/);
    await lsp.clearCodeIntelLspClients();
  });

  test('hover lookup returns a bounded compact signature summary', async () => {
    const result = await lsp.lookupTypeScriptHover({
      cwd: repoRoot,
      filePath: 'extensions/code-intel/lsp.ts',
      line: 347,
      column: 117,
    });

    assert.match(result.text, /TypeScript hover/);
    assert.match(result.text, /function actionableMissingServerMessage/);
    assert.ok(result.text.length <= 2500, `hover output too large: ${result.text.length}`);
    await lsp.clearCodeIntelLspClients();
  });
}

test('missing language server produces an actionable setup error', async () => {
  const fixtureDir = await mkdtemp(resolve(tmpdir(), 'pi-code-intel-'));
  await mkdir(resolve(fixtureDir, '.pi'), { recursive: true });
  await writeFile(resolve(fixtureDir, '.pi/settings.json'), JSON.stringify({
    codeIntel: {
      lsp: {
        typescript: {
          command: ['definitely-missing-typescript-language-server', '--stdio'],
        },
      },
    },
  }, null, 2));
  await writeFile(resolve(fixtureDir, 'sample.ts'), 'export function sample(value: number) {\n  return value + 1;\n}\n');

  await assert.rejects(
    () => lsp.lookupTypeScriptHover({
      cwd: fixtureDir,
      filePath: 'sample.ts',
      line: 1,
      column: 18,
    }),
    /Install the local dependencies with `npm install`, then run `\/reload`/,
  );

  await lsp.clearCodeIntelLspClients();
});
