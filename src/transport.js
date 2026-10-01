/**
 * The Anthropic-Messages client used to talk to the plan endpoint.
 *
 * Everything the upstream needs is assembled here: the URL, the identity
 * blocks, the fingerprint headers and the bearer token. The response is parsed
 * as server-sent events and yielded as typed chunks, so the caller never sees
 * raw bytes.
 *
 * ## Failure classification
 *
 * Upstream reports failures in three different ways, and they must not be
 * conflated because the remedies differ:
 *
 *   - `3012` on HTTP 405 — the gateway's content check refused the request.
 *     In practice this means the identity blocks were missing or stale.
 *     Retrying is pointless; the snapshot must be refreshed.
 *   - `401` with `VERIFY_SIGNATURE_INVALID` / `VERIFY_APIKEY_EXPIRED` — an
 *     authentication problem with the stored credential.
 *   - `1309` — the subscription backing the credential is not currently
 *     usable. Retrying will not help until the plan state changes.
 *
 * The remaining 4xx/5xx are surfaced verbatim with the vendor's message so the
 * card can show what the server actually said.
 */

import { loadIdentityBlocks } from './identity.js'
import { buildFingerprintHeaders, buildRequestHeaders, zcodePlanBaseUrl, normalizeAnthropicBaseUrl } from './origin.js'

/** Vendor code returned when the gateway's request-content check refuses a call. */
export const CODE_BLOCKED = 3012

/** Vendor code returned when the plan backing the credential is unusable. */
export const CODE_PLAN_UNAVAILABLE = 1309

/** Vendor messages that mean the signing credential must be refreshed. */
export const SIGNATURE_REJECTIONS = Object.freeze([
  'VERIFY_SIGNATURE_INVALID',
  'VERIFY_APIKEY_EXPIRED',
])

/**
 * A structured upstream failure.
 */
