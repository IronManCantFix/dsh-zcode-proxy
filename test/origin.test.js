/**
 * Unit tests for endpoint and header construction.
 *
 * Run with: node --test test/
 *
 * The header contract asserted here is not invented: it is the header set a
 * real `account:bigmodel-start-plan` request carried, read out of ZCode's own
 * model-I/O record at
 * `~/.zcode/cli/rollout/model-io-sess_34bb7e4a-….jsonl`. If the upstream
 * gateway's fingerprint checks tighten, this list is the thing to revisit.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFingerprintHeaders,
  buildRequestHeaders,
  DEFAULT_APP_VERSION,
  normalizeAnthropicBaseUrl,
  osCategory,
  REGIONS,
  resolveMessagesUrl,
  zcodePlanBaseUrl,
  ZCODE_ORIGIN,
} from '../src/origin.js'

/**
 * The exactly-observed header names on a successful Start Plan request,
 * lowercased as they appeared in the record.
 *
 * @type {readonly string[]}
 */
const OBSERVED_REQUEST_HEADERS = Object.freeze([
  'http-referer',
  'user-agent',
  'x-zcode-app-version',
  'x-title',
  'x-release-channel',
  'x-client-language',
  'x-client-timezone',
  'x-zcode-agent',
  'x-platform',
  'x-os-category',
  'x-os-version',
  'x-request-id',
  'x-zcode-session-type',
  'x-zcode-trace-id',
  'x-query-id',
  'x-session-id',
])

test('normalizeAnthropicBaseUrl appends /v1 when the path lacks it', () => {
  assert.equal(
    normalizeAnthropicBaseUrl('https://zcode.z.ai/api/v1/ultra/anthropic'),
    'https://zcode.z.ai/api/v1/ultra/anthropic/v1',
  )
})

test('normalizeAnthropicBaseUrl leaves an existing /v1 suffix alone', () => {
  assert.equal(
    normalizeAnthropicBaseUrl('https://api.anthropic.com/v1'),
    'https://api.anthropic.com/v1',
  )
})

test('normalizeAnthropicBaseUrl tolerates trailing slashes and case', () => {
  assert.equal(
    normalizeAnthropicBaseUrl('https://api.anthropic.com/v1///'),
    'https://api.anthropic.com/v1',
  )
  assert.equal(
    normalizeAnthropicBaseUrl('https://api.anthropic.com/V1'),
    'https://api.anthropic.com/V1',
  )
})

test('normalizeAnthropicBaseUrl rejects an empty base URL', () => {
  assert.throws(() => normalizeAnthropicBaseUrl(''), /base URL is required/)
  assert.throws(() => normalizeAnthropicBaseUrl('   '), /base URL is required/)
})

test('REGIONS matches the gateway rewrite table shipped by ZCode', () => {
  // Source: zai-org/ZCode, apps/zcode-cli/packages/adapters/src/model/
  //         official-coding-plan-gateway.ts
  assert.equal(REGIONS.bigmodel.officialAnthropic, 'https://open.bigmodel.cn/api/anthropic')
  assert.equal(REGIONS.bigmodel.gatewayPath, '/api/v1/ultra/anthropic')

  assert.equal(REGIONS.zai.officialAnthropic, 'https://api.z.ai/api/anthropic')
  assert.equal(REGIONS.zai.gatewayPath, '/api/v1/ultra-zai/anthropic')

  for (const entry of Object.values(REGIONS)) {
    assert.equal(entry.gatewayOrigin, ZCODE_ORIGIN)
  }
})

test('resolveMessagesUrl targets the gateway by default', () => {
  assert.equal(
    resolveMessagesUrl({ region: 'bigmodel' }),
    'https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages',
  )
  assert.equal(
    resolveMessagesUrl({ region: 'zai' }),
    'https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages',
  )
})

test('resolveMessagesUrl can target the vendor endpoint directly', () => {
  assert.equal(
    resolveMessagesUrl({ region: 'bigmodel', useGateway: false }),
    'https://open.bigmodel.cn/api/anthropic/v1/messages',
  )
  assert.equal(
    resolveMessagesUrl({ region: 'zai', useGateway: false }),
    'https://api.z.ai/api/anthropic/v1/messages',
  )
})

