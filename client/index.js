/**
 * Settings card for ZCode Connect.
 *
 * Loaded by the host through `dsh.client`; `package.json` points `exports["./client"]`
 * at the generated `client.js`, which registers itself with
 * `window.__ModuleLoader__.load({...})` and exposes `exports.apply` /
 * `exports.inject` — the same contract the bundled market-installer card uses.
 * See `client/build.mjs` for why the wrapper exists.
 *
 * The card is a REACT component, not a DOM builder. `ctx.slots.register()` hands
 * its second argument to the host's React renderer, so anything that is not a
 * React element renders as nothing: this file used to build the card with
 * `document.createElement` and return the detached node, which produced a
 * completely blank settings pane with no error anywhere in the log. Every
 * comparable plugin (dshmarket, dsh-pocket-nas, dsh-mimo-connect) returns React
 * elements, and `react` arrives through the factory's `require` — it is never a
 * global and is not a dependency of this package.
 *
 * Styling stays inline on purpose: the host exposes no styling API to client
 * plugins, and inline styles keep the card independent of host CSS internals.
 * Data comes from the plugin's own same-origin routes, and mutations go through
 * those routes as well, which keeps the browser half free of credential
 * handling.
 */

/** Injected by the host's client module system; the build wraps this file. */
const { createElement: h, useCallback, useEffect, useRef, useState } = require('react')

const ROUTES = {
  status: '/plugins/dsh-zcode-connect/status',
  login: '/plugins/dsh-zcode-connect/login',
  logout: '/plugins/dsh-zcode-connect/logout',
}

export const name = 'dsh-zcode-connect-client'
export const inject = ['slots', 'locale']

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 */
async function call(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    credentials: 'same-origin',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { error: text.slice(0, 200) }
  }
  if (!response.ok) {
    throw new Error(parsed?.error ?? `request failed: HTTP ${response.status}`)
  }
  return parsed
}

const STYLES = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    padding: '4px 0',
    font: 'inherit',
    color: 'inherit',
  },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  heading: { fontSize: '13px', fontWeight: '600', opacity: '0.75', margin: '0' },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '12px',
    fontSize: '13px',
  },
  label: { opacity: '0.7' },
  value: { fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
  bar: {
    position: 'relative',
    height: '6px',
    borderRadius: '3px',
    background: 'color-mix(in srgb, currentColor 14%, transparent)',
    overflow: 'hidden',
  },
  barFill: { position: 'absolute', inset: '0 auto 0 0', background: 'currentColor', opacity: '0.55' },
  note: { fontSize: '12px', lineHeight: '1.5', opacity: '0.7', margin: '0' },
  warning: { fontSize: '12px', lineHeight: '1.5', color: '#d97706', margin: '0' },
  error: { fontSize: '12px', lineHeight: '1.5', color: '#dc2626', margin: '0', whiteSpace: 'pre-wrap' },
  button: {
    appearance: 'none',
    border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '6px',
    padding: '5px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  buttons: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  link: { fontSize: '12px', wordBreak: 'break-all', opacity: '0.85' },
}

/**
 * One label/value line. Returns `null` for an absent value so callers can list
 * conditionals inline, the way the DOM version skipped undefined children.
 *
 * @param {string} label
 * @param {unknown} value
 * @returns {unknown}
 */
function row(label, value) {
  if (value === undefined || value === null || value === false) {
    return null
  }
  return h(
    'div',
    { style: STYLES.row },
    h('span', { style: STYLES.label }, label),
    h('span', { style: STYLES.value }, String(value)),
  )
}

/**
 * @param {number} percent
 */
function bar(percent) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return h(
    'div',
    { style: STYLES.bar },
    h('div', { style: { ...STYLES.barFill, width: `${clamped}%` } }),
  )
}

/**
 * @param {number | undefined} seconds
 */
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return undefined
  }
  return new Date(seconds * 1000).toLocaleString()
}

/**
 * A titled block. Children are listed inline as an array (some entries are
 * conditionally `null`), so React needs a key on every one of them; rather than
 * make each caller invent one, anything still missing a key gets its position,
 * which is stable for a card whose rows never reorder within a render.
 *
 * @param {{ children?: unknown, style?: object }} props
 */
function Section({ children, style }) {
  const list = children === undefined || children === null ? [] : Array.isArray(children) ? children : [children]
  const keyed = list.map((child, index) =>
    child !== null && typeof child === 'object' && child.key === undefined && child.type !== undefined
      ? { ...child, key: `row-${index}` }
      : child,
  )
  return h('div', { style: { ...STYLES.section, ...style } }, keyed)
}

/**
 * The card component.
 *
 * @param {{ t?: (key: string) => string }} props
 */
