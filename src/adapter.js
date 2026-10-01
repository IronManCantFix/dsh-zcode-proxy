/**
 * The DSH `LlmAdapter` that serves the ZCode provider.
 *
 * It translates between DSH's request/stream vocabulary and the Anthropic
 * Messages wire format the plan endpoint speaks.
 *
 * ## Chunk vocabulary
 *
 * The host consumes a tagged chunk stream. The shapes below follow the
 * reference adapter shipped with the harness (`dsh-llm-deepseek`):
 *
 *     { type: "block-start",     index, blockType }
 *     { type: "text-delta",      index, text }
 *     { type: "reasoning-delta", index, text }
 *     { type: "tool-call-delta", index, id, name, argumentsDelta }
 *     { type: "block-end",       index, block }
 *     { type: "usage",           usage }
 *     { type: "finish",          reason, replayState }
 *
 * `blockType` takes the content-block names DSH uses: `text`, `reasoning` and
 * `tool-call`.
 *
 * ## Options vocabulary
 *
 * `stream()` receives the host's generate options, whose fields are
 * `messages`, `system`, `tools`, `model`, `provider`, `maxTokens`,
 * `temperature`, `stop`, `reasoningEffort`, `sessionId`, `purpose` and
 * `signal` — the same set the reference adapter reads.
 */

import { metadataFor, reasoningOptions, canonicalModelId } from './catalog.js'
import { loadIdentityBlocks } from './identity.js'
import { loadCredential } from './store.js'
import { streamMessages, UpstreamError } from './transport.js'

/** Provider id registered with the host. */
export const PROVIDER_ID = 'zcode'

/** Display name shown in the model picker. */
export const PROVIDER_NAME = 'ZCode'

/**
 * Map a DSH content block to an Anthropic content block.
 *
 * @param {any} block
 * @returns {Record<string, unknown> | undefined}
 */
function toAnthropicBlock(block) {
  if (!block || typeof block !== 'object') {
    return undefined
  }
  switch (block.type) {
    case 'text': {
      const text = typeof block.text === 'string' ? block.text : ''
      return text ? { type: 'text', text } : undefined
    }
    case 'thinking':
    case 'reasoning': {
      // Reasoning is not replayed upstream: the vendor's signatures are not
      // portable, and dropping it is what the reference adapter does too.
      return undefined
    }
    case 'tool-call': {
      let input = block.input ?? block.arguments
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input)
        } catch {
          input = {}
        }
      }
      return {
        type: 'tool_use',
        id: block.id ?? block.toolCallId ?? 'tool-call',
        name: block.name ?? block.toolName ?? 'unknown',
        input: input ?? {},
      }
    }
    case 'tool-result': {
      const content = block.content ?? block.result ?? block.text
      return {
        type: 'tool_result',
        tool_use_id: block.toolCallId ?? block.id ?? 'tool-call',
        content:
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((entry) => entry && entry.type === 'text')
                  .map((entry) => ({ type: 'text', text: String(entry.text ?? '') }))
              : String(content ?? ''),
      }
    }
    case 'image': {
      // Inline image data is only forwarded when the caller already supplied a
      // base64 payload; attachment handles are host-side references.
      const source = block.source
      if (source?.type === 'base64' && typeof source.data === 'string') {
        return { type: 'image', source }
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Convert a DSH conversation into Anthropic messages.
 *
 * Content is normalised to the block array form, which is what the endpoint
 * accepts and what keeps tool calls aligned with their results.
 *
 * @param {Array<any>} messages
 * @returns {Array<Record<string, unknown>>}
 */
export function toAnthropicMessages(messages) {
  /** @type {Array<Record<string, unknown>>} */
  const output = []

  for (const message of messages ?? []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const raw = message?.content
    const blocks = Array.isArray(raw) ? raw : [{ type: 'text', text: String(raw ?? '') }]

    const mapped = blocks.map(toAnthropicBlock).filter((block) => block !== undefined)
    if (mapped.length === 0) {
      continue
    }

    // Adjacent same-role turns must be merged; the endpoint rejects
    // consecutive messages with the same role.
    const previous = output.at(-1)
    if (previous && previous.role === role) {
      previous.content.push(...mapped)
    } else {
      output.push({ role, content: mapped })
    }
  }

  return output
}

/**
 * Append a delta to one open block's accumulated field.
 *
 * Blocks are stored sparsely by upstream index, so a delta can arrive for an
 * index whose `content_block_start` was never seen (a truncated or malformed
 * stream). Creating the entry on demand keeps the text from being silently
 * dropped, which would resurrect the undefined-`text` replay failure.
 *
 * @param {Array<Record<string, unknown>>} blocks
 * @param {number} index
 * @param {'text' | 'arguments'} field
 * @param {string} value
 */
function appendToBlock(blocks, index, field, value) {
  let block = blocks[index]
  if (!block || typeof block !== 'object') {
    block = { type: 'text', text: '' }
    blocks[index] = block
  }
  block[field] = `${typeof block[field] === 'string' ? block[field] : ''}${value}`
}

/**
 * Map DSH tool definitions to Anthropic tool definitions.
 *
 * @param {Array<any> | undefined} tools
 * @returns {Array<Record<string, unknown>> | undefined}
 */
export function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }
  const mapped = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue
    }
    const name = tool.name ?? tool.id
    if (typeof name !== 'string' || !name) {
      continue
    }
    mapped.push({
      name,
      ...(typeof tool.description === 'string' && tool.description
        ? { description: tool.description }
        : {}),
      input_schema: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} },
    })
  }
  return mapped.length > 0 ? mapped : undefined
}

