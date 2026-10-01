/**
 * ZCode's browser-authorization login, implemented directly.
 *
 * ## Why this exists
 *
 * The plugin must not depend on the ZCode desktop client being installed,
 * running, or configured. Authentication is therefore performed in-process,
 * the same way ZCode's own CLI does it.
 *
 * ## The flow
 *
 * This is a *server-mediated* OAuth flow with client polling — there is no
 * localhost callback server to run, and no client id or secret to hold. The
 * vendor's own callback endpoint receives the redirect:
 *
 *   1. POST {origin}/api/v1/oauth/cli/init
 *        Authorization: Bearer <pollToken>        (32 random bytes, hex)
 *        body: {"provider": "zai" | "bigmodel"}
 *      -> { flow_id, poll_token, authorize_url, expires_at, poll_interval_sec }
 *
 *   2. The user opens `authorize_url` and approves in a browser.
 *
 *   3. GET {origin}/api/v1/oauth/cli/poll/{flow_id}
 *        Authorization: Bearer <pollToken>
 *      -> {"data":{"status":"pending"}}                   keep polling
 *      -> {"data":{"status":"ready", ...tokens...}}        done
 *
 * Confirmed live: `init` returns 200 with the fields above, `poll` returns
 * `status: "pending"` while waiting, and polling with a mismatched token is
 * rejected as `400 {"code":3004,"msg":"invalid_flow"}` — so the poll token is
 * bound to its flow and must be kept.
 */

import { randomBytes } from 'node:crypto'

/** Default ZCode platform origin. */
export const DEFAULT_ORIGIN = 'https://zcode.z.ai'

/** Providers a login can target. */
export const PROVIDERS = Object.freeze(['zai', 'bigmodel'])

/** How long to wait for the user to finish authorizing, by default. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Fallback poll cadence when the server does not suggest one. */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/** Length of the poll token, in random bytes (hex-encoded). */
const POLL_TOKEN_BYTES = 32

/**
 * An error raised by the login flow.
 *
 * `businessCode` carries the vendor's numeric code when the failure came from
 * a well-formed envelope (for example `3004 invalid_flow`).
 */
export class OAuthError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, businessCode?: number, kind?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'OAuthError'
    this.status = details.status
    this.businessCode = details.businessCode
    this.kind = details.kind ?? 'oauth'
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read a JSON envelope, translating HTTP and envelope failures into OAuthError.
 *
 * ZCode's endpoints answer with `{code, msg, data}` and use HTTP 200 for
 * business-level failures, so both layers have to be checked.
 *
 * @param {Response} response
 * @param {string} what
 * @returns {Promise<any>}
 */
async function readEnvelope(response, what) {
  const text = await response.text()

  if (!response.ok) {
    let businessCode
    let message = text.slice(0, 200)
    try {
      const parsed = JSON.parse(text)
      businessCode = typeof parsed?.code === 'number' ? parsed.code : undefined
      message = parsed?.msg || message
    } catch {
      // Non-JSON error body; keep the raw excerpt.
    }
    throw new OAuthError(`${what} failed: HTTP ${response.status} ${message}`, {
      status: response.status,
      businessCode,
      kind: 'http',
    })
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new OAuthError(`${what} returned a non-JSON body`, { kind: 'protocol', cause: error })
  }

  if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
    throw new OAuthError(`${what} was rejected: ${parsed.msg || `code ${parsed.code}`}`, {
      businessCode: parsed.code,
      kind: 'business',
    })
  }

  return parsed?.data
}

/**
 * Begin a login and return everything needed to finish it.
 *
 * @param {{
 *   provider: 'zai' | 'bigmodel',
 *   origin?: string,
 *   fetchImpl?: typeof fetch,
 *   pollToken?: string,
 * }} options
 * @returns {Promise<{
 *   flowId: string,
 *   pollToken: string,
 *   authorizeUrl: string,
 *   expiresAt: number | undefined,
 *   pollIntervalMs: number,
 *   provider: 'zai' | 'bigmodel',
 * }>}
 */
