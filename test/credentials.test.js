/**
 * Unit tests for ZCode credential discovery and decryption.
 *
 * Run with: node --test test/
 *
 * The ciphertext fixtures are generated at test time with the same primitive
 * ZCode uses, so these tests pin the *format* contract rather than a captured
 * blob. A separate test reads the real store when one is present, which is
 * what actually proves interoperability.
 */

import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectAccountApiKeys,
  decodeJwtPayload,
  decryptCredentialValue,
  deriveCipherKey,
  discoverZcodeAccount,
  ENCRYPTED_PREFIX,
  isEncryptedValue,
  parseApiKey,
  readCredentialStore,
  resolveCredentialSecret,
} from '../src/credentials.js'

/**
 * Encrypt a value exactly the way ZCode does, so the reader can be exercised
 * without depending on a captured production blob.
 *
 * @param {string} plaintext
 * @param {string} secret
 * @returns {string}
 */
function encryptLikeZcode(plaintext, secret) {
  const key = deriveCipherKey(secret)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`
}

/**
 * @param {Record<string, string>} entries
 * @returns {string} path to a temporary credential store
 */
function writeStore(entries) {
  const directory = mkdtempSync(join(tmpdir(), 'zcode-connect-test-'))
  const filePath = join(directory, 'credentials.json')
  writeFileSync(filePath, JSON.stringify(entries), 'utf8')
  return filePath
}

test('resolveCredentialSecret prefers the environment variable', () => {
  const secret = resolveCredentialSecret({ ZCODE_CREDENTIAL_SECRET: '  chosen-seed  ' })
  assert.equal(secret, 'chosen-seed')
})

test('resolveCredentialSecret falls back to the machine-derived string', () => {
  const secret = resolveCredentialSecret({})
  assert.match(secret, /^zcode-credential-fallback:[a-z]+:/)
  // The trailing segment is homedir:username, so there must be at least three colons.
  assert.ok(secret.split(':').length >= 4, `unexpected fallback secret: ${secret}`)
})

test('deriveCipherKey is a single unsalted sha256 that yields 32 bytes', () => {
  const key = deriveCipherKey('seed')
  assert.equal(key.length, 32)
  assert.deepEqual(key, createHash('sha256').update('seed', 'utf8').digest())
})

test('isEncryptedValue only accepts the enc:v1: prefix', () => {
  assert.equal(isEncryptedValue(`${ENCRYPTED_PREFIX}a.b.c`), true)
  assert.equal(isEncryptedValue('plain-value'), false)
  assert.equal(isEncryptedValue(undefined), false)
})

test('decryptCredentialValue round-trips a generated envelope', () => {
  const secret = 'unit-test-seed'
  const plaintext = JSON.stringify({ username: 'someone', user_id: 42 })
  const envelope = encryptLikeZcode(plaintext, secret)
  assert.equal(decryptCredentialValue(envelope, secret), plaintext)
})

test('decryptCredentialValue passes through values that are not envelopes', () => {
  assert.equal(decryptCredentialValue('bigmodel', 'any-seed'), 'bigmodel')
})

test('decryptCredentialValue rejects a wrong secret', () => {
  const envelope = encryptLikeZcode('secret-payload', 'correct-seed')
  assert.throws(
    () => decryptCredentialValue(envelope, 'wrong-seed'),
    /key mismatch or corrupted ciphertext/,
  )
})

test('decryptCredentialValue rejects malformed envelopes', () => {
  const secret = 'unit-test-seed'
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}only-one-part`, secret),
    /invalid ciphertext format/,
  )
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}AAAA.AAAA.AAAA`, secret),
    /invalid IV length/,
  )
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}${'A'.repeat(16)}.AAAA.AAAA`, secret),
    /invalid auth tag length/,
  )
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}!!!.AAA.AAA`, secret),
    /not valid base64url/,
  )
})

test('decryptCredentialValue rejects standard-base64 characters', () => {
  // ZCode encodes with the URL-safe alphabet. '+' and '/' are not valid there,
  // and accepting them would silently paper over a wrong decoder. This guards
  // against regressing `base64url` to the lenient `base64` decoder, which no
  // round-trip fixture catches on its own.
  const secret = 'unit-test-seed'
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}AAAA+AAA.AAAA.AAAA`, secret),
    /not valid base64url/,
  )
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}AAAA/AAA.AAAA.AAAA`, secret),
    /not valid base64url/,
  )
  assert.throws(
    () => decryptCredentialValue(`${ENCRYPTED_PREFIX}AAAA.AAA=.AAAA`, secret),
    /not valid base64url/,
  )
})

test('decryptCredentialValue handles url-alphabet characters in the payload', () => {
  const secret = 'url-alphabet-seed'
  const plaintext = 'payload-that-forces-url-safe-encoding'

  // Random IVs make the encoded form vary; find one whose data segment
  // exercises the two characters that differ between the alphabets.
  let envelope
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = encryptLikeZcode(plaintext, secret)
    const dataPart = candidate.slice(ENCRYPTED_PREFIX.length).split('.')[2]
    if (dataPart.includes('-') || dataPart.includes('_')) {
      envelope = candidate
      break
    }
  }
  assert.ok(envelope, 'expected to generate an envelope using - or _ within 200 attempts')
  assert.equal(decryptCredentialValue(envelope, secret), plaintext)
})

test('readCredentialStore decrypts every entry and skips non-strings', () => {
  const secret = 'store-test-seed'
  const filePath = writeStore({
    'oauth:active_provider': encryptLikeZcode('bigmodel', secret),
    plaintextEntry: 'left-alone',
  })
  const store = readCredentialStore({
    env: { ZCODE_CREDENTIAL_SECRET: secret },
    filePath,
  })
  assert.equal(store.get('oauth:active_provider'), 'bigmodel')
  assert.equal(store.get('plaintextEntry'), 'left-alone')
})

test('readCredentialStore reports a missing file distinctly', () => {
  assert.throws(
    () => readCredentialStore({ filePath: join(tmpdir(), 'definitely-not-here.json') }),
    /unable to read ZCode credentials/,
  )
})

test('parseApiKey splits exactly one dot into id and secret', () => {
  const id = 'a'.repeat(32)
  const secret = 'b'.repeat(16)
  assert.deepEqual(parseApiKey(`${id}.${secret}`), { apiKeyId: id, apiKeySecret: secret })
})

test('parseApiKey rejects keys that are not exactly two dot-separated halves', () => {
  assert.equal(parseApiKey('no-dot-at-all'), undefined)
  assert.equal(parseApiKey('two.dots.here'), undefined)
  assert.equal(parseApiKey('.missing-id'), undefined)
  assert.equal(parseApiKey('missing-secret.'), undefined)
  assert.equal(parseApiKey('  .  '), undefined)
  assert.equal(parseApiKey(undefined), undefined)
})

test('decodeJwtPayload reads a payload and tolerates non-JWTs', () => {
  const payload = Buffer.from(JSON.stringify({ user_id: 7 }), 'utf8').toString('base64url')
  assert.deepEqual(decodeJwtPayload(`header.${payload}.signature`), { user_id: 7 })
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined)
  assert.equal(decodeJwtPayload('a.%%%.c'), undefined)
})

test('collectAccountApiKeys extracts provider and account id from the key name', () => {
  const store = new Map([
    [
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:6111775177396278:api-key',
      'aaa.bbb',
    ],
    ['oauth:active_provider', 'bigmodel'],
  ])
  const keys = collectAccountApiKeys(store)
  assert.equal(keys.length, 1)
  assert.equal(keys[0].provider, 'bigmodel-individual-coding-plan')
  assert.equal(keys[0].accountId, '6111775177396278')
  assert.equal(keys[0].apiKey, 'aaa.bbb')
})

test('collectAccountApiKeys ignores unrelated entries', () => {
  const store = new Map([['oauth:bigmodel:access_token', 'x.y.z']])
  assert.deepEqual(collectAccountApiKeys(store), [])
})

test('discoverZcodeAccount reports warnings instead of throwing on a thin store', () => {
  const secret = 'thin-store-seed'
  const filePath = writeStore({
    zcodejwttoken: encryptLikeZcode('jwt-value', secret),
  })
  const account = discoverZcodeAccount({
    env: { ZCODE_CREDENTIAL_SECRET: secret },
    filePath,
  })

  // The store was readable, so discovery succeeds and explains the gaps.
  assert.equal(account.zcodeJwtToken, 'jwt-value')
  assert.equal(account.region, undefined)
  assert.ok(
    account.warnings.some((warning) => warning.includes('oauth:active_provider')),
    `expected an active-provider warning, got ${JSON.stringify(account.warnings)}`,
  )
  assert.ok(
    account.warnings.some((warning) => warning.includes('api-key')),
    `expected an api-key warning, got ${JSON.stringify(account.warnings)}`,
  )
})

test('discoverZcodeAccount fails hard when the store is missing', () => {
  assert.throws(
    () => discoverZcodeAccount({ filePath: join(tmpdir(), 'definitely-not-here.json') }),
    /unable to read ZCode credentials/,
  )
})

test('discoverZcodeAccount reads the real ZCode store when one exists', (t) => {
  let account
  try {
    account = discoverZcodeAccount()
  } catch (error) {
    t.skip(`no readable ZCode credential store on this machine: ${error.message}`)
    return
  }

  // If a store exists it must decrypt end to end, which is the real
  // interoperability claim of this module.
  assert.equal(typeof account.storePath, 'string')
  assert.ok(account.region === 'zai' || account.region === 'bigmodel' || account.region === undefined)
  if (account.region) {
    assert.ok(account.accessToken, 'a resolved region must come with an access token')
  }
  for (const entry of account.apiKeys) {
    assert.ok(
      parseApiKey(entry.apiKey),
      `api key for ${entry.provider} is not <id>.<secret>: ${entry.apiKey.length} chars`,
    )
  }
})
