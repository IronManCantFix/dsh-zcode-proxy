/**
 * Unit tests for quota summarisation and formatting.
 *
 * Run with: node --test test/*.test.js
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fetchQuota, formatUnits, grantedModelIds, resolveDeviceMid, summarize } from '../src/billing.js'

/**
 * @param {Array<{ status?: number, body?: unknown, raw?: string }>} responses
 */
function stubFetch(responses) {
  let index = 0
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(spec.raw ?? JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl: /** @type {typeof fetch} */ (fetchImpl), calls }
}

const BALANCE_PAYLOAD = {
  code: 0,
  msg: '',
  data: {
    server_time: 1790819055,
    plans: [
      {
        plan_id: 'zcode-v3-start-plan-0817',
        name: 'ZCode Start Plan',
        status: 'active',
        ends_at: 1791043199,
      },
    ],
    balances: [
      {
        bucket_id: 'bucket-1',
        plan_id: 'zcode-v3-start-plan-0817',
        show_name: 'GLM-5.3',
        unit_type: 'token',
        capabilities: ['model:glm-5.3'],
        total_units: 3_000_000,
        used_units: 1_000_000,
        remaining_units: 2_000_000,
        available_units: 2_000_000,
        period_start: 1790784000,
        period_end: 1790870399,
      },
      {
        bucket_id: 'bucket-2',
        plan_id: 'zcode-v3-start-plan-0817',
        show_name: 'GLM-5.3-Flash',
        unit_type: 'token',
        capabilities: ['model:glm-5.3-flash'],
        total_units: 5_000_000,
        used_units: 0,
        remaining_units: 5_000_000,
      },
    ],
  },
}

test('fetchQuota sends the plan token and parses buckets', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: BALANCE_PAYLOAD }])
  const quota = await fetchQuota({ jwt: 'the-jwt', fetchImpl, deviceMid: 'device-under-test' })

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/v1\/zcode-plan\/billing\/balance\?app_version=/)
  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get('authorization'), 'Bearer the-jwt')
  // The quota plane answers 400/3001 when this header is missing, so it is
  // pinned here rather than left to the end-to-end check to notice.
  assert.equal(headers.get('x-device-mid'), 'device-under-test')

  assert.equal(quota.buckets.length, 2)
  assert.equal(quota.buckets[0].label, 'GLM-5.3')
  assert.equal(quota.buckets[0].remaining, 2_000_000)
  assert.equal(quota.buckets[0].planName, 'ZCode Start Plan')
  assert.deepEqual(quota.plans.map((plan) => plan.name), ['ZCode Start Plan'])
})

test('fetchQuota retries the transient 3001 parameter error', async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { code: 3001, msg: 'parameter error', data: null } },
    { body: BALANCE_PAYLOAD },
  ])
  const quota = await fetchQuota({ jwt: 'jwt', fetchImpl })
  assert.equal(calls.length, 2)
  assert.equal(quota.buckets.length, 2)
})

test('fetchQuota gives up after the configured attempts', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: { code: 3001, msg: 'parameter error' } }])
  await assert.rejects(() => fetchQuota({ jwt: 'jwt', fetchImpl, attempts: 2 }), /parameter error/)
  assert.equal(calls.length, 2)
})

test('fetchQuota surfaces an HTTP failure', async () => {
  const { fetchImpl } = stubFetch([{ status: 500, raw: 'boom' }])
  await assert.rejects(() => fetchQuota({ jwt: 'jwt', fetchImpl, attempts: 1 }), /HTTP 500/)
})

test('summarize derives remaining when the field is absent', () => {
  const summary = summarize({
    plans: [],
    balances: [{ show_name: 'X', total_units: 100, used_units: 30 }],
  })
  assert.equal(summary.buckets[0].remaining, 70)
})

test('summarize reads remaining_units in preference to deriving it', () => {
  // A bucket that reports remaining explicitly must use it, even when
  // total/used would suggest a different number, and even when no
  // available_units field is present to fall back on.
  const summary = summarize({
    plans: [],
    balances: [{ show_name: 'X', total_units: 100, used_units: 30, remaining_units: 55 }],
  })
  assert.equal(summary.buckets[0].remaining, 55)
})

test('summarize falls back to available_units only when remaining is absent', () => {
  const summary = summarize({
    plans: [],
    balances: [{ show_name: 'X', total_units: 100, used_units: 30, available_units: 44 }],
  })
  assert.equal(summary.buckets[0].remaining, 44)
})

test('summarize accepts camelCase spellings', () => {
  const summary = summarize({
    plans: [{ planId: 'p1', name: 'Plan One', status: 'active' }],
    balances: [{ planId: 'p1', showName: 'Y', totalUnits: '200', usedUnits: '50' }],
  })
  assert.equal(summary.buckets[0].label, 'Y')
  assert.equal(summary.buckets[0].total, 200)
  assert.equal(summary.buckets[0].remaining, 150)
  assert.equal(summary.buckets[0].planName, 'Plan One')
})

test('summarize warns when upstream reports nothing', () => {
  const summary = summarize({})
  assert.equal(summary.buckets.length, 0)
  assert.ok(summary.warnings.some((warning) => warning.includes('no quota buckets')))
})

test('grantedModelIds reads the model: capability prefix', () => {
  const summary = summarize(BALANCE_PAYLOAD.data)
  assert.deepEqual(grantedModelIds(summary).sort(), ['glm-5.3', 'glm-5.3-flash'])
})

test('grantedModelIds ignores non-model capabilities', () => {
  const summary = summarize({ balances: [{ capabilities: ['other:thing', 'model:glm-5.3'] }] })
  assert.deepEqual(grantedModelIds(summary), ['glm-5.3'])
})

test('formatUnits renders compact magnitudes', () => {
  assert.equal(formatUnits(3_000_000), '3.00M')
  assert.equal(formatUnits(1_500), '1.5K')
  assert.equal(formatUnits(108_000_000), '108.00M')
  assert.equal(formatUnits(42), '42')
  assert.equal(formatUnits(Number.NaN), '—')
})

test('resolveDeviceMid prefers an already-stored identifier', () => {
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'zcode-connect-device-')) }
  const first = resolveDeviceMid({ env })
  assert.match(first, /^[0-9a-f-]{36}$/i)
  // A second call must not rotate the identifier.
  assert.equal(resolveDeviceMid({ env }), first)
})

test('resolveDeviceMid reuses the ZCode device id when one is present', () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-connect-zcode-'))
  const zcodeHome = join(home, '.zcode')
  mkdirSync(join(zcodeHome, 'v2'), { recursive: true })
  writeFileSync(
    join(zcodeHome, 'v2', 'onboarding-record.json'),
    JSON.stringify({ deviceMid: 'a7312f04-47a3-46b2-bae6-14efa5baef49' }),
    { mode: 0o600 },
  )

  const env = {
    DSH_HOME: mkdtempSync(join(tmpdir(), 'zcode-connect-dsh-')),
    ZCODE_HOME: zcodeHome,
  }
  assert.equal(resolveDeviceMid({ env }), 'a7312f04-47a3-46b2-bae6-14efa5baef49')
})
