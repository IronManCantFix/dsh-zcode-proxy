/**
 * Quota reporting.
 *
 * The plan balance endpoint is the one upstream call that needs no client
 * signing, which makes it the reliable core of the settings card:
 *
 *     GET {origin}/api/v1/zcode-plan/billing/balance
 *         Authorization: Bearer <plan JWT>
 *      -> {"code":0,"data":{"server_time":…,"plans":[…],"balances":[…]}}
 *
 * `billing/current` carries only the grants; `billing/balance` is the one that
 * reports usage, so the card is built on `balance`.
 *
 * The upstream rate-limits this plane, so nothing here polls. Callers refresh
 * on demand.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_ORIGIN } from './oauth.js'
import { storeDirectory } from './store.js'

/**
 * @typedef {object} QuotaBucket
 * @property {string} id
 * @property {string} label          Human-readable model name, e.g. "GLM-5.3".
 * @property {string} planId
 * @property {string} planName
 * @property {number} total
 * @property {number} used
 * @property {number} remaining
 * @property {number} available
 * @property {string} unit
 * @property {string[]} capabilities
 * @property {number | undefined} periodStart
 * @property {number | undefined} periodEnd
 * @property {number | undefined} expiresAt
 */

/**
 * @typedef {object} QuotaSummary
 * @property {number} fetchedAt
 * @property {QuotaBucket[]} buckets
 * @property {Array<{ planId: string, name: string, status: string, endsAt?: number }>} plans
 * @property {string[]} warnings
 */

/**
 * Read a number from a field that upstream has been seen to send in either
 * snake_case or camelCase, and occasionally as a numeric string.
 *
 * @param {Record<string, unknown> | undefined} source
 * @param {...string} names
 * @returns {number | undefined}
 */
function readNumber(source, ...names) {
  for (const name of names) {
    const value = source?.[name]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

/**
 * @param {Record<string, unknown> | undefined} source
 * @param {...string} names
 * @returns {string | undefined}
 */
function readString(source, ...names) {
  for (const name of names) {
    const value = source?.[name]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

/**
 * Resolve the device identifier the quota plane requires.
 *
 * The billing endpoints reject a request that carries no `X-Device-Mid` with
 * `400 {"code":3001,"msg":"parameter error"}` — verified by experiment: the
 * same request with the header returns 200, and without it 400. Nothing about
 * the error suggests the missing header, which makes it worth stating plainly.
 *
 * Preference order:
 *   1. A device id already recorded in this plugin's own store.
 *   2. ZCode's device id, when a ZCode install is present.
 *   3. A freshly generated UUID, persisted so it stays stable.
 *
 * The identifier is an opaque correlation value, not an authentication secret.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function resolveDeviceMid(options = {}) {
  const env = options.env ?? process.env
  const path = join(storeDirectory(env), 'device-id')

  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (existing) {
        return existing
      }
    }
  } catch {
    // Fall through to regeneration.
  }

  // Reuse ZCode's identifier when the client is installed, so both tools present
  // the same device to the vendor rather than looking like two.
  let candidate
  try {
    const onboarding = join(env.ZCODE_HOME?.trim() || join(homedirPath(), '.zcode'), 'v2', 'onboarding-record.json')
    if (existsSync(onboarding)) {
      const parsed = JSON.parse(readFileSync(onboarding, 'utf8'))
      if (typeof parsed?.deviceMid === 'string' && parsed.deviceMid.trim()) {
        candidate = parsed.deviceMid.trim()
      }
    }
  } catch {
    // A malformed or absent record is not fatal.
  }

  const deviceMid = candidate ?? randomUUID()

  try {
    mkdirSync(storeDirectory(env), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${deviceMid}\n`, { mode: 0o600 })
  } catch {
    // Persisting is best effort; the caller still gets a usable id.
  }

  return deviceMid
}

/** @returns {string} */
function homedirPath() {
  // Imported lazily to keep the module's import list to what it actually needs.
  return process.env.HOME ?? process.env.USERPROFILE ?? '.'
}

/**
 * Fetch the plan quota.
 *
 * @param {{
 *   jwt: string,
 *   origin?: string,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   appVersion?: string,
 *   attempts?: number,
 * }} options
 * @returns {Promise<QuotaSummary>}
 */
export async function fetchQuota(options) {
  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const appVersion = options.appVersion ?? '3.14.4'
  const attempts = Math.max(1, options.attempts ?? 3)

  // Only `app_version` is sent: the endpoint accepts a `platform` parameter but
  // does not require one, and fewer moving parts is the better default.
  const url = `${origin}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}`

  /** @type {string[]} */
  const warnings = []
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          authorization: `Bearer ${options.jwt}`,
          'X-Device-Mid': options.deviceMid ?? resolveDeviceMid({ env: options.env }),
        },
        signal: options.signal,
      })
    } catch (error) {
      lastError = error
      continue
    }

    const text = await response.text()

    if (!response.ok) {
      lastError = new Error(`billing/balance failed: HTTP ${response.status} ${text.slice(0, 180)}`)
      continue
    }

    let envelope
    try {
      envelope = JSON.parse(text)
    } catch (error) {
      lastError = new Error('billing/balance returned a non-JSON body', { cause: error })
      continue
    }

    // A transient {"code":3001,"msg":"parameter error"} has been observed; it
    // succeeds on retry, so treat any non-zero business code as retryable.
    if (typeof envelope?.code === 'number' && envelope.code !== 0) {
      lastError = new Error(
        `billing/balance was rejected: ${envelope.msg || `code ${envelope.code}`}`,
      )
      continue
    }

    return summarize(envelope.data, warnings)
  }

  throw lastError instanceof Error ? lastError : new Error('billing/balance failed')
}

