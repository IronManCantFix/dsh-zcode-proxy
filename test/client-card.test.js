/**
 * Behavioural tests for the settings card's request state machine.
 *
 * Why these exist
 * ---------------
 * Every previous test of the card's login behaviour matched regular expressions
 * against `index.js`'s *source text*. That pins what the server file looks like
 * and proves nothing about what the card does, so a real freeze shipped
 * undetected:
 *
 *   Pressing 登录 started a request the server held open for the whole browser
 *   authorization (up to ten minutes). The card's refresh aborts the request it
 *   owns, so pressing 刷新 while authorizing killed the login request and left
 *   `loading` or `busy` stuck — the pane sat on 加载中… with every button
 *   `disabled`, and the credential was on disk the whole time.
 *
 * A source-text assertion cannot see any of that. These tests load the actual
 * committed bundle, render the real component against a minimal React with
 * working hooks, and drive the real `fetch` surface, so the assertions are
 * about observable component state rather than about the shape of the file.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A minimal React good enough to render the card and run its effects.
 *
 * The card uses `createElement`, `useState`, `useRef`, `useCallback` and
 * `useEffect`. Hooks are stored per component instance by position, which is
 * exactly the contract the real implementation follows, so the component's own
 * logic is exercised unmodified rather than reimplemented here.
 *
 * State updates are applied synchronously and the tree is re-rendered, which
 * makes assertions deterministic without an act() wrapper.
 *
 * @param {string} mountPath Route prefix the card's fetch calls are served from.
 * @param {(request: {path: string, method: string, body: any}) => Promise<any>} handler
 * @returns {{ card: Function, render: () => any, texts: () => string[], buttons: () => any[], setFetch: Function }}
 */
