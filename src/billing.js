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
 * @property {number | undefined} effectiveAt  When this grant starts being usable; undefined when upstream did not say.
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
 * Two upstream shapes have to be understood, not just one.
 *
 * `balances[]` is the usage plane, but it is only populated for entitlements
 * that are already *live*. A freshly granted plan — the common case right after
 * a promotion is credited — reports its grants under `plans[].entitlements[]`
 * and leaves `balances` as an empty array:
 *
 *     {"code":0,"data":{"server_time":…,"plans":[{"entitlements":[
 *        {"show_name":"GLM-5.3","grant_units":200000000,
 *         "effective_at":1792767600,"capabilities":["model:glm-5.3"]}]}],
 *      "balances":[]}}
 *
 * Reading only `balances` therefore told the user "上游未返回任何额度桶" for an
 * account that plainly had 500M tokens granted — the grants simply had not
 * started yet. When `balances` is empty, the entitlements are folded in as
 * not-yet-started buckets, and `effective_at` is carried so the card can say
 * *when* the quota becomes usable instead of implying there is none.
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
  /** @type {Map<string, Array<any>>} */
  const planEntitlements = new Map()

  const rawPlans = Array.isArray(data?.plans) ? data.plans : []
  for (const plan of rawPlans) {
    const planId = readString(plan, 'plan_id', 'planId') ?? 'unknown'
    const name = readString(plan, 'name') ?? planId
    planNames.set(planId, name)
    if (Array.isArray(plan?.entitlements)) {
      planEntitlements.set(planId, plan.entitlements)
    }
    plans.push({
      planId,
      name,
      status: readString(plan, 'status') ?? 'unknown',
      endsAt: readNumber(plan, 'ends_at', 'endsAt'),
    })
  }

  const rawBalances = Array.isArray(data?.balances) ? data.balances : []
  const buckets = rawBalances.map((bucket, index) => toBucket(bucket, index, planNames))

  if (rawBalances.length === 0) {
    // No usage rows. Fall back to the grant rows so an account that *has*
    // quota is never described as having none. Usage is genuinely unknown
    // before the grant starts, so `used` stays 0 and the bucket is marked
    // pending rather than pretending to be fully available.
    const pending = [...planEntitlements.entries()].flatMap(([planId, entitlements]) =>
      entitlements.map((entitlement, index) =>
        toBucket({ ...entitlement, plan_id: planId }, index, planNames),
      ),
    )

    if (pending.length > 0) {
      buckets.push(...pending)
      const now = readNumber(data, 'server_time', 'serverTime')
      const notStarted = pending.filter(
        (bucket) => bucket.effectiveAt !== undefined && now !== undefined && bucket.effectiveAt > now,
      )
      if (notStarted.length > 0) {
        const first = Math.min(...notStarted.map((bucket) => bucket.effectiveAt))
        warnings.push(
          `quota has not started yet: ${notStarted.length} entitlement(s) become usable at ` +
            `${new Date(first * 1000).toISOString()}`,
        )
      }
    } else {
      warnings.push('upstream reported no quota buckets')
    }
  }

  return { fetchedAt: Date.now(), buckets, plans, warnings }
}

/**
 * Build one bucket from either a `balances[]` row or a `plans[].entitlements[]`
 * grant row.
 *
 * The two share most field names (`show_name`, `unit_type`, `capabilities`) but
 * differ in the totals: a balance row reports `total_units`, a grant row reports
 * `grant_units`. Both are read, so one shape's absence does not read as zero.
 *
 * @param {any} source
 * @param {number} index
 * @param {Map<string, string>} planNames
 * @returns {QuotaBucket}
 */
function toBucket(source, index, planNames) {
  const planId = readString(source, 'plan_id', 'planId') ?? 'unknown'
  const total =
    readNumber(source, 'total_units', 'totalUnits') ??
    readNumber(source, 'grant_units', 'grantUnits') ??
    0
  const used = readNumber(source, 'used_units', 'usedUnits') ?? 0
  const remaining =
    readNumber(source, 'remaining_units', 'remainingUnits') ??
    readNumber(source, 'available_units', 'availableUnits') ??
    Math.max(total - used, 0)

  return {
    id:
      readString(source, 'bucket_id', 'bucketId') ??
      readString(source, 'entitlement_id', 'entitlementId') ??
      `bucket-${index}`,
    label: readString(source, 'show_name', 'showName') ?? 'unknown',
    planId,
    planName: planNames.get(planId) ?? planId,
    total,
    used,
    remaining,
    available: readNumber(source, 'available_units', 'availableUnits') ?? remaining,
    unit: readString(source, 'unit_type', 'unitType') ?? 'unit',
    capabilities: Array.isArray(source?.capabilities)
      ? source.capabilities.filter((entry) => typeof entry === 'string')
      : [],
    periodStart: readNumber(source, 'period_start', 'periodStart'),
    periodEnd: readNumber(source, 'period_end', 'periodEnd'),
    expiresAt: readNumber(source, 'expires_at', 'expiresAt'),
    // Carried so the card can distinguish "granted and usable" from "granted
    // but not started yet". Undefined means the upstream did not say.
    effectiveAt: readNumber(source, 'effective_at', 'effectiveAt'),
  }
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