/**
 * Turn a raw envelope into the shape the card consumes.
 *
 * @param {any} data
 * @param {string[]} warnings
 * @returns {QuotaSummary}
 */
export function summarize(data, warnings = []) {
  /** @type {Map<string, string>} */
  const planNames = new Map()
  /** @type {Array<{ planId: string, name: string, status: string, endsAt?: number }>} */
  const plans = []

  const rawPlans = Array.isArray(data?.plans) ? data.plans : []
  for (const plan of rawPlans) {
    const planId = readString(plan, 'plan_id', 'planId') ?? 'unknown'
    const name = readString(plan, 'name') ?? planId
    planNames.set(planId, name)
    plans.push({
      planId,
      name,
      status: readString(plan, 'status') ?? 'unknown',
      endsAt: readNumber(plan, 'ends_at', 'endsAt'),
    })
  }

  const rawBalances = Array.isArray(data?.balances) ? data.balances : []
  if (rawBalances.length === 0) {
    warnings.push('upstream reported no quota buckets')
  }

  /** @type {QuotaBucket[]} */
  const buckets = rawBalances.map((bucket, index) => {
    const planId = readString(bucket, 'plan_id', 'planId') ?? 'unknown'
    const total = readNumber(bucket, 'total_units', 'totalUnits') ?? 0
    const used = readNumber(bucket, 'used_units', 'usedUnits') ?? 0
    const remaining =
      readNumber(bucket, 'remaining_units', 'remainingUnits') ??
      readNumber(bucket, 'available_units', 'availableUnits') ??
      Math.max(total - used, 0)

    return {
      id:
        readString(bucket, 'bucket_id', 'bucketId') ??
        readString(bucket, 'entitlement_id', 'entitlementId') ??
        `bucket-${index}`,
      label: readString(bucket, 'show_name', 'showName') ?? 'unknown',
      planId,
      planName: planNames.get(planId) ?? planId,
      total,
      used,
      remaining,
      available: readNumber(bucket, 'available_units', 'availableUnits') ?? remaining,
      unit: readString(bucket, 'unit_type', 'unitType') ?? 'unit',
      capabilities: Array.isArray(bucket?.capabilities)
        ? bucket.capabilities.filter((entry) => typeof entry === 'string')
        : [],
      periodStart: readNumber(bucket, 'period_start', 'periodStart'),
      periodEnd: readNumber(bucket, 'period_end', 'periodEnd'),
      expiresAt: readNumber(bucket, 'expires_at', 'expiresAt'),
    }
  })

  return { fetchedAt: Date.now(), buckets, plans, warnings }
}

/**
 * Derive the model ids a quota summary grants access to.
 *
 * Entitlements carry `model:<id>` capability strings, which is the
 * authoritative list of what this account may call — more so than the model
 * catalogue bundled with any particular client version.
 *
 * @param {QuotaSummary} summary
 * @returns {string[]}
 */
export function grantedModelIds(summary) {
  /** @type {Set<string>} */
  const ids = new Set()
  for (const bucket of summary.buckets) {
    for (const capability of bucket.capabilities) {
      const match = /^model:(.+)$/.exec(capability)
      if (match) {
        ids.add(match[1])
      }
    }
  }
  return [...ids]
}

/**
 * Render a byte-ish token count compactly for the card.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatUnits(value) {
  if (!Number.isFinite(value)) {
    return '—'
  }
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`
  }
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }
  return String(Math.round(value))
}