function harness(handler, options = {}) {
  /**
   * What `window.open` does during this test.
   *
   * Tests can make it throw or return null to model a popup blocker, which is
   * the case the card must survive: the authorize URL is also rendered as a
   * link, so failing to open a tab must not fail the sign-in.
   */
  const openImpl = options.open ?? (() => undefined)
  /** Requests the card made, in order. */
  const requests = []
  /** Aborts observed on any request's signal. */
  const aborts = []
  /** Hook storage for the single component instance this harness mounts. */
  let hooks = []
  let hookIndex = 0
  /** Cleanups registered by effects, released on unmount. */
  const cleanups = []
  /** Set by any state setter so the render loop knows to run another pass. */
  let dirty = false
  /** Set when a mount effect ran, so `settle` keeps going until they have. */
  let effectsRan = false
  /** The element being rendered, so re-renders can repeat the whole tree. */
  let rootElement

  /** Drain microtasks, re-rendering until the tree stops changing. */
  const settle = async () => {
    for (let pass = 0; pass < 80; pass += 1) {
      // Let queued promise continuations (the fetch chain) run first, then
      // re-render so any state they set is reflected.
      await new Promise((resolve) => setImmediate(resolve))
      dirty = false
      effectsRan = false
      rootElement = rerender()
      if (!dirty && !effectsRan) {
        return rootElement
      }
    }
    return rootElement
  }

  const react = {
    createElement: (type, props, ...children) => {
      const flat = children.flat(Infinity).filter((child) => child !== undefined && child !== null)
      const childProps = flat.length === 1 ? flat[0] : flat.length === 0 ? undefined : flat
      return { type, props: { ...(props ?? {}), ...(childProps === undefined ? {} : { children: childProps }) } }
    },
    useState: (initial) => {
      const index = hookIndex++
      if (hooks.length <= index) {
        hooks[index] = { value: initial }
      }
      const slot = hooks[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          dirty = true
        }
      }
      return [slot.value, set]
    },
    useRef: (initial) => {
      const index = hookIndex++
      if (hooks.length <= index) {
        hooks[index] = { current: initial }
      }
      return hooks[index]
    },
    useCallback: (fn) => {
      hookIndex++
      return fn
    },
    useEffect: (fn) => {
      const index = hookIndex++
      // Like real React with a stable dep list: run once on mount, never again.
      // Re-running on every pass would restart `refresh()`, which is both wrong
      // and an infinite loop in a synchronous harness.
      if (hooks.length <= index) {
        hooks[index] = { mounted: true }
        effectsRan = true
        const cleanup = fn()
        if (typeof cleanup === 'function') {
          cleanups.push(cleanup)
        }
      }
    },
  }

  /**
   * Expand one element into a plain tree, invoking function components.
   *
   * @param {any} node
   * @returns {any}
   */
  const expand = (node) => {
    if (node === null || typeof node !== 'object') {
      return node
    }
    if (Array.isArray(node)) {
      return node.map(expand)
    }
    if (node.type === undefined) {
      return node
    }
    if (typeof node.type === 'function') {
      hookIndex = 0
      return expand(node.type(node.props ?? {}))
    }
    const props = { ...(node.props ?? {}) }
    if (props.children !== undefined) {
      props.children = expand(props.children)
    }
    return { ...node, props }
  }

  /**
   * Run one render pass with hooks reset, keeping stored values.
   *
   * @returns {any}
   */
  const rerender = () => {
    hookIndex = 0
    return expand(rootElementSpec)
  }

  /** The element passed to `mount`, re-expanded on each render. */
  let rootElementSpec
  /** Globals to put back when the harness is done with. */
  let previousFetchRef
  let previousWindowRef

  return {
    react,
    settle,
    requests,
    aborts,
    cleanups,
    /**
     * Mount an element, wire `fetch`, and resolve the card's initial load.
     *
     * @param {any} element
     * @returns {Promise<any>} the rendered tree
     */
    async mount(element) {
      rootElementSpec = element
      const previousFetch = globalThis.fetch
      const previousWindow = globalThis.window
      previousFetchRef = previousFetch
      previousWindowRef = previousWindow
      globalThis.window = {
        ...previousWindow,
        open: openImpl,
        __ModuleLoader__: previousWindow?.__ModuleLoader__,
      }
      // Left installed for the lifetime of the harness: the card fetches again
      // on later clicks (sign-in, refresh, the login poll), so restoring this
      // when `mount` returned would make every post-mount interaction fail.
      globalThis.fetch = async (path, options = {}) => {
        const request = { path, method: options.method ?? 'GET', body: options.body }
        requests.push(request)
        // Record aborts attributable to this request, so a test can assert that
        // one card action cancelled another's in-flight request.
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            aborts.push({ path, reason: options.signal.reason })
          })
        }
        if (options.signal?.aborted) {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        const result = await handler(request)
        if (options.signal?.aborted) {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        return {
          ok: result.ok ?? true,
          status: result.status ?? 200,
          text: async () => JSON.stringify(result.body ?? {}),
        }
      }
      hooks = []
      hookIndex = 0
      rootElement = rerender()
      await settle()
      return { get tree() { return rootElement } }
    },
    /**
     * Release the globals this harness installed. Tests that mount several
     * cards in one process must call this between mounts.
     */
    restore() {
      globalThis.fetch = previousFetchRef
      globalThis.window = previousWindowRef
    },
    unmount() {
      for (const cleanup of cleanups) {
        cleanup()
      }
    },
  }
}

/**
 * Flatten a rendered tree into the text it would display.
 *
 * @param {any} node
 * @returns {string[]}
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectText(child, out)
    }
    return out
  }
  collectText(node.props?.children, out)
  return out
}

/**
 * Every `button` element in a rendered tree.
 *
 * @param {any} node
 * @param {any[]} out
 * @returns {any[]}
 */
function collectButtons(node, out = []) {
  if (node === null || typeof node !== 'object') {
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectButtons(child, out)
    }
    return out
  }
  if (node.type === 'button') {
    out.push(node)
  }
  collectButtons(node.props?.children, out)
  return out
}

function loadCard(react) {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const registered = []
  const previous = globalThis.window
  globalThis.window = { ...previous, __ModuleLoader__: { load: (spec) => registered.push(spec) } }
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    globalThis.window = previous
  }
  const exportsObject = registered[0].factory((id) => {
    if (id === 'react') {
      return react
    }
    throw new Error(`unexpected require: ${id}`)
  })
  return exportsObject.ZcodeCard
}

