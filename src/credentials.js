/**
 * ZCode credential discovery and decryption.
 *
 * ZCode (智谱 Z.ai 的编程客户端) stores its login material in
 * `~/.zcode/v2/credentials.json` as AES-256-GCM envelopes:
 *
 *     enc:v1:<iv-b64url>.<authTag-b64url>.<ciphertext-b64url>
 *
 * The key is `sha256(secret)` where `secret` is the `ZCODE_CREDENTIAL_SECRET`
 * environment variable when set, and otherwise a string derived from the
 * machine and user:
 *
 *     zcode-credential-fallback:<platform>:<homedir>:<username>
 *
 * This was read out of the shipped `zcode.cjs` bundle
 * (`createZCodeCredentialCipher` / `deriveCipherKey` / `resolveCredentialSecret`)
 * and verified by decrypting a real store on macOS. No Keychain, no code
 * signing, no device binding is involved.
 *
 * This module is deliberately free of any DSH dependency so it can be tested
 * with plain `node`.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'

/** Prefix marking an encrypted credential value. */
export const ENCRYPTED_PREFIX = 'enc:v1:'

/** Environment variable that overrides the machine-derived cipher secret. */
export const CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET'

/** AES-GCM parameters used by ZCode. */
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const KEY_BYTES = 32

/**
 * Resolve the cipher secret.
 *
 * Mirrors `resolveCredentialSecret` in the ZCode bundle, including its
 * fallback string. The fallback is what makes offline decryption possible:
 * it depends only on values any local process can compute.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveCredentialSecret(env = process.env) {
  const fromEnvironment = (env?.[CREDENTIAL_SECRET_ENV] ?? '').trim()
  if (fromEnvironment) {
    return fromEnvironment
  }

  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // `userInfo()` can throw when the uid has no passwd entry (containers).
    // ZCode falls back to the literal string 'unknown'; match that exactly.
  }

  return `zcode-credential-fallback:${platform().toLowerCase()}:${homedir()}:${username}`
}

/**
 * Derive the AES key from the secret. Matches `deriveCipherKey`:
 * a single unsalted SHA-256 over the UTF-8 secret.
 *
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveCipherKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isBase64Url(value) {
  return /^[A-Za-z0-9_-]*$/.test(value)
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
function fromBase64Url(value) {
  if (!isBase64Url(value)) {
    throw new Error('credential ciphertext is not valid base64url')
  }
  return Buffer.from(value, 'base64url')
}

/**
 * Decrypt one credential value.
 *
 * A value that is not an `enc:v1:` envelope is returned unchanged, matching
 * ZCode's own tolerant behaviour.
 *
 * @param {string} value
 * @param {string} secret
 * @returns {string}
 */
