import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

import { AuthStorage } from '../node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js';
import { ModelRegistry } from '../node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.js';
import { resolveModelScope } from '../node_modules/@mariozechner/pi-coding-agent/dist/core/model-resolver.js';

test('openai-codex FAST can be discovered and selected through models.json serviceTier overrides', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pi-codex-fast-'));
  const modelsPath = path.join(tempDir, 'models.json');

  try {
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        'openai-codex': {
          modelOverrides: {
            'gpt-5.4': {
              serviceTier: 'priority',
            },
          },
        },
      },
    }, null, 2));

    const authStorage = AuthStorage.inMemory({
      'openai-codex': { type: 'api_key', key: 'test-key' },
    });
    const modelRegistry = new ModelRegistry(authStorage, modelsPath);

    const model = modelRegistry.find('openai-codex', 'gpt-5.4');
    assert.ok(model, 'expected built-in openai-codex model to remain available');
    assert.equal(model.serviceTier, 'priority');
    assert.equal(model.compat?.serviceTier, 'priority');
    assert.equal(model.compat?.fastServiceTier, 'priority');
    assert.match(model.name, /FAST/i);

    const scopedModels = await resolveModelScope(['fast'], modelRegistry);
    assert.equal(scopedModels.length, 1);
    assert.equal(scopedModels[0]?.model.provider, 'openai-codex');
    assert.equal(scopedModels[0]?.model.id, 'gpt-5.4');
    assert.equal(scopedModels[0]?.model.serviceTier, 'priority');
    assert.equal(scopedModels[0]?.model.compat?.serviceTier, 'priority');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('provider-level serviceTier applies the Codex FAST selection surface to built-in gpt-5.4', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pi-codex-fast-provider-'));
  const modelsPath = path.join(tempDir, 'models.json');

  try {
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        'openai-codex': {
          serviceTier: 'priority',
        },
      },
    }, null, 2));

    const authStorage = AuthStorage.inMemory({
      'openai-codex': { type: 'api_key', key: 'test-key' },
    });
    const modelRegistry = new ModelRegistry(authStorage, modelsPath);
    const model = modelRegistry.find('openai-codex', 'gpt-5.4');

    assert.ok(model);
    assert.equal(model.serviceTier, 'priority');
    assert.equal(model.compat?.serviceTier, 'priority');
    assert.match(model.name, /FAST/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