/**
 * Normalise the upstream stop reason onto the token the host expects.
 *
 * @param {string | undefined} stopReason
 * @returns {string}
 */
export function mapFinishReason(stopReason) {
  switch (stopReason) {
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
      return 'length'
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop'
  }
}

/**
 * Translate an Anthropic usage object into the host's `TokenUsage`.
 *
 * The two vocabularies differ and the host reads its own: forwarding the
 * upstream object verbatim would leave every count `undefined`, so token
 * accounting and cost display would silently read as zero. Fields the vendor
 * omits are left out rather than defaulted, so the host can tell "not reported"
 * from "reported as zero".
 *
 * @param {Record<string, unknown> | undefined} usage
 * @returns {Record<string, number> | undefined}
 */
export function toHostUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return undefined
  }

  /** @type {Record<string, number>} */
  const mapped = {}
  const copy = (from, to) => {
    const value = usage[from]
    if (typeof value === 'number' && Number.isFinite(value)) {
      mapped[to] = value
    }
  }

  copy('input_tokens', 'inputTokens')
  copy('output_tokens', 'outputTokens')
  copy('cache_read_input_tokens', 'cacheReadTokens')
  copy('cache_creation_input_tokens', 'cacheWriteTokens')

  if (mapped.inputTokens === undefined && mapped.outputTokens === undefined) {
    return undefined
  }

  // The host can derive the total, but supplying it keeps the two sides from
  // disagreeing when only some fields were reported.
  mapped.totalTokens =
    (mapped.inputTokens ?? 0) + (mapped.outputTokens ?? 0)
  return mapped
}

/**
 * The adapter registered with the host.
 *
 * Only `stream` is abstract on `LlmAdapter`; the rest carry working defaults in
 * the base class, but the useful ones are overridden so the model picker and
 * retry policy behave.
 */
export class ZcodeAdapter {
  /**
   * @param {{
   *   options?: () => { models?: string[] },
   *   discoverModels?: (provider: string) => Promise<Array<any>>,
   *   providerName?: string,
   *   loadCredential?: () => any,
   *   loadIdentity?: () => { blocks: Array<{ type: 'text', text: string }> },
   *   onDegrade?: (info: Record<string, unknown>) => void,
   * }} dependencies
   *
   * `loadCredential` and `loadIdentity` are injectable so the adapter can be
   * exercised without a real sign-in or a shipped snapshot; production callers
   * leave them unset and get the real implementations.
   */
  constructor(dependencies = {}) {
    this.dependencies = dependencies
  }

  /**
   * @param {string} provider
   */
  providerInfo(provider) {
    return { id: provider, name: this.dependencies.providerName ?? PROVIDER_NAME }
  }

  /**
   * @param {string} _provider
   */
  providerRetryPolicy(_provider) {
    // The upstream rate-limits and occasionally returns transient 5xx, but the
    // host's retry handling is conservative by default; leave it to the host.
    return undefined
  }

  /**
   * @param {string} provider
   */
  async listModels(provider) {
    return (await this.dependencies.discoverModels?.(provider)) ?? []
  }

  /**
   * Resolve metadata for one exact model.
   *
   * The host's `LlmResolvedModelInfo` extends `LlmModelInfo` with a *nested*
   * `context` object and a `defaultMaxTokens` field — it is not the flat shape
   * `LlmDiscoveredModel` uses for discovery. Spreading the flat names here
   * would leave the host reading `undefined` for both the context window and
   * the default output limit.
   *
   * @param {string} provider
   * @param {string} model
   */
  resolveModel(provider, model) {
    const meta = metadataFor(canonicalModelId(model))
    const result = {
      provider,
      id: meta.id,
      name: meta.name,
      context: { contextWindow: meta.contextWindow },
      defaultMaxTokens: meta.maxOutputTokens,
      inputModalities: meta.supportsImages ? ['text', 'image'] : ['text'],
      reasoning: {
        efforts: meta.reasoningLevels.map((level) => ({ id: level, name: level })),
        ...(meta.reasoningLevels.includes('high') ? { defaultEffort: 'high' } : {}),
      },
    }
    return Promise.resolve(result)
  }