export function decryptCredentialValue(value, secret) {
  if (!isEncryptedValue(value)) {
    return value
  }

  const parts = value.slice(ENCRYPTED_PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new Error('credential decrypt failed: invalid ciphertext format')
  }
  const [ivPart, tagPart, dataPart] = parts
  const iv = fromBase64Url(ivPart)
  const authTag = fromBase64Url(tagPart)
  const data = fromBase64Url(dataPart)

  if (iv.length !== IV_BYTES) {
    throw new Error('credential decrypt failed: invalid IV length')
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('credential decrypt failed: invalid auth tag length')
  }

  const key = deriveCipherKey(secret)
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new Error('credential decrypt failed: key mismatch or corrupted ciphertext', {
      cause: error,
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Well-known credential keys inside the ZCode store.
 *
 * ZCode namespaces its entries by OAuth provider; `oauth:active_provider`
 * tells us which one is live (`zai` or `bigmodel`).
 */
export const CREDENTIAL_KEYS = Object.freeze({
  activeProvider: 'oauth:active_provider',
  zaiAccessToken: 'oauth:zai:access_token',
  bigmodelAccessToken: 'oauth:bigmodel:access_token',
  zaiUserInfo: 'oauth:zai:user_info',
  bigmodelUserInfo: 'oauth:bigmodel:user_info',
  zcodeJwtToken: 'zcodejwttoken',
})

/**
 * Locate the ZCode data directory.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function zcodeDataDirectory(env = process.env) {
  const override = (env?.ZCODE_HOME ?? '').trim()
  return override || join(homedir(), '.zcode')
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function credentialStorePath(env = process.env) {
  return join(zcodeDataDirectory(env), 'v2', 'credentials.json')
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function onboardingRecordPath(env = process.env) {
  return join(zcodeDataDirectory(env), 'v2', 'onboarding-record.json')
}

/**
 * Read and decrypt the credential store.
 *
 * @param {{ env?: NodeJS.ProcessEnv, filePath?: string }} [options]
 * @returns {Map<string, string>} decrypted key/value pairs
 */
export function readCredentialStore(options = {}) {
  const env = options.env ?? process.env
  const filePath = options.filePath ?? credentialStorePath(env)
  const secret = resolveCredentialSecret(env)

  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`unable to read ZCode credentials at ${filePath}`, { cause: error })
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`ZCode credentials at ${filePath} are not valid JSON`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ZCode credentials at ${filePath} are not a JSON object`)
  }

  /** @type {Map<string, string>} */
  const decrypted = new Map()
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      continue
    }
    decrypted.set(key, decryptCredentialValue(value, secret))
  }
  return decrypted
}

/**
 * Read the device identifier ZCode sends as `X-Device-Mid`.
 *
 * @param {{ env?: NodeJS.ProcessEnv, filePath?: string }} [options]
 * @returns {string | undefined}
 */
export function readDeviceMid(options = {}) {
  const env = options.env ?? process.env
  const filePath = options.filePath ?? onboardingRecordPath(env)
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    const deviceMid = parsed?.deviceMid
    return typeof deviceMid === 'string' && deviceMid.trim() ? deviceMid.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Decode a JWT payload without verifying the signature.
 *
 * Only used to read metadata such as `user_id`; never for trust decisions.
 *
 * @param {string} token
 * @returns {Record<string, unknown> | undefined}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') {
    return undefined
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    return undefined
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a Zhipu API key into its two halves.
 *
 * Zhipu issues keys shaped `<32-char id>.<16-char secret>`. ZCode's signing
 * layer splits them the same way (`parseClientSigningCredential`), requiring
 * exactly one `.` with non-empty sides.
 *
 * @param {string} apiKey
 * @returns {{ apiKeyId: string, apiKeySecret: string } | undefined}
 */
export function parseApiKey(apiKey) {
  if (typeof apiKey !== 'string') {
    return undefined
  }
  const separator = apiKey.indexOf('.')
  if (separator <= 0 || separator !== apiKey.lastIndexOf('.')) {
    return undefined
  }
  const apiKeyId = apiKey.slice(0, separator)
  const apiKeySecret = apiKey.slice(separator + 1)
  if (!apiKeyId.trim() || !apiKeySecret.trim()) {
    return undefined
  }
  return { apiKeyId, apiKeySecret }
}

/** Credential key prefix for per-account coding-plan API keys. */
const ACCOUNT_PROVIDER_PREFIX = 'account-provider:'
const API_KEY_SUFFIX = ':api-key'

/**
 * Collect every per-account API key from the credential store.
 *
 * Keys look like:
 *   account-provider:coding-plan:account:<provider>:account:<accountId>:api-key
 *
 * @param {Map<string, string>} store
 * @returns {Array<{ key: string, provider: string, accountId: string | undefined, apiKey: string }>}
 */
export function collectAccountApiKeys(store) {
  /** @type {Array<{ key: string, provider: string, accountId: string | undefined, apiKey: string }>} */
  const found = []
  for (const [key, value] of store) {
    if (!key.startsWith(ACCOUNT_PROVIDER_PREFIX) || !key.endsWith(API_KEY_SUFFIX)) {
      continue
    }
    const middle = key.slice(ACCOUNT_PROVIDER_PREFIX.length, -API_KEY_SUFFIX.length)
    const segments = middle.split(':')
    // ...:account:<provider>:account:<accountId>
    const providerIndex = segments.lastIndexOf('account')
    const provider = providerIndex > 0 ? segments[providerIndex - 1] : undefined
    const accountId = providerIndex >= 0 ? segments[providerIndex + 1] : undefined
    found.push({ key, provider: provider ?? 'unknown', accountId, apiKey: value })
  }
  return found
}

/**
 * Describe the ZCode login present on this machine.
 *
 * This is the read-only discovery surface the provider is built on. It never
 * writes to `~/.zcode`.
 *
 * A missing credential store is a hard error: without it there is no login to
 * describe. A store that exists but lacks entries is not — that is reported
 * through `warnings` so the settings card can explain what is missing.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   filePath?: string,
 *   onboardingFilePath?: string,
 * }} [options]
 * @returns {{
 *   storePath: string,
 *   activeProvider: string | undefined,
 *   region: 'zai' | 'bigmodel' | undefined,
 *   accessToken: string | undefined,
 *   zcodeJwtToken: string | undefined,
 *   deviceMid: string | undefined,
 *   apiKeys: ReturnType<typeof collectAccountApiKeys>,
 *   warnings: string[]
 * }}
 */
export function discoverZcodeAccount(options = {}) {
  const env = options.env ?? process.env
  /** @type {string[]} */
  const warnings = []
  const filePath = options.filePath ?? credentialStorePath(env)
  const store = readCredentialStore({ env, filePath })

  const activeProvider = store.get(CREDENTIAL_KEYS.activeProvider)?.trim()
  /** @type {'zai' | 'bigmodel' | undefined} */
  let region
  if (activeProvider === 'zai' || activeProvider === 'bigmodel') {
    region = activeProvider
  } else if (activeProvider) {
    warnings.push(`unrecognised active provider: ${activeProvider}`)
  } else {
    warnings.push('no oauth:active_provider entry in the credential store')
  }

  // The region decides which access-token entry and which upstream host apply.
  const accessToken = region ? store.get(`oauth:${region}:access_token`) : undefined
  if (region && !accessToken) {
    warnings.push(`no oauth:${region}:access_token entry in the credential store`)
  }

  const apiKeys = collectAccountApiKeys(store)
  if (apiKeys.length === 0) {
    warnings.push('no per-account coding-plan api-key found')
  }

  return {
    storePath: filePath,
    activeProvider,
    region,
    accessToken,
    zcodeJwtToken: store.get(CREDENTIAL_KEYS.zcodeJwtToken),
    deviceMid: readDeviceMid({ env, filePath: options.onboardingFilePath }),
    apiKeys,
    warnings,
  }
}