const SIGNED_OUT = {
  credential: { present: false },
  identity: { healthy: true, chars: 10 },
  providers: ['bigmodel', 'zai'],
}

/**
 * The exact freeze this suite exists for.
 *
 * Reproduces the shipped failure rather than asserting a happy path.
 *
 * The cause was a contract mismatch between the two halves of the plugin.
 * `/login` awaited the whole browser authorization, so the request stayed open
 * for up to ten minutes; the card's sign-in handler awaited that request. The
 * card's Refresh aborts the request it owns, so pressing 刷新 during
 * authorization killed the login request, the awaited task rejected, the
 * post-login `refresh()` never ran, and the card was left with `loading` true
 * and every button `disabled` — a frozen pane, with the credential already on
 * disk.
 *
 * Both halves are therefore pinned here: the route must answer with the
 * authorize URL without waiting for the exchange (asserted in
 * `host-entry.test.js`), and the card must not depend on the login request
 * outliving the authorization. This test drives the card with the route's real
 * contract — it answers immediately — and then requires that a Refresh during
 * the outstanding authorization neither aborts anything nor strands the pane.
 */
test('sign-in resolves promptly and Refresh keeps working while authorizing', async () => {
  /** Flips to signed-in once the test decides the "authorization" finished. */
  let exchangeState = 'pending'

  const h = harness(async (request) => {
    if (request.path.endsWith('/login')) {
      // The real route's contract: the authorize URL comes back at once and the
      // exchange continues detached, observed through `/status`.
      return { body: { authorizeUrl: 'https://example.test/auth', provider: 'bigmodel', pending: true } }
    }
    if (request.path.endsWith('/status')) {
      if (exchangeState === 'pending') {
        return { body: { ...SIGNED_OUT, login: { state: 'pending' } } }
      }
      return {
        body: {
          credential: { present: true, provider: 'bigmodel', hasJwt: true, path: '/tmp/x', savedAt: 'now' },
          identity: { healthy: true, chars: 10 },
          providers: ['bigmodel', 'zai'],
          login: { state: 'signed-in', provider: 'bigmodel' },
        },
      }
    }
    return { body: {} }
  })
  const Card = loadCard(h.react)
  const view = await h.mount(h.react.createElement(Card, { locale: 'en' }))

  const signIn = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Sign in'))
  assert.ok(signIn, 'the card must offer a sign-in button while signed out')

  // Sign-in must settle without waiting for the exchange to finish.
  const outcome = await Promise.race([
    signIn.props.onClick().then(() => 'returned'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
  ])
  assert.equal(
    outcome,
    'returned',
    'sign-in must resolve as soon as the authorize URL is known; depending on the login ' +
      'request outliving the authorization is what let a Refresh abort it and freeze the pane.',
  )

  await h.settle()

  // Nothing long-lived may be held: the abort surface must be free again, so a
  // Refresh cannot kill an in-flight authorization.
  const buttons = collectButtons(view.tree)
  const disabled = buttons.filter((button) => button.props.disabled === true)
  assert.equal(
    disabled.length,
    0,
    'no button may stay disabled while the authorization is pending: Refresh is the user\'s ' +
      'only recovery, and a disabled one is a frozen pane.',
  )

  // The recovery path itself, mid-authorization.
  const refresh = buttons.find((button) => collectText(button).join('').includes('Refresh'))
  assert.ok(refresh, 'Refresh must remain available while a login is pending')
  await refresh.props.onClick()
  await h.settle()

  assert.ok(
    !collectText(view.tree).some((text) => text.includes('Loading')),
    'a Refresh during authorization must not leave the card on its loading state',
  )

  // And the authorization still lands: the card keeps following it and shows
  // the signed-in state once the detached exchange completes.
  exchangeState = 'signed-in'
  await new Promise((resolve) => setTimeout(resolve, 2200))
  await h.settle()

  assert.ok(
    collectText(view.tree).join(' | ').includes('signed in'),
    'the card must still observe the authorization completing after a mid-login Refresh',
  )

  h.unmount()
  h.restore()
})

/**
 * The card must not hold a login request open, and Refresh must not cancel one.
 *
 * Second half of the freeze, and the half the server fix does not cover on its
 * own. `run` used to do `await task(); await refresh()`. Because the login task
 * resolved only after the exchange, that `refresh()` was deferred for the whole
 * authorization — and it was the card's own `refresh` that aborted the request
 * it owned. So the recovery action destroyed the very request the card was
 * waiting on, and the deferred refresh never ran: `loading` stayed true, or
 * `busy` stayed true, and every button stayed disabled.
 *
 * Aborting a superseded *status* request is correct and expected — that is how
 * a fast double click avoids a stale answer landing out of order. What must
 * never happen is a Refresh cancelling a `/login` request, so the assertion is
 * scoped to login rather than to aborts in general.
 */
test('a Refresh never aborts a login request', async () => {
  // Guards the client half of the contract: the card must not keep a login
  // request alive past sign-in. Whether the *server* holds it open is checked
  // in host-entry.test.js, where the route's shape is actually observable —
  // this test only fails if the card starts depending on a long-lived request,
  // which is the condition that made a Refresh destructive.
  const h = harness(async (request) => {
    if (request.path.endsWith('/login')) {
      return { body: { authorizeUrl: 'https://example.test/auth', provider: 'bigmodel', pending: true } }
    }
    if (request.path.endsWith('/status')) {
      return { body: { ...SIGNED_OUT, login: { state: 'pending' } } }
    }
    return { body: {} }
  })
  const Card = loadCard(h.react)
  const view = await h.mount(h.react.createElement(Card, { locale: 'en' }))

  const signIn = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Sign in'))
  await signIn.props.onClick()
  await h.settle()

  const loginRequests = h.requests.filter((request) => request.path.endsWith('/login'))
  assert.equal(loginRequests.length, 1, 'sign-in must issue exactly one login request')

  const refresh = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Refresh'))
  await refresh.props.onClick()
  await h.settle()

  const loginAborts = h.aborts.filter((entry) => entry.path.endsWith('/login'))
  assert.deepEqual(
    loginAborts,
    [],
    'a Refresh must never abort a login request: when it did, the awaited sign-in task rejected ' +
      'and the card was left frozen with the credential already written.',
  )
  h.unmount()
  h.restore()
})

test('pressing refresh cannot strand the card while a login is pending', async () => {
  const h = harness(async (request) => {
    if (request.path.endsWith('/status')) {
      return { body: SIGNED_OUT }
    }
    if (request.path.endsWith('/login')) {
      // The server answers as soon as the authorize URL is known; the exchange
      // continues outside this request.
      return { body: { authorizeUrl: 'https://example.test/auth', provider: 'bigmodel', pending: true } }
    }
    return { body: {} }
  })
  const Card = loadCard(h.react)
  const view = await h.mount(h.react.createElement(Card, { locale: 'en' }))

  const signIn = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Sign in'))
  assert.ok(signIn, 'the card must offer a sign-in button while signed out')

  await signIn.props.onClick()
  await h.settle()

  const buttons = collectButtons(view.tree)
  assert.ok(buttons.length > 0, 'the card must still render buttons after signing in')
  const stuck = buttons.filter((button) => button.props.disabled === true)
  assert.equal(
    stuck.length,
    0,
    'no button may remain disabled after sign-in returns: a permanently disabled Refresh is ' +
      'indistinguishable from a frozen pane, which is the bug being fixed here.',
  )

  // The regression proper: a refresh while the login is still pending must not
  // abort anything or leave the spinner up.
  const refresh = buttons.find((button) => collectText(button).join('').includes('Refresh'))
  assert.ok(refresh, 'the Refresh button must be present and enabled')
  await refresh.props.onClick()
  await h.settle()

  const afterTexts = collectText(view.tree)
  assert.ok(
    !afterTexts.some((text) => text.includes('Loading')),
    'the card must not be stuck on its loading state after a refresh',
  )
  h.unmount()
})

test('the card polls status and surfaces a successful login', async () => {
  /** Flips to signed-in once the poll has seen at least one pending status. */
  let statusCalls = 0
  const h = harness(async (request) => {
    if (request.path.endsWith('/login')) {
      return { body: { authorizeUrl: 'https://example.test/auth', provider: 'bigmodel', pending: true } }
    }
    if (request.path.endsWith('/status')) {
      statusCalls += 1
      // First call is the mount read; the exchange then settles server-side.
      return {
        body:
          statusCalls <= 1
            ? { ...SIGNED_OUT, login: { state: 'pending' } }
            : {
                credential: { present: true, provider: 'bigmodel', hasJwt: true, path: '/tmp/x', savedAt: 'now' },
                identity: { healthy: true, chars: 10 },
                providers: ['bigmodel', 'zai'],
                login: { state: 'signed-in', provider: 'bigmodel' },
              },
      }
    }
    return { body: {} }
  })
  const Card = loadCard(h.react)
  const view = await h.mount(h.react.createElement(Card, { locale: 'en' }))

  const signIn = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Sign in'))
  await signIn.props.onClick()

  // Drive the poller's 2s interval without waiting in real time.
  for (let pass = 0; pass < 5; pass += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  await new Promise((resolve) => setTimeout(resolve, 2200))
  await h.settle()

  const texts = collectText(view.tree).join(' | ')
  assert.ok(
    texts.includes('signed in'),
    `the card must show the signed-in state once the poll observes it; got: ${texts}`,
  )
  h.unmount()
})

/**
 * A blocked popup must not turn a workable sign-in into a failure.
 *
 * `window.open` is the one call in the sign-in path that depends on the
 * browser: a popup blocker can make it throw, and Safari-style handlers return
 * null. It used to be called unguarded, so that rejection ran straight into
 * `run`'s catch and replaced the whole card with its error view — even though
 * the authorize URL is rendered as a clickable link and the user could still
 * finish signing in. The reported symptom ("点登录就报错") would then be
 * indistinguishable from a real authorization failure.
 *
 * Two blocker shapes are covered: a throw and a null return.
 */
for (const [label, open] of [
  ['throws', () => { throw new Error('popup blocked') }],
  ['returns null', () => null],
]) {
  test(`a sign-in whose popup is blocked (${label}) still shows the authorize link`, async () => {
    const h = harness(
      async (request) => {
        if (request.path.endsWith('/login')) {
          return { body: { authorizeUrl: 'https://example.test/auth', provider: 'bigmodel', pending: true } }
        }
        return { body: { ...SIGNED_OUT, login: { state: 'pending' } } }
      },
      { open },
    )
    const Card = loadCard(h.react)
    const view = await h.mount(h.react.createElement(Card, { locale: 'en' }))

    const signIn = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Sign in'))
    await signIn.props.onClick()
    await h.settle()

    const texts = collectText(view.tree).join(' | ')
    assert.ok(
      !texts.includes('popup blocked'),
      'a blocked popup must not surface as the card\'s error state',
    )
    assert.ok(
      texts.includes('https://example.test/auth'),
      'the authorize URL must still be offered as a link the user can open by hand',
    )
    h.unmount()
    h.restore()
  })
}

test('an aborted login does not report a spurious failure', async () => {
  const h = harness(async (request) => {
    if (request.path.endsWith('/login')) {
      return { body: { authorizeUrl: 'https://example.test/auth', provider: 'bigmodel', pending: true } }
    }
    if (request.path.endsWith('/status')) {
      // A superseded attempt goes idle rather than failed.
      return { body: { ...SIGNED_OUT, login: { state: 'idle' } } }
    }
    return { body: {} }
  })
  const Card = loadCard(h.react)
  const view = await h.mount(h.react.createElement(Card, { locale: 'en' }))

  const signIn = collectButtons(view.tree).find((button) => collectText(button).join('').includes('Sign in'))
  await signIn.props.onClick()
  await h.settle()

  const texts = collectText(view.tree).join(' | ')
  assert.ok(
    !texts.includes('Sign-in failed'),
    'a superseded login is not a user-visible failure and must not surface as one',
  )
  h.unmount()
})
