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
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ZcodeAdapter } from '../src/adapter.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The host entry, imported once for every test below. */
const entry = await import(join(ROOT, 'index.js'))

/**
 * The client half as the browser actually receives it.
 *
 * `exports["./client"]` is NOT an ES module: the host serves those bytes to the
 * page as a plain script, so the file must register itself with
 * `window.__ModuleLoader__.load`. Importing it (as this test used to) hid that
 * contract completely — the file imported fine under Node while every real boot
 * failed with `Uncaught SyntaxError: Unexpected token 'export'`, which the host
 * reports as `dsh-zcode-connect: import failed` / `web boot: 1 entry did not
 * activate`. Running the bundle the way the page does is the whole point: a
 * bare ESM artifact throws here, at the same token the browser reports.
 *
 * `react` is the one require the host answers (through the factory), so this
 * stub records what was asked for instead of failing the load. A card that is
 * not a React component cannot be rendered by the host's slot registry, so the
 * stub deliberately returns something that is NOT a usable react: any component
 * that tries to call a hook is then loud rather than silently blank.
 *
 * @returns {{ name?: string, inject?: unknown, apply?: unknown, requires: string[] }}
 */
function loadClientBundle() {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const registered = []
  const requires = []
  const previous = globalThis.window
  globalThis.window = { ...previous, __ModuleLoader__: { load: (spec) => registered.push(spec) } }
  try {
    // `new Function` parses the file as a script, like the page does. A bare
    // `export` statement is a SyntaxError here rather than a silent pass.
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    globalThis.window = previous
  }

  assert.equal(registered.length, 1, 'the bundle must register exactly one module with __ModuleLoader__')
  const spec = registered[0]
  assert.equal(typeof spec.factory, 'function', 'the registered module must carry a factory')
  const exportsObject = spec.factory((id) => {
    requires.push(id)
    if (id === 'react') {
      // Enough of the react surface for module scope to evaluate; hooks are
      // intentionally absent so a render attempt fails here loudly.
      return { createElement: () => ({ type: 'stub', props: {} }) }
    }
    throw new Error(`the client bundle asked for an unexpected module: "${id}"`)
  })
  return { ...exportsObject, requires }
}

/** The client half, loaded the way the host loads it into the page. */
const client = loadClientBundle()

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
  assert.equal(entry.name, 'dsh-zcode-connect')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.PROVIDER_ID, 'zcode')
})

/**
 * The plugin name, the package name and the patch row id have to be the SAME
 * string.
 *
 * This is not cosmetic. The market matches an installed package against the
 * user's patch layer by exact package name or by the row id derived from it
 * (`market/lib/hot.js: patchLayerManages`). While this plugin called itself
 * `llm-zcode-connect`, neither matched, so the market hot-mounted a second
 * entry beside the bundle row on every boot — the collision surfaced as
 * `client-modules: ... resolves from multiple active Loader sources` and then
 * as `Unexpected token 'export'` in the page — and every reinstall needed a
 * hand-written marker row in the profile to suppress it. Keeping all three
 * equal is what makes the plugin installable with nothing but the install
 * command (the shape dsh-pocket-nas ships).
 */
