/**
 * Unit tests for the identity snapshot and the adapter's chunk mapping.
 *
 * Run with: node --test test/*.test.js
 *
 * The identity and chunk-mapping tests exist because reverse verification
 * showed the earlier suite did not catch two real regressions: reversing the
 * identity block order, and hard-coding the delta index. Both would have
 * shipped a provider that silently stopped working.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectIdentity,
  loadBundledIdentityBlocks,
  MIN_SAFE_IDENTITY_CHARS,
  readJoinerArraySection,
  readStringLiteral,
  unescapeJsString,
} from '../src/identity.js'
import { ZcodeAdapter } from '../src/adapter.js'

// ---------------------------------------------------------------------------
// Identity snapshot
// ---------------------------------------------------------------------------

test('the bundled identity snapshot loads with usable blocks', () => {
  const loaded = loadBundledIdentityBlocks()
  assert.ok(loaded.blocks.length >= 2, 'expected at least two identity blocks')
  for (const block of loaded.blocks) {
    assert.equal(block.type, 'text')
    assert.equal(typeof block.text, 'string')
    assert.ok(block.text.length > 0)
  }
})

test('the first identity block is the CLI prefix, in that order', () => {
  // Order matters: the gateway's content check reads the prefix. Swapping the
  // blocks is a silent failure that only shows up as a 3012 at runtime, so it
  // is pinned here.
  const loaded = loadBundledIdentityBlocks()
  assert.equal(loaded.blocks[0].text, 'You are ZCode, an interactive coding agent')
  assert.match(loaded.blocks[1].text, /You are an interactive ZCode agent/)
})

test('the identity snapshot records where it came from', () => {
  const loaded = loadBundledIdentityBlocks()
  assert.ok(loaded.provenance, 'expected provenance metadata')
  assert.equal(typeof loaded.provenance.extractedFrom, 'string')
  assert.match(String(loaded.provenance.sha256OfSource), /^[0-9a-f]{64}$/)
})

test('inspectIdentity reports a healthy snapshot', () => {
  const inspection = inspectIdentity(loadBundledIdentityBlocks())
  assert.ok(inspection.chars >= MIN_SAFE_IDENTITY_CHARS)
  assert.equal(inspection.healthy, true)
  assert.equal(inspection.warning, undefined)
})

test('inspectIdentity warns on a snapshot below the safe floor', () => {
  const inspection = inspectIdentity({ blocks: [{ type: 'text', text: 'too short' }] })
  assert.equal(inspection.healthy, false)
  assert.match(inspection.warning, /3012/)
})

// ---------------------------------------------------------------------------
// Bundle extraction helpers
// ---------------------------------------------------------------------------

test('unescapeJsString handles the escapes a bundle actually contains', () => {
  assert.equal(unescapeJsString('a\\nb'), 'a\nb')
  assert.equal(unescapeJsString("don\\'t"), "don't")
  assert.equal(unescapeJsString('\\u2014'), '\u2014')
  assert.equal(unescapeJsString('\\x41'), 'A')
  assert.equal(unescapeJsString('plain'), 'plain')
})

test('readStringLiteral reads a named literal', () => {
  const source = 'var x,y;y="hello\\nworld";z=1;'
  assert.equal(readStringLiteral(source, 'y'), 'hello\nworld')
  assert.equal(readStringLiteral(source, 'missing'), undefined)
})

test('readJoinerArraySection joins an array literal with newlines', () => {
  const source = 'function f(){return["# Harness","one","two"].join(`\\n`)}'
  assert.equal(readJoinerArraySection(source, '# Harness'), '# Harness\none\ntwo')
})

test('readJoinerArraySection returns undefined for an absent marker', () => {
  assert.equal(readJoinerArraySection('function f(){return["x"].join(`\\n`)}', '# Harness'), undefined)
})

// ---------------------------------------------------------------------------
// Adapter chunk mapping
// ---------------------------------------------------------------------------

/**
 * Drive the adapter against a canned SSE stream.
 *
 * The credential, identity snapshot and transport are all injected so the test
 * is deterministic and does not touch the machine's real sign-in.
 *
 * @param {Array<Record<string, unknown>>} events
 * @param {Record<string, unknown>} [options]
 */
async function collectChunks(events, options = {}) {
  const payload = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')

  const adapter = new ZcodeAdapter({
    loadCredential: () => ({
      provider: 'bigmodel',
      accessToken: 'token',
      jwt: 'jwt',
      savedAt: '2026-10-01T00:00:00.000Z',
    }),
    loadIdentity: () => ({ blocks: [{ type: 'text', text: 'identity-prefix' }] }),
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = /** @type {any} */ (
    async () =>
      new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  )

  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      model: options.model ?? 'GLM-5.3-Flash',
      provider: 'zcode',
      maxTokens: options.maxTokens ?? 100,
      messages: options.messages ?? [{ role: 'user', content: 'hi' }],
      reasoningEffort: options.reasoningEffort,
    })) {
      chunks.push(chunk)
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  return chunks
}