  /**
   * Bind exact model metadata and the stream entry point for one call.
   *
   * The host reads the `model` returned here as a full `LlmResolvedModelInfo`
   * and validates the request's `reasoningEffort` against it. The base class
   * does exactly that:
   *
   *     async prepareCall(provider, model, signal) {
   *       return { model: await this.resolveModel(provider, model, signal),
   *                stream: (options) => this.stream(options) };
   *     }
   *
   * An earlier version of this override hand-built `model` as
   * `{ provider, id, name }`. That silently dropped `reasoning`, `context` and
   * `defaultMaxTokens`, so the host saw a model declaring no reasoning support
   * and rejected every explicit effort with
   *
   *     does not support reasoning effort "high"   (UNSUPPORTED_REASONING_EFFORT)
   *
   * even though `resolveModel` — the method the model picker queries — reported
   * the full effort list. The two paths must agree, so this override now
   * delegates to `resolveModel` instead of restating the shape by hand.
   *
   * @param {string} provider
   * @param {string} model
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Stream one completion.
   *
   * @param {any} options host generate options
   * @returns {AsyncGenerator<Record<string, unknown>>}
   */
  async *stream(options) {
    const credential = (this.dependencies.loadCredential ?? loadCredential)()
    if (!credential) {
      throw new UpstreamError('not signed in to ZCode', {
        kind: 'auth',
        hint: 'Run `zcode-connect login` and try again.',
      })
    }

    const meta = metadataFor(canonicalModelId(options.model))
    const identity = (this.dependencies.loadIdentity ?? loadIdentityBlocks)()

    const maxTokens = Math.min(
      Number.isFinite(options.maxTokens) && options.maxTokens > 0
        ? options.maxTokens
        : meta.maxOutputTokens,
      meta.maxOutputTokens,
    )

    const upstream = streamMessages({
      credential,
      identity,
      model: canonicalModelId(options.model),
      maxTokens,
      messages: toAnthropicMessages(options.messages),
      system: options.system,
      tools: toAnthropicTools(options.tools),
      reasoning: reasoningOptions(options.reasoningEffort),
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      signal: options.signal,
    })

    /** Tracks which block index is currently open, keyed by upstream index. */
    const openBlocks = new Map()
    /** Anthropic-shaped usage, normalised for the host on the way out. */
    /** @type {Record<string, unknown> | undefined} */
    let usage
    let stopReason
    /** Accumulated assistant content, for the replay envelope. */
    /** @type {Array<Record<string, unknown>>} */
    const replayBlocks = []

    for await (const chunk of upstream) {
      const event = chunk.json
      if (!event) {
        continue
      }

      switch (event.type) {
        case 'message_start': {
          if (event.message?.usage) {
            usage = { ...event.message.usage }
          }
          break
        }

        case 'content_block_start': {
          const index = event.index ?? 0
          const block = event.content_block ?? {}
          const blockType =
            block.type === 'tool_use' ? 'tool-call' : block.type === 'thinking' ? 'reasoning' : 'text'

          openBlocks.set(index, blockType)
          yield { type: 'block-start', index, blockType }

          // The host keeps whatever a `block-end` supplies as the finished
          // block and never re-derives it from the deltas (BlockAssembler:
          // `if (partial.block) return partial.block`). A `{ type }` stub with
          // no `text` therefore becomes a block whose `text` is undefined, and
          // replaying that history throws on the next turn:
          //
          //     Cannot read properties of undefined (reading 'length')
          //
          // The reference adapter closes blocks with the fully accumulated
          // content (`block: { ...block.content }`), so the text is gathered
          // here and emitted on `content_block_stop`.
          if (blockType === 'tool-call') {
            replayBlocks[index] = { type: 'tool-call', id: block.id, name: block.name, arguments: '' }
            yield {
              type: 'tool-call-delta',
              index,
              id: block.id,
              name: block.name,
              argumentsDelta: '',
            }
          } else {
            replayBlocks[index] = { type: blockType, text: '' }
          }
          break
        }

        case 'content_block_delta': {
          const index = event.index ?? 0
          const delta = event.delta ?? {}
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            appendToBlock(replayBlocks, index, 'text', delta.text)
            yield { type: 'text-delta', index, text: delta.text }
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            appendToBlock(replayBlocks, index, 'text', delta.thinking)
            yield { type: 'reasoning-delta', index, text: delta.thinking }
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            appendToBlock(replayBlocks, index, 'arguments', delta.partial_json)
            yield {
              type: 'tool-call-delta',
              index,
              id: replayBlocks[index]?.id,
              name: replayBlocks[index]?.name,
              argumentsDelta: delta.partial_json,
            }
          }
          break
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          openBlocks.delete(index)
          yield {
            type: 'block-end',
            index,
            block: replayBlocks[index] ? { ...replayBlocks[index] } : {},
          }
          break
        }

        case 'message_delta': {
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason
          }
          if (event.usage) {
            usage = { ...usage, ...event.usage }
          }
          break
        }

        case 'error': {
          const message = event.error?.message ?? event.message ?? 'unknown upstream error'
          throw new UpstreamError(`upstream reported an error mid-stream: ${message}`, {
            kind: 'server',
            retryable: true,
          })
        }

        default:
          break
      }
    }

    const hostUsage = toHostUsage(usage)
    if (hostUsage) {
      yield { type: 'usage', usage: hostUsage }
    }

    yield {
      type: 'finish',
      reason: mapFinishReason(stopReason),
      replayState: {
        response: { kind: 'zcode-anthropic', version: 1, model: canonicalModelId(options.model) },
        blocks: replayBlocks.filter(Boolean),
      },
    }
  }
}
