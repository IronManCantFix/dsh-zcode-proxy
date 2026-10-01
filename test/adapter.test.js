/**
 * Unit tests for the Anthropic translation layer.
 *
 * Run with: node --test test/*.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRequestBody,
  classifyFailure,
  readFailure,
  sendMessages,
  streamMessages,
  UpstreamError,
} from '../src/transport.js'
import {
  mapFinishReason,
  toAnthropicMessages,
  toAnthropicTools,
} from '../src/adapter.js'
import { canonicalModelId, metadataFor, reasoningOptions } from '../src/catalog.js'

const IDENTITY = { blocks: [{ type: 'text', text: 'identity-prefix' }] }

/**
 * @param {string} body
 * @param {number} [status]
 */
function sseResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * Build an SSE payload from raw frames.
 *
 * @param {Array<Record<string, unknown>>} events
 */
function ssePayload(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

test('toAnthropicMessages maps text blocks and merges same-role turns', () => {
  const messages = toAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'three' }] },
  ])
  // Consecutive user turns must collapse; the endpoint rejects them otherwise.
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  })
  assert.equal(messages[1].role, 'assistant')
})

test('toAnthropicMessages accepts a bare string content', () => {
  const messages = toAnthropicMessages([{ role: 'user', content: 'hello' }])
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'hello' }])
})

test('toAnthropicMessages drops reasoning blocks', () => {
  const messages = toAnthropicMessages([
    { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }] },
  ])
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'answer' }])
})

test('toAnthropicMessages maps tool calls to tool_use', () => {
  const messages = toAnthropicMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: 'file body' }],
    },
  ])
  assert.deepEqual(messages[0].content[0], {
    type: 'tool_use',
    id: 'call-1',
    name: 'read_file',
    input: { path: 'a.ts' },
  })
  assert.deepEqual(messages[1].content[0], {
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: 'file body',
  })
})

test('toAnthropicMessages parses stringified tool arguments', () => {
  const messages = toAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'n', arguments: '{"a":1}' }] },
  ])
  assert.deepEqual(messages[0].content[0].input, { a: 1 })
})

test('toAnthropicMessages skips empty turns', () => {
  assert.deepEqual(toAnthropicMessages([{ role: 'user', content: [] }]), [])
  assert.deepEqual(toAnthropicMessages(undefined), [])
})

test('toAnthropicTools maps field names', () => {
  const tools = toAnthropicTools([
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
    { name: 'no_schema' },
    { description: 'nameless, dropped' },
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'read_file')
  assert.deepEqual(tools[0].input_schema, { type: 'object' })
  assert.deepEqual(tools[1].input_schema, { type: 'object', properties: {} })
})

test('toAnthropicTools returns undefined for no tools', () => {
  assert.equal(toAnthropicTools([]), undefined)
  assert.equal(toAnthropicTools(undefined), undefined)
})

test('buildRequestBody puts identity blocks ahead of the caller system prompt', () => {
  const body = buildRequestBody({
    model: 'GLM-5.3-Flash',
    maxTokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    identityBlocks: IDENTITY.blocks,
    system: 'caller prompt',
    stream: true,
  })
  assert.deepEqual(body.system, [
    { type: 'text', text: 'identity-prefix' },
    { type: 'text', text: 'caller prompt' },
  ])
  assert.equal(body.stream, true)
  assert.equal(body.tool_choice, undefined)
})

test('buildRequestBody carries reasoning options onto the body', () => {
  const body = buildRequestBody({
    model: 'GLM-5.3',
    maxTokens: 10,
    messages: [],
    identityBlocks: IDENTITY.blocks,
    reasoning: { thinking: { type: 'enabled' }, output_config: { effort: 'max' } },
  })
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.deepEqual(body.output_config, { effort: 'max' })
})

test('readFailure understands the several upstream envelopes', () => {
  assert.deepEqual(readFailure({ code: 3012, msg: 'blocked', logid: 'l1' }), {
    code: 3012,
    message: 'blocked',
    requestId: 'l1',
  })
  assert.deepEqual(readFailure({ error: { code: '1309', message: 'expired' } }), {
    code: 1309,
    message: 'expired',
    requestId: undefined,
  })
  assert.deepEqual(readFailure({ error_code: 7, message: 'x' }), {
    code: 7,
    message: 'x',
    requestId: undefined,
  })
  assert.deepEqual(readFailure('not an object'), {
    code: undefined,
    message: undefined,
    requestId: undefined,
  })
})

test('classifyFailure maps each failure to a distinct kind', () => {
  const blocked = classifyFailure({ status: 405, body: { code: 3012, msg: 'blocked' } })
  assert.equal(blocked.kind, 'blocked')
  assert.match(blocked.hint ?? '', /refresh-identity/)

  const plan = classifyFailure({ status: 429, body: { error: { code: 1309, message: 'expired' } } })
  assert.equal(plan.kind, 'plan')

  const auth = classifyFailure({ status: 401, body: { msg: 'VERIFY_SIGNATURE_INVALID' } })
  assert.equal(auth.kind, 'auth')

  const limited = classifyFailure({ status: 429, body: { msg: 'slow down' } })
  assert.equal(limited.kind, 'rate-limit')
  assert.equal(limited.retryable, true)

  const context = classifyFailure({ status: 400, body: { message: 'context_length_exceeded' } })
  assert.equal(context.kind, 'context')

  const server = classifyFailure({ status: 503, body: {} })
  assert.equal(server.kind, 'server')
})

test('streamMessages yields parsed events', async () => {
  const payload = ssePayload([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ])

  const seen = []
  for await (const chunk of streamMessages({
    credential: { jwt: 'jwt' },
    identity: IDENTITY,
    model: 'GLM-5.3-Flash',
    maxTokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: /** @type {typeof fetch} */ (async () => sseResponse(payload)),
  })) {
    seen.push(chunk.json?.type)
  }

  assert.deepEqual(seen, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
  ])
})