test('the adapter maps a text stream onto DSH chunks', async () => {
  const chunks = await collectChunks([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ])

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(chunks[1].text, 'hello')
  assert.equal(chunks[1].index, 0)
  assert.equal(chunks.at(-1).reason, 'stop')
})

test('the adapter preserves the upstream block index', async () => {
  // Hard-coding the index to 0 would merge separate blocks and corrupt
  // multi-part replies, so the passthrough is pinned.
  const chunks = await collectChunks([
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'why' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ])

  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.deepEqual(starts.map((chunk) => chunk.index), [0, 1])
  assert.deepEqual(starts.map((chunk) => chunk.blockType), ['reasoning', 'text'])

  const reasoning = chunks.find((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(reasoning.index, 0)
  assert.equal(reasoning.text, 'why')

  const text = chunks.find((chunk) => chunk.type === 'text-delta')
  assert.equal(text.index, 1)
  assert.equal(text.text, 'answer')
})

test('the adapter maps a tool call onto tool-call chunks', async () => {
  const chunks = await collectChunks([
    { type: 'message_start', message: {} },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call-1', name: 'read_file' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"a.ts"}' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ])

  const start = chunks.find((chunk) => chunk.type === 'block-start')
  assert.equal(start.blockType, 'tool-call')

  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(deltas[0].id, 'call-1')
  assert.equal(deltas[0].name, 'read_file')
  assert.equal(deltas.map((chunk) => chunk.argumentsDelta).join(''), '{"path":"a.ts"}')

  assert.equal(chunks.at(-1).reason, 'tool-calls')
})

test('the adapter reports max_tokens as length', async () => {
  const chunks = await collectChunks([
    { type: 'message_start', message: {} },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
  ])
  assert.equal(chunks.at(-1).reason, 'length')
})

test('the adapter emits usage before finish', async () => {
  const chunks = await collectChunks([
    { type: 'message_start', message: { usage: { input_tokens: 7 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  ])
  const types = chunks.map((chunk) => chunk.type)
  assert.ok(types.indexOf('usage') < types.indexOf('finish'))
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.usage.input_tokens, 7)
  assert.equal(usage.usage.output_tokens, 2)
})

test('the adapter raises on a mid-stream error frame', async () => {
  await assert.rejects(
    () =>
      collectChunks([
        { type: 'message_start', message: {} },
        { type: 'error', error: { message: 'overloaded' } },
      ]),
    /overloaded/,
  )
})

/**
 * Capture the outgoing request body from one adapter run.
 *
 * @param {Record<string, unknown>} generateOptions
 * @returns {Promise<Record<string, any>>}
 */
async function captureRequestBody(generateOptions) {
  const adapter = new ZcodeAdapter({
    loadCredential: () => ({ provider: 'bigmodel', accessToken: 't', jwt: 'jwt' }),
    loadIdentity: () => ({ blocks: [{ type: 'text', text: 'identity-prefix' }] }),
  })

  /** @type {Record<string, any>} */
  let sent
  const originalFetch = globalThis.fetch
  globalThis.fetch = /** @type {any} */ (async (_url, init) => {
    sent = JSON.parse(String(init.body))
    return new Response(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  })

  try {
    for await (const _ of adapter.stream({
      model: 'GLM-5.3-Flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      ...generateOptions,
    })) {
      // consume
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(sent, 'the adapter did not issue a request')
  return sent
}

test('the adapter forwards the identity blocks and the caller system prompt', async () => {
  const body = await captureRequestBody({ system: 'caller instructions' })
  assert.deepEqual(body.system, [
    { type: 'text', text: 'identity-prefix' },
    { type: 'text', text: 'caller instructions' },
  ])
})

test('the adapter forwards the reasoning level onto the request body', async () => {
  // Dropping this would silently downgrade every request to non-reasoning.
  const maxed = await captureRequestBody({ reasoningEffort: 'max' })
  assert.deepEqual(maxed.thinking, { type: 'enabled' })
  assert.deepEqual(maxed.output_config, { effort: 'max' })

  const minimal = await captureRequestBody({ reasoningEffort: 'low' })
  assert.deepEqual(minimal.output_config, { effort: 'low' })
})

test('the adapter omits reasoning options when none are requested', async () => {
  const body = await captureRequestBody({})
  assert.equal(body.thinking, undefined)
  assert.equal(body.output_config, undefined)
})

test('the adapter clamps max tokens to the model ceiling', async () => {
  const body = await captureRequestBody({ maxTokens: 10_000_000 })
  // GLM-5.3-Flash reports 128000 as its maximum output.
  assert.equal(body.max_tokens, 128_000)
})

test('the adapter maps tools onto the request body', async () => {
  const body = await captureRequestBody({
    tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
  })
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0].name, 'read_file')
})

test('the adapter refuses to run without a credential', async () => {
  const adapter = new ZcodeAdapter({ loadCredential: () => undefined })
  await assert.rejects(async () => {
    for await (const _ of adapter.stream({ model: 'GLM-5.3-Flash', messages: [], maxTokens: 1 })) {
      // consume
    }
  }, /not signed in/)
})