test('the plugin name equals the package name and the patch row id', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch.replace(/^\s*#.*$/gm, ''))
  const rowName = /^\s*name:\s*(\S+)\s*$/m.exec(patch.replace(/^\s*#.*$/gm, ''))

  assert.ok(rowId !== null, 'cordis.patch.yml must insert a row with an id')
  assert.ok(rowName !== null, 'cordis.patch.yml must insert a row with a name')
  assert.equal(entry.name, pkg.name, 'the plugin name must equal the package name')
  assert.equal(rowId[1], pkg.name, 'the patch row id must equal the package name')
  assert.equal(rowName[1], pkg.name, 'the patch row name must equal the package name')
})

test('the client half declares the slots service its section registers into', () => {
  assert.equal(client.name, 'dsh-zcode-connect-client')
  assert.ok(Array.isArray(client.inject))
  assert.ok(client.inject.includes('slots'), 'the client registers a settings section')

  // Scanned against the SOURCE, not the generated bundle: the wrapper's own
  // `factory: (require) => ...` plumbing is not a service read, and only the
  // hand-written file is the one a human keeps in sync with `inject`.
  const source = readFileSync(join(ROOT, 'client', 'index.js'), 'utf8')
  const undeclared = [...servicesRead(source)].filter((service) => !client.inject.includes(service))
  assert.deepEqual(undeclared, [], `client/index.js reads undeclared services: ${undeclared.join(', ')}`)
})

/**
 * The generated bundle is what the page executes, so it has to be current.
 *
 * Checking only for the export names is not enough: a card whose body changed
 * without a rebuild keeps every name and still ships the OLD behaviour — a
 * renamed button, a dropped field — while the release workflow happily packs it
 * (`release.yml` ships the committed `client.js`, it does not rebuild). So the
 * bundle is regenerated here and compared byte for byte. This is the same
 * guarantee dsh-pocket-nas gets from running its build inside the release job;
 * this repository ships the artifact from git, so the check belongs in the test
 * suite that the release job does run.
 */
test('the committed client bundle is up to date with its source', async () => {
  const generated = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const source = readFileSync(join(ROOT, 'client', 'index.js'), 'utf8')

  assert.match(generated, /^\/\/ Generated by client\/build\.mjs/, 'client.js must be the generated artifact')
  assert.doesNotMatch(generated, /^export\s/m, 'the bundle must not contain bare ESM export statements')

  const buildPath = join(ROOT, 'client', 'build.mjs')
  const probe = join(tmpdir(), `dsh-zcode-client-${process.pid}-${Date.now()}.js`)
  try {
    // Build to a scratch path so the assertion cannot rewrite the file it is
    // checking: a check that repairs its own subject verifies nothing.
    execFileSync(process.execPath, [buildPath], { env: { ...process.env, DSH_ZCODE_CLIENT_OUT: probe } })
    assert.equal(
      readFileSync(probe, 'utf8'),
      generated,
      'client.js is stale: run `npm run build:client` and commit the result',
    )
  } finally {
    rmSync(probe, { force: true })
  }

  // A source that no longer exports what the host reads would still pass the
  // byte comparison if the bundle had been rebuilt, so the names the slot
  // registry consumes are asserted directly.
  for (const name of source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    assert.ok(
      generated.includes(`exports.${name[1]} = ${name[1]}`),
      `client.js is stale: it does not export ${name[1]}`,
    )
  }
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
/**
 * The card has to be a React component.
 *
 * `ctx.slots.register()` hands its second argument to the host's React renderer.
 * This file once built the card with `document.createElement` and returned the
 * detached node: it loaded cleanly, registered cleanly, produced no error in any
 * log, and rendered a completely blank settings pane — the failure had no
 * symptom to grep for. Returning a React element is the contract, so it is
 * asserted directly, along with the fact that `react` reaches the card through
 * the factory rather than a global (a page has no global React; see the note in
 * dsh-pocket-nas' build about react never being a global).
 */
test('the client card is a React component, not a DOM builder', () => {
  assert.ok(
    client.requires.includes('react'),
    "the card must obtain react through the factory: require('react')",
  )
  assert.equal(typeof client.ZcodeCard, 'function', 'the slot registry needs a component function')

  const calls = []
  const React = {
    createElement: (type, props, ...children) => {
      calls.push({ type, props, children })
      return { $$typeof: Symbol.for('react.element'), type, props, children }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
  }

  // Re-run the factory with a react whose API the component actually uses, so
  // calling the component exercises its real render path.
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const registered = []
  const previousWindow = globalThis.window
  // A DOM global must NOT be required: the card is rendered by React, and a
  // component that reaches for `document` during render would break under the
  // host's renderer. Its absence here is part of the assertion.
  globalThis.window = { ...previousWindow, __ModuleLoader__: { load: (spec) => registered.push(spec) } }
  const previousDocument = globalThis.document
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
    delete globalThis.document
    const exportsObject = registered[0].factory((id) => (id === 'react' ? React : undefined))
    const rendered = exportsObject.ZcodeCard({})

    assert.ok(rendered !== null && typeof rendered === 'object', 'the card must return a React element')
    assert.equal(rendered.$$typeof, Symbol.for('react.element'), 'the card must return a React element')
    assert.ok(calls.length > 0, 'the card must build its tree with react.createElement')
    // The DOM-builder version returned a detached node whose methods gave it
    // away; a React element never carries them.
    assert.equal(typeof rendered.replaceChildren, 'undefined', 'the card must not return a DOM node')
    assert.equal(typeof rendered.append, 'undefined', 'the card must not return a DOM node')
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
})

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

/**
 * Discovered models must carry the provider they belong to.
 *
 * `LlmService.listModels` validates every entry the adapter returns and throws
 *
 *     LlmError(`adapter returned invalid or duplicate model metadata for
 *              provider "${provider}"`, 'INVALID_CATALOG')
 *
 * unless `model.provider === provider`, plus a non-empty `id` and `name` and a
 * unique `id`. The settings surface renders that verbatim, which is how a
 * missing field here reached the user as
 *
 *     ZCode 加载失败: adapter returned invalid or duplicate model metadata
 *
 * on the model picker. The metadata builder is asserted directly because the
 * failure is a shape contract with the host, not a behaviour of this plugin.
 */
test('discovered models carry provider, id and name in the host-validated shape', () => {
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const build = source.slice(source.indexOf('function toHostModel'))
  const body = build.slice(0, build.indexOf('\n}') + 2)

  assert.match(
    body,
    /provider:\s*PROVIDER_ID/,
    "toHostModel must set `provider` to PROVIDER_ID: the host compares it against the " +
      'provider route and throws INVALID_CATALOG ("invalid or duplicate model metadata") otherwise.',
  )

  // Exercise the real builder through the module's own discovery surface so the
  // assertion is about the returned objects, not just the source text.
  const model = entry.toHostModelForTest('GLM-5.3-Flash')
  assert.equal(model.provider, 'zcode', 'every discovered model must name the registering provider')
  assert.equal(typeof model.id, 'string')
  assert.ok(model.id.length > 0, 'the host rejects an empty id')
  assert.equal(typeof model.name, 'string')
  assert.ok(model.name.length > 0, 'the host rejects an empty name')
})

/**
 * `/login` must not answer before the credential is readable.
 *
 * The card's sign-in handler awaits the login route and then immediately
 * re-reads `/status`. The route used to return as soon as the authorize URL was
 * known and finish the exchange in a detached promise, so that re-read raced
 * the credential write and always lost: the pane kept showing "not signed in"
 * until the user pressed Refresh by hand. The handler now awaits the exchange,
 * which is the ordering this test pins.
 */
test('the login route resolves only after the credential is written', async () => {
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const handlerStart = source.indexOf('path: ROUTES.login')
  const handler = source.slice(handlerStart)
  // Everything up to the close of the login handler: the assertions below need
  // both the tracked chain and the response that follows it.
  const body = handler.slice(0, handler.indexOf('\n        }),'))

  // The login promise must be retained, so its settlement can be awaited...
  assert.match(
    body,
    /const settled = login\(/,
    'the login promise must be captured so the handler can await its settlement.',
  )
  // ...the credential write must happen inside that tracked chain...
  assert.match(
    body,
    /\.then\(\(result\) => \{[\s\S]*?saveCredential\(/,
    'the credential must be saved inside the tracked login chain, not a detached callback.',
  )
  // ...and the response must be sent only after awaiting it.
  assert.match(
    body,
    /await settled[\s\S]*?json\(res, 200/,
    'the handler must await the settled login BEFORE responding, or the card\'s post-login ' +
      'status re-read races the credential write and shows a stale "not signed in".',
  )
})