export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   kind: 'blocked' | 'auth' | 'plan' | 'rate-limit' | 'context' | 'server' | 'network' | 'client' | 'protocol',
   *   status?: number,
   *   businessCode?: number,
   *   requestId?: string,
   *   retryable?: boolean,
   *   hint?: string,
   * }} details
   */
  constructor(message, details) {
    super(message)
    this.name = 'UpstreamError'
    this.kind = details.kind
    this.status = details.status
    this.businessCode = details.businessCode
    this.requestId = details.requestId
    this.retryable = details.retryable ?? false
    this.hint = details.hint
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/**
 * Pull the vendor's business code and message out of an error body.
 *
 * The envelope is inconsistent across the gateway's layers, so several shapes
 * are accepted.
 *
 * @param {unknown} body
 * @returns {{ code?: number, message?: string, requestId?: string }}
 */
export function readFailure(body) {
  const record = asRecord(body)
  const error = asRecord(record?.error)

  const rawCode = record?.code ?? error?.code ?? record?.error_code
  const code =
    typeof rawCode === 'number'
      ? rawCode
      : typeof rawCode === 'string' && /^\d+$/.test(rawCode.trim())
        ? Number(rawCode.trim())
        : undefined

  const message =
    (typeof record?.msg === 'string' && record.msg) ||
    (typeof record?.message === 'string' && record.message) ||
    (typeof error?.msg === 'string' && error.msg) ||
    (typeof error?.message === 'string' && error.message) ||
    undefined

  const requestId =
    (typeof record?.request_id === 'string' && record.request_id) ||
    (typeof record?.logid === 'string' && record.logid) ||
    undefined

  return { code, message, requestId }
}

/**
 * Classify a failed response.
 *
 * @param {{ status: number, body: unknown, headers?: Headers }} failure
 * @returns {UpstreamError}
 */
export function classifyFailure(failure) {
  const { code, message, requestId } = readFailure(failure.body)
  const status = failure.status
  const detail = message ? `: ${message}` : ''

  if (code === CODE_BLOCKED) {
    return new UpstreamError(
      `the gateway refused the request as unexpected${detail}`,
      {
        kind: 'blocked',
        status,
        businessCode: code,
        requestId,
        hint:
          'The identity blocks sent with the request were rejected. Refresh them with ' +
          '`refresh-identity` against a current ZCode install.',
      },
    )
  }

  if (code === CODE_PLAN_UNAVAILABLE) {
    return new UpstreamError(`the subscription backing this credential is unavailable${detail}`, {
      kind: 'plan',
      status,
      businessCode: code,
      requestId,
      hint: 'Renew the plan, or sign in to an account that has one.',
    })
  }

  if (status === 401 || status === 403) {
    const signatureRejected =
      typeof message === 'string' && SIGNATURE_REJECTIONS.some((token) => message.includes(token))
    return new UpstreamError(`upstream rejected the credential${detail}`, {
      kind: 'auth',
      status,
      businessCode: code,
      requestId,
      hint: signatureRejected
        ? 'Sign in again to obtain a fresh credential.'
        : 'Sign in again; the stored credential may have expired.',
    })
  }

  if (status === 429) {
    return new UpstreamError(`upstream rate-limited the request${detail}`, {
      kind: 'rate-limit',
      status,
      businessCode: code,
      requestId,
      retryable: true,
      hint: 'Wait before retrying; the quota plane rate-limits aggressively.',
    })
  }

  if (status === 400 && typeof message === 'string' && /context|too long|too large/i.test(message)) {
    return new UpstreamError(`the conversation exceeded the model context window${detail}`, {
      kind: 'context',
      status,
      businessCode: code,
      requestId,
    })
  }

  if (status >= 500) {
    return new UpstreamError(`upstream failed${detail}`, {
      kind: 'server',
      status,
      businessCode: code,
      requestId,
      retryable: true,
    })
  }

  return new UpstreamError(`upstream rejected the request${detail}`, {
    kind: 'client',
    status,
    businessCode: code,
    requestId,
  })
}

/**
 * Parse one SSE frame.
 *
 * @param {string} frame
 * @returns {{ event?: string, data?: string }}
 */
function parseFrame(frame) {
  let event
  const dataLines = []
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  return { event, data: dataLines.length > 0 ? dataLines.join('\n') : undefined }
}

/**
 * Parse a `system` field into the block array the wire expects.
 *
 * @param {string | Array<Record<string, unknown>> | undefined} system
 * @returns {Array<Record<string, unknown>> | undefined}
 */
function normalizeSystem(system) {
  if (!system) {
    return undefined
  }
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }]
  }
  return system
}

/**
 * Assemble the request body.
 *
 * The identity blocks lead the `system` field and any caller-supplied system
 * prompt follows them, because the gateway's content check reads the prefix.
 *
 * @param {{
 *   model: string,
 *   maxTokens: number,
 *   messages: Array<Record<string, unknown>>,
 *   identityBlocks: Array<{ type: string, text: string }>,
 *   system?: string | Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   toolChoice?: Record<string, unknown>,
 *   stream?: boolean,
 *   reasoning?: Record<string, unknown>,
 *   metadata?: Record<string, unknown>,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildRequestBody(input) {
  const body = {
    model: input.model,
    max_tokens: input.maxTokens,
    stream: input.stream ?? true,
    system: [...input.identityBlocks, ...(normalizeSystem(input.system) ?? [])],
    messages: input.messages,
  }
  if (input.tools?.length) {
    body.tools = input.tools
  }
  if (input.toolChoice) {
    body.tool_choice = input.toolChoice
  }
  if (input.reasoning) {
    Object.assign(body, input.reasoning)
  }
  if (input.metadata) {
    body.metadata = input.metadata
  }
  return body
}

/**
 * Stream a messages call, yielding parsed SSE frames.
 *
 * @param {{
 *   credential: { jwt?: string, accessToken?: string },
 *   model: string,
 *   maxTokens: number,
 *   messages: Array<Record<string, unknown>>,
 *   system?: string | Array<Record<string, unknown>>,
 *   tools?: Array<Record<string, unknown>>,
 *   toolChoice?: Record<string, unknown>,
 *   reasoning?: Record<string, unknown>,
 *   metadata?: Record<string, unknown>,
 *   deviceMid?: string,
 *   sessionId?: string,
 *   requestId?: string,
 *   traceId?: string,
 *   identity?: { blocks: Array<{ type: 'text', text: string }> },
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   origin?: string,
 * }} options
 * @returns {AsyncGenerator<{ event?: string, data?: string, json?: any }>}
 */
