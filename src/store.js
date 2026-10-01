/**
 * Local credential storage for the plugin's own login.
 *
 * The plugin authenticates itself (see `oauth.js`) rather than borrowing the
 * ZCode client's session, so it needs somewhere to keep the result. The shape
 * deliberately mirrors what ZCode does — AES-256-GCM under a SHA-256-derived
 * key, base64url envelope — because that construction is already proven on
 * this platform and needs no native bindings.
 *
 * Unlike ZCode's store, the seed is explicit:
 *
 *   - `ZCODE_PROXY_CREDENTIAL_SECRET` when set (portable across machines), or
 *   - a machine-derived fallback string.
 *
 * The fallback is a convenience, not a security boundary: anything that can
 * read the file can usually compute the fallback too. Setting the environment
 * variable is what makes the file actually private. This is stated plainly
 * rather than implied.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

/** Prefix identifying an encrypted value. */
export const ENCRYPTED_PREFIX = 'enc:v1:'

/** Environment variable that supplies the storage seed. */
export const STORE_SECRET_ENV = 'ZCODE_PROXY_CREDENTIAL_SECRET'

/** Environment variable that overrides the DSH home directory. */
export const DSH_HOME_ENV = 'DSH_HOME'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * Resolve the DSH home directory.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const override = (env?.[DSH_HOME_ENV] ?? '').trim()
  return override || join(homedir(), '.dsh')
}

/**
 * Where this plugin keeps its state.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function storeDirectory(env = process.env) {
  return join(dshHome(env), 'zcode-proxy')
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function storePath(env = process.env) {
  return join(storeDirectory(env), 'credentials.json')
}

/**
 * Resolve the storage seed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveStoreSecret(env = process.env) {
  const fromEnvironment = (env?.[STORE_SECRET_ENV] ?? '').trim()
  if (fromEnvironment) {
    return fromEnvironment
  }
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // Match ZCode's fallback behaviour when the uid has no passwd entry.
  }
  return `zcode-proxy-fallback:${platform().toLowerCase()}:${homedir()}:${username}`
}

/**
 * @param {string} secret
 * @returns {Buffer}
 */
function deriveKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * @param {string} plaintext
 * @param {string} secret
 * @returns {string}
 */
export function encryptValue(plaintext, secret) {
  const key = deriveKey(secret)
  const iv = randomBytes(IV_BYTES)
  try {
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return (
      ENCRYPTED_PREFIX +
      [iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.')
    )
  } finally {
    key.fill(0)
  }
}

/**
 * @param {string} value
 * @param {string} secret
 * @returns {string}
 */
export function decryptValue(value, secret) {
  if (typeof value !== 'string' || !value.startsWith(ENCRYPTED_PREFIX)) {
    return value
  }
  const parts = value.slice(ENCRYPTED_PREFIX.length).split('.')
  if (parts.length !== 3) {
    throw new Error('stored credential is malformed')
  }
  const [ivPart, tagPart, dataPart] = parts
  const iv = Buffer.from(ivPart, 'base64url')
  const tag = Buffer.from(tagPart, 'base64url')
  const data = Buffer.from(dataPart, 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw new Error('stored credential is malformed')
  }

  const key = deriveKey(secret)
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new Error(
      'unable to decrypt the stored credential: wrong secret, or the file was corrupted',
      { cause: error },
    )
  } finally {
    key.fill(0)
  }
}

/**
 * @typedef {object} StoredCredential
 * @property {'zai' | 'bigmodel'} provider
 * @property {string} accessToken
 * @property {string | undefined} jwt  ZCode plan JWT, when the login returned one.
 * @property {string | undefined} apiKey  Coding-plan API key, when one was resolved.
 * @property {string} [userId]
 * @property {string} [savedAt]  ISO timestamp.
 */

/**
 * Write the credential store atomically with owner-only permissions.
 *
 * @param {StoredCredential} credential
 * @param {{ env?: NodeJS.ProcessEnv, path?: string, secret?: string }} [options]
 * @returns {string} the path written
 */
export function saveCredential(credential, options = {}) {
  const env = options.env ?? process.env
  const path = options.path ?? storePath(env)
  const secret = options.secret ?? resolveStoreSecret(env)

  const directory = dirname(path)
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    credential: encryptValue(JSON.stringify(credential), secret),
  }

  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort: some filesystems reject chmod, and the rename already
    // applied the creation mode.
  }
  return path
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, path?: string, secret?: string }} [options]
 * @returns {StoredCredential | undefined}
 */
export function loadCredential(options = {}) {
  const env = options.env ?? process.env
  const path = options.path ?? storePath(env)
  const secret = options.secret ?? resolveStoreSecret(env)

  if (!existsSync(path)) {
    return undefined
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read the stored credential at ${path}`, { cause: error })
  }

  const encrypted = parsed?.credential
  if (typeof encrypted !== 'string') {
    throw new Error(`the stored credential at ${path} has no credential field`)
  }

  const decoded = JSON.parse(decryptValue(encrypted, secret))
  if (decoded === null || typeof decoded !== 'object') {
    throw new Error(`the stored credential at ${path} is not an object`)
  }
  return decoded
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, path?: string }} [options]
 * @returns {boolean}
 */
export function clearCredential(options = {}) {
  const env = options.env ?? process.env
  const path = options.path ?? storePath(env)
  if (!existsSync(path)) {
    return false
  }
  // Overwrite before unlinking so the ciphertext is not left behind.
  writeFileSync(path, '', { mode: 0o600 })
  unlinkSync(path)
  return true
}

/**
 * Describe whether a usable credential is present, without leaking it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, path?: string }} [options]
 * @returns {{ present: boolean, path: string, provider?: string, hasJwt?: boolean, hasApiKey?: boolean, savedAt?: string, error?: string }}
 */
export function describeCredential(options = {}) {
  const env = options.env ?? process.env
  const path = options.path ?? storePath(env)
  try {
    const credential = loadCredential({ env, path })
    if (!credential) {
      return { present: false, path }
    }
    return {
      present: true,
      path,
      provider: credential.provider,
      hasJwt: typeof credential.jwt === 'string' && credential.jwt.length > 0,
      hasApiKey: typeof credential.apiKey === 'string' && credential.apiKey.length > 0,
      savedAt: credential.savedAt,
    }
  } catch (error) {
    return { present: false, path, error: error instanceof Error ? error.message : String(error) }
  }
}
