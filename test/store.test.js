/**
 * Unit tests for local credential storage.
 *
 * Run with: node --test test/*.test.js
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearCredential,
  decryptValue,
  describeCredential,
  encryptValue,
  loadCredential,
  resolveStoreSecret,
  saveCredential,
  storeDirectory,
  storePath,
} from '../src/store.js'

/**
 * @returns {string} a credential file path inside a fresh temp directory
 */
function tempStorePath() {
  return join(mkdtempSync(join(tmpdir(), 'zcode-proxy-store-')), 'credentials.json')
}

const SAMPLE = {
  provider: 'bigmodel',
  accessToken: 'access-token-value',
  jwt: 'jwt-value',
  savedAt: '2026-10-01T00:00:00.000Z',
}

test('resolveStoreSecret prefers the environment variable', () => {
  assert.equal(
    resolveStoreSecret({ ZCODE_PROXY_CREDENTIAL_SECRET: ' chosen ' }),
    'chosen',
  )
})

test('resolveStoreSecret falls back to a machine-derived string', () => {
  assert.match(resolveStoreSecret({}), /^zcode-proxy-fallback:[a-z]+:/)
})

test('store paths honour DSH_HOME', () => {
  const env = { DSH_HOME: '/tmp/dsh-home-for-test' }
  assert.equal(storeDirectory(env), '/tmp/dsh-home-for-test/zcode-proxy')
  assert.equal(storePath(env), '/tmp/dsh-home-for-test/zcode-proxy/credentials.json')
})

test('encryptValue round-trips and produces a v1 envelope', () => {
  const value = encryptValue('hello-world', 'seed')
  assert.match(value, /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(decryptValue(value, 'seed'), 'hello-world')
})

test('decryptValue passes through values that are not envelopes', () => {
  assert.equal(decryptValue('plain', 'seed'), 'plain')
})

test('decryptValue rejects the wrong secret', () => {
  const value = encryptValue('hello', 'right-seed')
  assert.throws(() => decryptValue(value, 'wrong-seed'), /wrong secret|corrupted/)
})

test('decryptValue rejects malformed envelopes', () => {
  assert.throws(() => decryptValue('enc:v1:only.two', 'seed'), /malformed/)
  assert.throws(() => decryptValue('enc:v1:AAAA.AAAA.AAAA', 'seed'), /malformed/)
})

test('saveCredential then loadCredential round-trips', () => {
  const path = tempStorePath()
  const env = { ZCODE_PROXY_CREDENTIAL_SECRET: 'unit-test-seed' }
  saveCredential(SAMPLE, { env, path })

  const loaded = loadCredential({ env, path })
  assert.deepEqual(loaded, SAMPLE)
})

test('the stored file never contains the plaintext token', () => {
  const path = tempStorePath()
  const env = { ZCODE_PROXY_CREDENTIAL_SECRET: 'unit-test-seed' }
  saveCredential(SAMPLE, { env, path })

  const raw = readFileSync(path, 'utf8')
  assert.equal(raw.includes('access-token-value'), false)
  assert.equal(raw.includes('jwt-value'), false)
})

test('the stored file is owner-only', () => {
  const path = tempStorePath()
  saveCredential(SAMPLE, { env: { ZCODE_PROXY_CREDENTIAL_SECRET: 's' }, path })
  const mode = statSync(path).mode & 0o777
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
})

test('loadCredential returns undefined when nothing is stored', () => {
  assert.equal(loadCredential({ path: tempStorePath() }), undefined)
})

test('loadCredential fails loudly with the wrong secret', () => {
  const path = tempStorePath()
  saveCredential(SAMPLE, { env: { ZCODE_PROXY_CREDENTIAL_SECRET: 'a' }, path })
  assert.throws(
    () => loadCredential({ env: { ZCODE_PROXY_CREDENTIAL_SECRET: 'b' }, path }),
    /wrong secret/,
  )
})

test('clearCredential removes the file and reports what it did', () => {
  const path = tempStorePath()
  const env = { ZCODE_PROXY_CREDENTIAL_SECRET: 's' }
  saveCredential(SAMPLE, { env, path })

  assert.equal(clearCredential({ path }), true)
  assert.equal(clearCredential({ path }), false)
})

test('describeCredential reports presence without leaking the secret', () => {
  const path = tempStorePath()
  const env = { ZCODE_PROXY_CREDENTIAL_SECRET: 's' }
  saveCredential(SAMPLE, { env, path })

  const described = describeCredential({ env, path })
  assert.equal(described.present, true)
  assert.equal(described.provider, 'bigmodel')
  assert.equal(described.hasJwt, true)
  assert.equal(JSON.stringify(described).includes('access-token-value'), false)
})

test('describeCredential reports absence cleanly', () => {
  const described = describeCredential({ path: tempStorePath() })
  assert.equal(described.present, false)
})