test('streamMessages throws a classified error on a failed response', async () => {
  await assert.rejects(
    async () => {
      for await (const _ of streamMessages({
        credential: { jwt: 'jwt' },
        identity: IDENTITY,
        model: 'GLM-5.3-Flash',
        maxTokens: 10,
        messages: [],
        fetchImpl: /** @type {typeof fetch} */ (
          async () => new Response(JSON.stringify({ code: 3012, msg: 'blocked' }), { status: 405 })
        ),
      })) {
        // consume
      }
    },
    (error) => error instanceof UpstreamError && error.kind === 'blocked',
  )
})

test('streamMessages requires a credential', async () => {
  await assert.rejects(
    async () => {
      for await (const _ of streamMessages({
        credential: {},
        identity: IDENTITY,
        model: 'm',
        maxTokens: 1,
        messages: [],
      })) {
        // consume
      }
    },
    /no usable credential/,
  )
})

test('streamMessages reports a network failure as retryable', async () => {
  await assert.rejects(
    async () => {
      for await (const _ of streamMessages({
        credential: { jwt: 'jwt' },
        identity: IDENTITY,
        model: 'm',
        maxTokens: 1,
        messages: [],
        fetchImpl: /** @type {typeof fetch} */ (async () => {
          throw new Error('socket hang up')
        }),
      })) {
        // consume
      }
    },
    (error) => error instanceof UpstreamError && error.kind === 'network' && error.retryable,
  )
})

test('sendMessages assembles text, thinking, usage and stop reason', async () => {
  const payload = ssePayload([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  ])

  const result = await sendMessages({
    credential: { jwt: 'jwt' },
    identity: IDENTITY,
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: /** @type {typeof fetch} */ (async () => sseResponse(payload)),
  })

  assert.equal(result.text, 'ok')
  assert.equal(result.thinking, 'hmm')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.usage.input_tokens, 5)
  assert.equal(result.usage.output_tokens, 3)
})

test('sendMessages raises when the stream carries an error frame', async () => {
  const payload = ssePayload([
    { type: 'message_start', message: {} },
    { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
  ])

  await assert.rejects(
    () =>
      sendMessages({
        credential: { jwt: 'jwt' },
        identity: IDENTITY,
        model: 'm',
        messages: [],
        fetchImpl: /** @type {typeof fetch} */ (async () => sseResponse(payload)),
      }),
    /busy/,
  )
})

test('mapFinishReason normalises the upstream stop reasons', () => {
  assert.equal(mapFinishReason('tool_use'), 'tool-calls')
  assert.equal(mapFinishReason('max_tokens'), 'length')
  assert.equal(mapFinishReason('end_turn'), 'stop')
  assert.equal(mapFinishReason(undefined), 'stop')
})

test('catalog metadata matches the values ZCode ships', () => {
  const meta = metadataFor('GLM-5.3-Flash')
  assert.equal(meta.contextWindow, 1_000_000)
  assert.equal(meta.maxOutputTokens, 128_000)
  assert.deepEqual([...meta.reasoningLevels], ['low', 'high', 'max'])
})

test('canonicalModelId normalises entitlement ids', () => {
  assert.equal(canonicalModelId('glm-5.3'), 'GLM-5.3')
  assert.equal(canonicalModelId('glm-5.3-flash'), 'GLM-5.3-Flash')
  assert.equal(canonicalModelId('GLM-5.3'), 'GLM-5.3')
})

test('reasoningOptions builds the wire shape the plan endpoint expects', () => {
  assert.deepEqual(reasoningOptions('max'), {
    thinking: { type: 'enabled' },
    output_config: { effort: 'max' },
  })
  assert.deepEqual(reasoningOptions('disabled'), { thinking: { type: 'disabled' } })
  assert.equal(reasoningOptions(undefined), undefined)
})
