/**
 * Unit tests for the browser-authorization login flow.
 *
 * Run with: node --test test/*.test.js
 *
 * Everything here runs against a stub fetch: the flow talks to a live vendor
 * endpoint, and tests must not create logins or depend on network state.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ORIGIN,
  login,
  OAuthError,
  pollOAuthFlowOnce,
  readReadyCredentials,
  startOAuthFlow,
} from '../src/oauth.js'

/**
 * Build a fetch stub that answers from a queue of responses.
 *
 * @param {Array<{ status?: number, body?: unknown, rawBody?: string }>} responses
 * @returns {{ fetchImpl: typeof fetch, calls: Array<{ url: string, init: RequestInit }> }}
 */
function stubFetch(responses) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = []
  let index = 0

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    const status = spec.status ?? 200
    const body = spec.rawBody ?? JSON.stringify(spec.body ?? {})
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }

  return { fetchImpl: /** @type {typeof fetch} */ (fetchImpl), calls }
}

const INIT_OK = {
  status: 200,
  body: {
    code: 0,
    msg: '',
    data: {
      flow_id: 'flow-abc',
      poll_token: 'server-echoed-token',
      authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=xyz',
      expires_at: 1790821865,
      poll_interval_sec: 2,
    },
  },
}

test('startOAuthFlow posts to the init endpoint with a bearer poll token', async () => {
  const { fetchImpl, calls } = stubFetch([INIT_OK])
  const flow = await startOAuthFlow({ provider: 'bigmodel', fetchImpl, pollToken: 'fixed-token' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_ORIGIN}/api/v1/oauth/cli/init`)
  assert.equal(calls[0].init.method, 'POST')

  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get('authorization'), 'Bearer fixed-token')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { provider: 'bigmodel' })

  assert.equal(flow.flowId, 'flow-abc')
  assert.equal(flow.pollToken, 'fixed-token')
  assert.equal(flow.authorizeUrl, 'https://bigmodel.cn/login?appId=zcode&state=xyz')
  assert.equal(flow.pollIntervalMs, 2000)
  assert.equal(flow.provider, 'bigmodel')
})

test('startOAuthFlow generates its own poll token when none is supplied', async () => {
  const { fetchImpl } = stubFetch([INIT_OK])
  const flow = await startOAuthFlow({ provider: 'bigmodel', fetchImpl })
  // 32 random bytes hex-encoded.
  assert.match(flow.pollToken, /^[0-9a-f]{64}$/)
})

test('startOAuthFlow keeps the generated token rather than the echoed one', async () => {
  // The stub echoes a different value; the flow must trust its own token,
  // because that is what the poll endpoint will authenticate against.
  const { fetchImpl } = stubFetch([INIT_OK])
  const flow = await startOAuthFlow({ provider: 'bigmodel', fetchImpl, pollToken: 'mine' })
  assert.equal(flow.pollToken, 'mine')
})

test('startOAuthFlow rejects an unsupported provider before making a request', async () => {
  const { fetchImpl, calls } = stubFetch([INIT_OK])
  await assert.rejects(
    // @ts-expect-error deliberately invalid provider
    () => startOAuthFlow({ provider: 'moon', fetchImpl }),
    /provider must be one of zai, bigmodel/,
  )
  assert.equal(calls.length, 0)
})

test('startOAuthFlow surfaces a HTTP failure', async () => {
  const { fetchImpl } = stubFetch([{ status: 429, rawBody: '' }])
  await assert.rejects(
    () => startOAuthFlow({ provider: 'zai', fetchImpl }),
    (error) => error instanceof OAuthError && error.status === 429,
  )
})

test('startOAuthFlow surfaces a business-level failure inside HTTP 200', async () => {
  const { fetchImpl } = stubFetch([
    { status: 200, body: { code: 3004, msg: 'invalid_flow', data: null } },
  ])
  await assert.rejects(
    () => startOAuthFlow({ provider: 'bigmodel', fetchImpl }),
    (error) => error instanceof OAuthError && error.businessCode === 3004 && /invalid_flow/.test(error.message),
  )
})

test('startOAuthFlow rejects a response missing required fields', async () => {
  const { fetchImpl } = stubFetch([{ status: 200, body: { code: 0, data: { flow_id: 'only-id' } } }])
  await assert.rejects(
    () => startOAuthFlow({ provider: 'bigmodel', fetchImpl }),
    /did not return an authorize_url/,
  )
})

test('pollOAuthFlowOnce reports a pending flow', async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, body: { code: 0, data: { status: 'pending' } } },
  ])
  const data = await pollOAuthFlowOnce({ flowId: 'flow-abc', pollToken: 'tok', fetchImpl })
  assert.deepEqual(data, { status: 'pending' })
  assert.equal(calls[0].url, `${DEFAULT_ORIGIN}/api/v1/oauth/cli/poll/flow-abc`)
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer tok')
})

test('readReadyCredentials reads the provider branch and the plan JWT', () => {
  const credentials = readReadyCredentials(
    {
      status: 'ready',
      token: 'the-plan-jwt',
      bigmodel: { access_token: 'the-access-token' },
    },
    'bigmodel',
  )
  assert.deepEqual(credentials, { accessToken: 'the-access-token', jwt: 'the-plan-jwt' })
})

test('readReadyCredentials accepts camelCase spellings', () => {
  const credentials = readReadyCredentials(
    { status: 'ready', jwt: 'jwt-value', zai: { accessToken: 'camel-token' } },
    'zai',
  )
  assert.deepEqual(credentials, { accessToken: 'camel-token', jwt: 'jwt-value' })
})

test('readReadyCredentials tolerates missing branches', () => {
  assert.deepEqual(readReadyCredentials({ status: 'ready' }, 'bigmodel'), {
    accessToken: undefined,
    jwt: undefined,
  })
})

test('login drives the whole flow and returns the credentials', async () => {
  const { fetchImpl, calls } = stubFetch([
    INIT_OK,
    { status: 200, body: { code: 0, data: { status: 'pending' } } },
    {
      status: 200,
      body: {
        code: 0,
        data: { status: 'ready', token: 'jwt-1', bigmodel: { access_token: 'at-1' } },
      },
    },
  ])

  /** @type {string[]} */
  const opened = []
  const result = await login({
    provider: 'bigmodel',
    fetchImpl,
    pollToken: 'tok',
    pollIntervalMs: 1,
    onAuthorizeUrl: (url) => {
      opened.push(url)
    },
  })

  assert.deepEqual(opened, ['https://bigmodel.cn/login?appId=zcode&state=xyz'])
  assert.deepEqual(result, { provider: 'bigmodel', accessToken: 'at-1', jwt: 'jwt-1' })
  assert.equal(calls.length, 3)
})

test('login fails when the flow becomes ready without an access token', async () => {
  const { fetchImpl } = stubFetch([
    INIT_OK,
    { status: 200, body: { code: 0, data: { status: 'ready', bigmodel: {} } } },
  ])
  await assert.rejects(
    () => login({ provider: 'bigmodel', fetchImpl, pollIntervalMs: 1, onAuthorizeUrl: () => {} }),
    /completed without returning an access token/,
  )
})

test('login times out when the user never finishes', async () => {
  const { fetchImpl } = stubFetch([
    INIT_OK,
    { status: 200, body: { code: 0, data: { status: 'pending' } } },
  ])
  // Fake clock: report a time beyond the deadline on the second check.
  let ticks = 0
  const now = () => (ticks++ === 0 ? 0 : 10_000_000)

  await assert.rejects(
    () =>
      login({
        provider: 'bigmodel',
        fetchImpl,
        pollIntervalMs: 1,
        timeoutMs: 1000,
        now,
        onAuthorizeUrl: () => {},
      }),
    /timed out waiting/,
  )
})

test('login aborts promptly when the signal is already aborted', async () => {
  const { fetchImpl } = stubFetch([INIT_OK])
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () =>
      login({
        provider: 'bigmodel',
        fetchImpl,
        signal: controller.signal,
        onAuthorizeUrl: () => {},
      }),
    (error) => error instanceof OAuthError && error.kind === 'aborted',
  )
})