export function ZcodeCard() {
  const [status, setStatus] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loginUrl, setLoginUrl] = useState(undefined)

  /**
   * One request in flight at a time; the previous one is aborted so a fast
   * double click cannot land a stale answer after a newer one.
   */
  const inFlight = useRef(undefined)

  const refresh = useCallback(async () => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    setError(undefined)
    try {
      setStatus(await call(ROUTES.status, { signal: controller.signal }))
    } catch (caught) {
      if (caught?.name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      // A newer request owns the spinner now; leave its state alone.
      if (inFlight.current === controller) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    refresh()
    return () => inFlight.current?.abort()
  }, [refresh])

  /** Run one mutation, then re-read the status the card renders from. */
  const run = useCallback(
    async (task) => {
      setBusy(true)
      setError(undefined)
      try {
        await task()
        await refresh()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const signIn = (provider) =>
    run(async () => {
      const result = await call(ROUTES.login, { method: 'POST', body: { provider } })
      setLoginUrl(result.authorizeUrl)
      window.open(result.authorizeUrl, '_blank', 'noopener')
    })

  const signOut = () => run(() => call(ROUTES.logout, { method: 'POST' }))

  if (loading) {
    return h('div', { style: STYLES.card }, h('p', { style: STYLES.note }, 'Loading…'))
  }

  if (error) {
    return h(
      'div',
      { style: STYLES.card },
      h('p', { style: STYLES.error }, error),
      h(
        'div',
        { style: STYLES.buttons },
        h('button', { type: 'button', style: STYLES.button, onClick: refresh }, 'Retry'),
      ),
    )
  }

  const view = status ?? {}
  const credential = view.credential ?? {}
  const identity = view.identity ?? {}
  const quota = view.quota

  return h(
    'div',
    { style: STYLES.card },

    // Account
    Section({
      children: [
        h('h4', { key: 'heading', style: STYLES.heading }, 'Account'),
        row('status', credential.present ? `signed in (${credential.provider})` : 'not signed in'),
        row('plan token', credential.present && credential.hasJwt ? 'present' : undefined),
        row('signed in at', credential.savedAt ? new Date(credential.savedAt).toLocaleString() : undefined),
        row('stored at', credential.path),
      ],
    }),

    // Identity prompt provenance — surfaced because a stale snapshot is the
    // single most likely cause of a provider that suddenly stops working.
    Section({
      children: [
        h('h4', { key: 'heading', style: STYLES.heading }, 'Identity prompt'),
        row('size', `${identity.chars ?? 0} characters`),
        row('healthy', identity.healthy ? 'yes' : 'no'),
        identity.healthy
          ? null
          : h(
              'p',
              { key: 'warning', style: STYLES.warning },
              identity.warning ?? identity.error ?? 'unknown',
            ),
      ],
    }),

    // Quota — absent when the upstream account endpoint is unreachable.
    quota
      ? Section({
          children: [
            h('h4', { key: 'heading', style: STYLES.heading }, 'Quota'),
            quota.error
              ? h('p', { key: 'error', style: STYLES.error }, quota.error)
              : !quota.buckets || quota.buckets.length === 0
                ? h('p', { key: 'empty', style: STYLES.note }, 'No quota buckets reported by upstream.')
                : quota.buckets.map((bucket, index) =>
                    Section({
                      key: `bucket-${index}`,
                      children: [
                        row(bucket.label, `${bucket.remainingText} / ${bucket.totalText} (${bucket.percent}%)`),
                        bar(bucket.percent),
                        h(
                          'p',
                          { key: 'plan', style: STYLES.note },
                          `${bucket.planName}${bucket.periodEnd ? ` · resets ${formatTime(bucket.periodEnd)}` : ''}`,
                        ),
                      ],
                    }),
                  ),
          ],
        })
      : null,

    // Sign in / out
    h(
      'div',
      { key: 'buttons', style: STYLES.buttons },
      credential.present
        ? h('button', { type: 'button', style: STYLES.button, disabled: busy, onClick: signOut }, 'Sign out')
        : (view.providers ?? ['bigmodel', 'zai']).map((provider) =>
            h(
              'button',
              { key: provider, type: 'button', style: STYLES.button, disabled: busy, onClick: () => signIn(provider) },
              `Sign in (${provider})`,
            ),
          ),
      h('button', { key: 'refresh', type: 'button', style: STYLES.button, disabled: busy, onClick: refresh }, 'Refresh'),
    ),

    loginUrl
      ? Section({
          key: 'login',
          children: [
            h('p', { key: 'note', style: STYLES.note }, 'Finish the authorization in the tab that just opened:'),
            h('a', { key: 'link', style: STYLES.link, href: loginUrl, target: '_blank', rel: 'noopener' }, loginUrl),
          ],
        })
      : null,

    credential.present && !credential.hasJwt
      ? h(
          'p',
          { key: 'no-jwt', style: STYLES.warning },
          'This login has no plan token, so plan-backed models are unavailable. Sign in again with a ' +
            'coding-plan subscription.',
        )
      : null,
  )
}

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'zcode-connect',
        order: 441,
        label: () => 'ZCode',
        inject: () => ({}),
      },
      ZcodeCard,
    ),
  )
}
