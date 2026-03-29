import test from 'node:test';
import assert from 'node:assert/strict';

import { getModel } from '../node_modules/@mariozechner/pi-ai/dist/models.js';
import { streamSimpleOpenAICodexResponses } from '../node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js';

function createCodexApiKey(accountId = 'acct_test_fast') {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  })}.signature`;
}

function createSseResponse(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('openai-codex FAST keeps gpt-5.4 as the request model and sends priority tier', async () => {
  const model = getModel('openai-codex', 'gpt-5.4');
  assert.ok(model, 'expected openai-codex gpt-5.4 model to exist');
  assert.equal(model.provider, 'openai-codex');
  assert.equal(model.id, 'gpt-5.4');
  assert.equal(model.compat?.fastServiceTier, 'priority');

  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: JSON.parse(init.body),
    });

    return createSseResponse({
      type: 'response.completed',
      response: {
        id: 'resp_fast_1',
        status: 'completed',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    });
  };

  try {
    const stream = streamSimpleOpenAICodexResponses(
      model,
      {
        systemPrompt: 'You are fast.',
        messages: [
          {
            role: 'user',
            content: 'hi',
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: createCodexApiKey(),
        fast: true,
      },
    );

    const result = await stream.result();
    assert.equal(result.stopReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.body.model, 'gpt-5.4');
  assert.notEqual(request.body.model, 'gpt-5.3-codex-spark');
  assert.equal(request.body.service_tier, 'priority');
  assert.equal(request.body.instructions, 'You are fast.');
  assert.equal(request.headers.get('accept'), 'text/event-stream');
});

test('openai-codex model-level service tier drives the outgoing Codex request', async () => {
  const baseModel = getModel('openai-codex', 'gpt-5.4');
  assert.ok(baseModel);
  const model = {
    ...baseModel,
    serviceTier: 'priority',
  };

  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    capturedBody = JSON.parse(init.body);
    return createSseResponse({
      type: 'response.completed',
      response: {
        id: 'resp_priority_1',
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    });
  };

  try {
    const stream = streamSimpleOpenAICodexResponses(
      model,
      {
        messages: [
          {
            role: 'user',
            content: 'hello',
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: createCodexApiKey('acct_test_service_tier'),
      },
    );

    await stream.result();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedBody.model, 'gpt-5.4');
  assert.equal(capturedBody.service_tier, 'priority');
});