export async function startOAuthFlow(options) {
  const { provider } = options
  if (!PROVIDERS.includes(provider)) {
    throw new OAuthError(`provider must be one of ${PROVIDERS.join(', ')}, got ${String(provider)}`, {
      kind: 'config',
    })
  }

  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const pollToken = options.pollToken ?? randomBytes(POLL_TOKEN_BYTES).toString('hex')

  const response = await fetchImpl(`${origin}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      authorization: `Bearer ${pollToken}`,
    },
    body: JSON.stringify({ provider }),
  })

  const data = await readEnvelope(response, 'oauth/cli/init')

  const flowId = data?.flow_id
  const authorizeUrl = data?.authorize_url
  if (typeof flowId !== 'string' || !flowId) {
    throw new OAuthError('oauth/cli/init did not return a flow_id', { kind: 'protocol' })
  }
  if (typeof authorizeUrl !== 'string' || !authorizeUrl) {
    throw new OAuthError('oauth/cli/init did not return an authorize_url', { kind: 'protocol' })
  }

  const pollIntervalSec = Number(data?.poll_interval_sec)

  return {
    flowId,
    pollToken,
    authorizeUrl,
    expiresAt: typeof data?.expires_at === 'number' ? data.expires_at : undefined,
    pollIntervalMs:
      Number.isFinite(pollIntervalSec) && pollIntervalSec > 0
        ? pollIntervalSec * 1000
        : DEFAULT_POLL_INTERVAL_MS,
    provider,
  }
}

/**
 * Poll once. Returns the raw envelope data.
 *
 * @param {{
 *   flowId: string,
 *   pollToken: string,
 *   origin?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function pollOAuthFlowOnce(options) {
  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? fetch

  const response = await fetchImpl(
    `${origin}/api/v1/oauth/cli/poll/${encodeURIComponent(options.flowId)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        authorization: `Bearer ${options.pollToken}`,
      },
    },
  )

  return await readEnvelope(response, 'oauth/cli/poll')
}

/**
 * Extract the credential material from a `ready` poll payload.
 *
 * The vendor nests the provider token under the provider name and carries the
 * ZCode plan JWT alongside it. Field names are accepted in both the snake_case
 * and camelCase spellings the client has used.
 *
 * @param {Record<string, unknown>} data
 * @param {'zai' | 'bigmodel'} provider
 * @returns {{ accessToken: string | undefined, jwt: string | undefined }}
 */
export function readReadyCredentials(data, provider) {
  const branch = data?.[provider]
  const record = branch !== null && typeof branch === 'object' ? branch : {}

  const pick = (source, ...names) => {
    for (const name of names) {
      const value = source?.[name]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return undefined
  }

  return {
    accessToken: pick(record, 'access_token', 'accessToken'),
    jwt: pick(data, 'token', 'jwt') ?? pick(record, 'jwt'),
  }
}

/**
 * Run a complete login: begin, hand the URL to the user, then poll to the end.
 *
 * @param {{
 *   provider: 'zai' | 'bigmodel',
 *   origin?: string,
 *   fetchImpl?: typeof fetch,
 *   onAuthorizeUrl: (url: string, flow: { flowId: string, expiresAt?: number }) => void | Promise<void>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ provider: 'zai' | 'bigmodel', accessToken: string, jwt: string | undefined }>}
 */
export async function login(options) {
  const flow = await startOAuthFlow(options)
  await options.onAuthorizeUrl(flow.authorizeUrl, { flowId: flow.flowId, expiresAt: flow.expiresAt })

  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS)
  const interval = options.pollIntervalMs ?? flow.pollIntervalMs

  for (;;) {
    if (options.signal?.aborted) {
      throw new OAuthError('login was aborted', { kind: 'aborted' })
    }
    if (now() > deadline) {
      throw new OAuthError('timed out waiting for the browser authorization to complete', {
        kind: 'timeout',
      })
    }

    const data = await pollOAuthFlowOnce({
      flowId: flow.flowId,
      pollToken: flow.pollToken,
      origin: options.origin,
      fetchImpl: options.fetchImpl,
    })

    const status = data?.status
    if (status === 'ready') {
      const { accessToken, jwt } = readReadyCredentials(data, flow.provider)
      if (!accessToken) {
        throw new OAuthError('the authorization completed without returning an access token', {
          kind: 'protocol',
        })
      }
      return { provider: flow.provider, accessToken, jwt }
    }

    if (status !== undefined && status !== 'pending') {
      throw new OAuthError(`unexpected login status: ${String(status)}`, { kind: 'protocol' })
    }

    await sleep(interval, options.signal)
  }
}
