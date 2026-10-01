/**
 * Upstream endpoint and request-header construction for ZCode.
 *
 * Two facts drive this module, both established by reading the shipped client
 * and by inspecting a real successful request on this machine:
 *
 * 1. ZCode routes official Coding Plan endpoints through its own platform
 *    gateway. The rewrite table lives in the open-source client
 *    (`official-coding-plan-gateway.ts`):
 *
 *        https://open.bigmodel.cn/api/anthropic  ->  {origin}/api/v1/ultra/anthropic
 *        https://api.z.ai/api/anthropic          ->  {origin}/api/v1/ultra-zai/anthropic
 *
 *    Request method, body, auth headers and response pass through unchanged.
 *
 * 2. The Anthropic base URL is normalised by appending `/v1` when the path does
 *    not already end with it, and the Anthropic SDK then appends `/messages`.
 *    So the final URL is `<gateway path>/v1/messages`.
 *
 * The header set below is the one a real `account:bigmodel-start-plan` request
 * actually carried, captured from ZCode's own model-I/O record. Keeping this
 * list faithful matters: the gateway is fronted by a CDN that returns a
 * business-level `3012` block for requests that do not look like the official
 * client.
 */

/** ZCode app version reported in headers. Kept configurable for drift. */
export const DEFAULT_APP_VERSION = '3.14.4'

/** The agent id ZCode reports for its own coding agent. */
export const ZCODE_AGENT = 'glm'

/** Official ZCode platform origin, used for gateway URLs and Referer. */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/**
 * Regions ZCode can be logged in to. The credential store records the active
 * one as `oauth:active_provider`.
 *
 * @typedef {'zai' | 'bigmodel'} ZcodeRegion
 */

/**
 * Per-region endpoint facts.
 *
 * `officialAnthropic` is the vendor endpoint a user would configure by hand.
 * `gatewayPath` is where ZCode actually sends it. `apiOrigin` is the origin
 * that owns the vendor API (and, notably, the signing handshake route).
 *
 * @type {Record<ZcodeRegion, {
 *   label: string,
 *   apiOrigin: string,
 *   officialAnthropic: string,
 *   gatewayOrigin: string,
 *   gatewayPath: string,
 * }>}
 */
export const REGIONS = Object.freeze({
  bigmodel: Object.freeze({
    label: '智谱 BigModel（国内版）',
    apiOrigin: 'https://open.bigmodel.cn',
    officialAnthropic: 'https://open.bigmodel.cn/api/anthropic',
    gatewayOrigin: ZCODE_ORIGIN,
    gatewayPath: '/api/v1/ultra/anthropic',
  }),
  zai: Object.freeze({
    label: 'Z.AI（国际版）',
    apiOrigin: 'https://api.z.ai',
    officialAnthropic: 'https://api.z.ai/api/anthropic',
    gatewayOrigin: ZCODE_ORIGIN,
    gatewayPath: '/api/v1/ultra-zai/anthropic',
  }),
})

/**
 * The ZCode-plan endpoint family. Unlike the gateway above, this one is
 * protected by client request signing for most access modes.
 *
 * @param {ZcodeRegion} region
 * @returns {string}
 */
export function zcodePlanBaseUrl(region) {
  void region // The plan endpoint is shared across regions.
  return `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic`
}

/**
 * Apply ZCode's base-URL normalisation: ensure the path ends with `/v1`, which
 * is what the Anthropic SDK expects before it appends `/messages`.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeAnthropicBaseUrl(baseUrl) {
  const trimmed = (baseUrl ?? '').trim()
  if (!trimmed) {
    throw new Error('base URL is required')
  }
  const withoutTrailingSlash = trimmed.replace(/\/+$/u, '')
  return withoutTrailingSlash.toLowerCase().endsWith('/v1')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/v1`
}

/**
 * Resolve the URL a message request is actually sent to.
 *
 * @param {{ region: ZcodeRegion, useGateway?: boolean }} options
 * @returns {string}
 */
export function resolveMessagesUrl({ region, useGateway = true }) {
  const entry = REGIONS[region]
  if (!entry) {
    throw new Error(`unknown ZCode region: ${String(region)}`)
  }
  const base = useGateway
    ? `${entry.gatewayOrigin}${entry.gatewayPath}`
    : entry.officialAnthropic
  return `${normalizeAnthropicBaseUrl(base)}/messages`
}

/**
 * @param {Record<string, string | undefined>} headers
 * @returns {Record<string, string>}
 */
function dropUndefined(headers) {
  /** @type {Record<string, string>} */
  const result = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value !== '') {
      result[key] = value
    }
  }
  return result
}

/**
 * Build the fingerprint headers ZCode sends on every model request.
 *
 * These come from `buildCliZCodeSourceHeaders` / `createRuntimePlatformHeaders`
 * in the client, and the list was confirmed against a captured real request.
 *
 * @param {{
 *   appVersion?: string,
 *   deviceMid?: string,
 *   language?: string,
 *   timezone?: string,
 *   platform?: NodeJS.Platform | string,
 *   arch?: string,
 *   osRelease?: string,
 *   sourceTitle?: 'electron' | 'cli',
 * }} [options]
 * @returns {Record<string, string>}
 */
export function buildFingerprintHeaders(options = {}) {
  const appVersion = options.appVersion?.trim() || DEFAULT_APP_VERSION
  const sourceTitle = options.sourceTitle ?? 'electron'
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch

  return dropUndefined({
    'HTTP-Referer': ZCODE_ORIGIN,
    'User-Agent': `ZCode/${appVersion}`,
    'X-ZCode-App-Version': appVersion,
    'X-Title': `Z Code@${sourceTitle}`,
    'X-Release-Channel': 'production',
    'X-Client-Language': options.language ?? 'zh-CN',
    'X-Client-Timezone': options.timezone ?? 'Asia/Shanghai',
    'X-ZCode-Agent': ZCODE_AGENT,
    'X-Platform': `${platform}-${arch}`,
    'X-Os-Category': osCategory(platform),
    'X-Os-Version': options.osRelease ?? '',
    'X-Device-Mid': options.deviceMid ?? '',
  })
}

/**
 * @param {string} platform
 * @returns {string}
 */
export function osCategory(platform) {
  switch (platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return 'linux'
  }
}

/**
 * Assemble the full header set for one messages request.
 *
 * Auth is intentionally *not* included here: which credential is presented (or
 * whether the gateway expects one at all) differs per access mode, so callers
 * add it explicitly. See `access.js`.
 *
 * @param {{
 *   fingerprint?: Record<string, string>,
 *   sessionId?: string,
 *   requestId?: string,
 *   traceId?: string,
 *   queryId?: string,
 *   sessionType?: string,
 *   anthropicVersion?: string,
 *   auth?: Record<string, string>,
 * }} [options]
 * @returns {Record<string, string>}
 */
export function buildRequestHeaders(options = {}) {
  return dropUndefined({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...options.fingerprint,
    'anthropic-version': options.anthropicVersion ?? '2023-06-01',
    'X-Request-Id': options.requestId,
    'X-Session-Id': options.sessionId,
    'X-Zcode-Session-Type': options.sessionType,
    'X-Zcode-Trace-Id': options.traceId,
    'X-Query-Id': options.queryId,
    ...options.auth,
  })
}