export async function* streamMessages(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const identity = options.identity ?? loadIdentityBlocks()

  const token = options.credential.jwt ?? options.credential.accessToken
  if (!token) {
    throw new UpstreamError('no usable credential: the login returned neither a plan token nor an access token', {
      kind: 'auth',
      hint: 'Sign in again.',
    })
  }

  const base = options.origin
    ? `${options.origin.replace(/\/+$/u, '')}/api/v1/zcode-plan/anthropic`
    : zcodePlanBaseUrl('bigmodel')
  const url = `${normalizeAnthropicBaseUrl(base)}/messages`

  const headers = buildRequestHeaders({
    fingerprint: buildFingerprintHeaders({ deviceMid: options.deviceMid }),
    sessionId: options.sessionId,
    requestId: options.requestId,
    traceId: options.traceId,
    sessionType: 'main',
    auth: { Authorization: `Bearer ${token}` },
  })
  headers.Accept = 'text/event-stream'

  const body = buildRequestBody({
    model: options.model,
    maxTokens: options.maxTokens,
    messages: options.messages,
    identityBlocks: identity.blocks,
    system: options.system,
    tools: options.tools,
    toolChoice: options.toolChoice,
    stream: true,
    reasoning: options.reasoning,
    metadata: options.metadata,
  })

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (error) {
    throw new UpstreamError(
      `unable to reach the upstream: ${error instanceof Error ? error.message : String(error)}`,
      { kind: 'network', retryable: true },
    )
  }

  if (!response.ok) {
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { message: text.slice(0, 300) }
    }
    throw classifyFailure({ status: response.status, body: parsed, headers: response.headers })
  }

  if (!response.body) {
    throw new UpstreamError('upstream returned no response body', { kind: 'protocol' })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let separator
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        if (!frame.trim()) {
          continue
        }
        const parsed = parseFrame(frame)
        if (parsed.data === undefined) {
          yield { event: parsed.event }
          continue
        }
        if (parsed.data === '[DONE]') {
          return
        }
        let json
        try {
          json = JSON.parse(parsed.data)
        } catch {
          yield { event: parsed.event, data: parsed.data }
          continue
        }
        yield { event: parsed.event, data: parsed.data, json }
      }
    }

    if (buffer.trim()) {
      const parsed = parseFrame(buffer)
      if (parsed.data && parsed.data !== '[DONE]') {
        try {
          yield { event: parsed.event, data: parsed.data, json: JSON.parse(parsed.data) }
        } catch {
          yield { event: parsed.event, data: parsed.data }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Non-streaming convenience wrapper, used by the doctor command.
 *
 * @param {Parameters<typeof streamMessages>[0] & { maxTokens?: number }} options
 * @returns {Promise<{ text: string, thinking: string, usage: Record<string, unknown> | undefined, stopReason: string | undefined }>}
 */
export async function sendMessages(options) {
  const stream = streamMessages({ ...options, maxTokens: options.maxTokens ?? 64 })

  let text = ''
  let thinking = ''
  /** @type {Record<string, unknown> | undefined} */
  let usage
  let stopReason

  for await (const chunk of stream) {
    const json = chunk.json
    if (!json) {
      continue
    }
    switch (json.type) {
      case 'content_block_delta': {
        const delta = json.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          thinking += delta.thinking
        }
        break
      }
      case 'message_delta': {
        if (json.delta?.stop_reason) {
          stopReason = json.delta.stop_reason
        }
        if (json.usage) {
          usage = { ...usage, ...json.usage }
        }
        break
      }
      case 'message_start': {
        if (json.message?.usage) {
          usage = { ...json.message.usage }
        }
        break
      }
      case 'error': {
        const { code, message } = readFailure(json)
        throw new UpstreamError(`upstream reported an error mid-stream: ${message ?? 'unknown'}`, {
          kind: 'server',
          businessCode: code,
          retryable: true,
        })
      }
      default:
        break
    }
  }

  return { text, thinking, usage, stopReason }
}