test('resolveMessagesUrl rejects an unknown region', () => {
  // @ts-expect-error deliberately invalid region
  assert.throws(() => resolveMessagesUrl({ region: 'moon' }), /unknown ZCode region: moon/)
})

test('zcodePlanBaseUrl points at the signing-protected plan endpoint', () => {
  assert.equal(zcodePlanBaseUrl('bigmodel'), 'https://zcode.z.ai/api/v1/zcode-plan/anthropic')
  assert.equal(normalizeAnthropicBaseUrl(zcodePlanBaseUrl('bigmodel')) + '/messages',
    'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
})

test('osCategory maps Node platform names to ZCode categories', () => {
  assert.equal(osCategory('darwin'), 'macos')
  assert.equal(osCategory('win32'), 'windows')
  assert.equal(osCategory('linux'), 'linux')
  assert.equal(osCategory('freebsd'), 'linux')
})

test('buildFingerprintHeaders emits the observed header names', () => {
  const headers = buildFingerprintHeaders({
    appVersion: DEFAULT_APP_VERSION,
    deviceMid: 'a7312f04-47a3-46b2-bae6-14efa5baef49',
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '24.6.0',
  })

  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
  for (const observed of OBSERVED_REQUEST_HEADERS) {
    // The per-request correlation headers are added by buildRequestHeaders,
    // not by the fingerprint set.
    if (
      observed === 'x-request-id' ||
      observed === 'x-zcode-session-type' ||
      observed === 'x-zcode-trace-id' ||
      observed === 'x-query-id' ||
      observed === 'x-session-id'
    ) {
      continue
    }
    assert.ok(names.has(observed), `fingerprint headers are missing ${observed}`)
  }
})

test('buildFingerprintHeaders reports the platform pair and title', () => {
  const headers = buildFingerprintHeaders({
    platform: 'darwin',
    arch: 'arm64',
    deviceMid: 'device-1',
    osRelease: '24.6.0',
  })
  assert.equal(headers['X-Platform'], 'darwin-arm64')
  assert.equal(headers['X-Os-Category'], 'macos')
  assert.equal(headers['X-Os-Version'], '24.6.0')
  assert.equal(headers['X-Title'], 'Z Code@electron')
  assert.equal(headers['X-Device-Mid'], 'device-1')
  assert.equal(headers['HTTP-Referer'], ZCODE_ORIGIN)
  assert.equal(headers['X-ZCode-Agent'], 'glm')
})

test('buildFingerprintHeaders omits empty optional values', () => {
  const headers = buildFingerprintHeaders({ deviceMid: undefined, osRelease: undefined })
  assert.equal('X-Device-Mid' in headers, false)
  assert.equal('X-Os-Version' in headers, false)
  // Required headers survive.
  assert.equal(headers['X-ZCode-Agent'], 'glm')
})

test('buildRequestHeaders produces the full observed set', () => {
  const headers = buildRequestHeaders({
    fingerprint: buildFingerprintHeaders({
      deviceMid: 'device-1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.6.0',
    }),
    requestId: 'req-1',
    sessionId: 'sess-1',
    sessionType: 'main',
    traceId: 'trace-1',
    queryId: 'query-1',
  })

  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
  for (const observed of OBSERVED_REQUEST_HEADERS) {
    assert.ok(names.has(observed), `request headers are missing ${observed}`)
  }
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['anthropic-version'], '2023-06-01')
})

test('buildRequestHeaders accepts an explicit auth header set', () => {
  const headers = buildRequestHeaders({ auth: { Authorization: 'Bearer token-value' } })
  assert.equal(headers.Authorization, 'Bearer token-value')
})

test('buildRequestHeaders omits auth when none is supplied', () => {
  const headers = buildRequestHeaders({})
  const names = Object.keys(headers).map((name) => name.toLowerCase())
  assert.equal(names.includes('authorization'), false)
  assert.equal(names.includes('x-api-key'), false)
})
