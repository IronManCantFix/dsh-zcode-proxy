/**
 * Host-entry contract tests.
 *
 * `index.js` is the only file the host actually loads, and until this test
 * existed nothing exercised it. That gap let a real defect ship: `apply`
 * probed `ctx.settings` while `inject` listed only `llm`, and cordis refuses
 * to *read* an undeclared service — so the plugin threw on every startup with
 *
 *     cannot get property "settings" without inject
 *
 * which the host reports as `required plugin did not activate` and which stops
 * DSH from booting at all. A probe is not a safe way to test for a service
 * under cordis: the read itself is the failure.
 *
 * These tests assert the declaration, not the host's behaviour, because the
 * declaration is what the host consumes.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ZcodeAdapter } from '../src/adapter.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The host entry, imported once for every test below. */
const entry = await import(join(ROOT, 'index.js'))

/** The client half, which the host loads into the page. */
const client = await import(join(ROOT, 'client.js'))

/**
 * Collect the context services a module body reads.
 *
 * Only `ctx.<name>` reads are considered: `effect`, `fiber`, `inject` and
 * friends are provided by cordis itself on every context and are not services
 * to declare.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function servicesRead(source) {
  const intrinsic = new Set(['effect', 'fiber', 'inject', 'get', 'set', 'scope', 'on'])
  const found = new Set()
  for (const match of source.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)) {
    if (!intrinsic.has(match[1])) {
      found.add(match[1])
    }
  }
  return found
}

test('the host entry declares llm, which registration requires', () => {
  assert.ok(Array.isArray(entry.inject), 'inject must be an array')
  assert.ok(entry.inject.includes('llm'), 'index.js registers an adapter and needs the llm service')
})

/**
 * The regression that motivated this file. `ctx.settings` is read in `apply`;
 * if `settings` is not declared, every startup fails.
 */
test('every service index.js reads is declared in inject', () => {
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const read = servicesRead(source)
  const declared = new Set(entry.inject)

  const undeclared = [...read].filter((service) => !declared.has(service)).sort()
  assert.deepEqual(
    undeclared,
    [],
    `index.js reads these services without declaring them in inject: ${undeclared.join(', ')}. ` +
      'cordis throws "cannot get property ... without inject" on the read, which fails plugin ' +
      'activation and stops the host from booting.',
  )
})

test('the host entry exposes the cordis plugin contract', () => {
  assert.equal(entry.name, 'llm-zcode-connect')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.PROVIDER_ID, 'zcode')
})

test('the client half declares the slots service its section registers into', () => {
  assert.equal(client.name, 'dsh-zcode-connect-client')
  assert.ok(Array.isArray(client.inject))
  assert.ok(client.inject.includes('slots'), 'client.js registers a settings section')

  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const undeclared = [...servicesRead(source)].filter((service) => !client.inject.includes(service))
  assert.deepEqual(undeclared, [], `client.js reads undeclared services: ${undeclared.join(', ')}`)
})

/**
 * `cordis.patch.yml` is what actually inserts the plugin into the tree, so its
 * id and module name have to agree with what the package exports. A mismatch
 * shows up as the plugin silently never loading.
 */
test('cordis.patch.yml points at this package and matches the plugin id', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  assert.match(patch, new RegExp(`id:\\s*${entry.name}\\b`), 'the loader id must equal the plugin name')
  assert.match(patch, new RegExp(`name:\\s*${pkg.name}\\b`), 'the loader name must equal the package name')
})

/**
 * The `files`-less package must still ship the three paths the host resolves:
 * the entry, the client bundle, and the patch.
 */
test('package.json exports every path the host loads', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  assert.equal(pkg.private, undefined, 'a private package cannot be installed from git')
  assert.equal(pkg.main, './index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-plugins'))
})

/**
 * The wrapper is the only place our adapter meets the host's base class, and it
 * shipped a startup crash: the host's `LlmAdapter` declares no constructor, so
 * `class Adapter extends Base {}` never ran `ZcodeAdapter`'s constructor and
 * `this.dependencies` stayed `undefined`. The host's first call then threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'providerName')
 *
 * out of `providerInfo`, which the harness reports as `dsh: fatal load failure`
 * and which stops DSH from booting (exit code 1). The base class is faked here
 * because the real one only resolves inside a DSH install — which is precisely
 * why nothing covered this path before.
 */
test('the host-class wrapper keeps the adapter instance state', () => {
  const Base = class {}
  const adapter = entry.wrapAdapter(ZcodeAdapter, Base, { providerName: 'ZCode Connect' })

  assert.ok(adapter instanceof Base, 'the host checks that the adapter is its own LlmAdapter')
  assert.deepEqual(adapter.providerInfo('zcode'), { id: 'zcode', name: 'ZCode Connect' })
})

/**
 * The fallback path is the one every test in this repository used to take, so
 * it must keep working when the host class cannot be imported.
 */
test('the wrapper falls back to the plain implementation without a base class', () => {
  const adapter = entry.wrapAdapter(ZcodeAdapter, undefined, { providerName: 'ZCode Connect' })

  assert.equal(adapter instanceof ZcodeAdapter, true)
  assert.deepEqual(adapter.providerInfo('zcode'), { id: 'zcode', name: 'ZCode Connect' })
})
