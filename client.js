/**
 * Settings card for ZCode Connect.
 *
 * Loaded by the host through `dsh.client`; `package.json` points `exports["./client"]`
 * here. The host wraps this module in `window.__ModuleLoader__.load({...})`, and
 * reads `exports.apply` / `exports.inject` from the factory result — the same
 * contract the bundled market-installer card uses.
 *
 * The card is intentionally dependency-light: it renders with plain elements so
 * it cannot break when host UI internals move. Data comes from the plugin's own
 * same-origin routes, and mutations go through those routes as well, which keeps
 * the browser half free of credential handling.
 */

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

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {...unknown} children
 */
function element(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) {
      continue
    }
    if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value)
    } else if (key === 'class') {
      node.className = String(value)
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) {
      continue
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
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
 * @param {string} label
 * @param {unknown} value
 */
function row(label, value) {
  return element(
    'div',
    { style: STYLES.row },
    element('span', { style: STYLES.label }, label),
    element('span', { style: STYLES.value }, value),
  )
}

/**
 * @param {number} percent
 */
function bar(percent) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return element(
    'div',
    { style: STYLES.bar },
    element('div', { style: { ...STYLES.barFill, width: `${clamped}%` } }),
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
 * The card component.
 *
 * @param {{ t?: (key: string) => string, runtime?: unknown }} props
 */
export function ZcodeCard(props) {
  const state = {
    loading: true,
    error: undefined,
    status: undefined,
    loginUrl: undefined,
    busy: false,
  }

  const root = element('div', { style: STYLES.card })

  const render = () => {
    root.replaceChildren()

    if (state.loading) {
      root.append(element('p', { style: STYLES.note }, 'Loading…'))
      return
    }

    if (state.error) {
      root.append(element('p', { style: STYLES.error }, state.error))
      root.append(
        element(
          'div',
          { style: STYLES.buttons },
          element('button', { style: STYLES.button, onClick: refresh }, 'Retry'),
        ),
      )
      return
    }

    const status = state.status ?? {}
    const credential = status.credential ?? {}
    const identity = status.identity ?? {}
    const quota = status.quota

    // Account
    root.append(
      element(
        'div',
        { style: STYLES.section },
        element('h4', { style: STYLES.heading }, 'Account'),
        row('status', credential.present ? `signed in (${credential.provider})` : 'not signed in'),
        credential.present && credential.hasJwt ? row('plan token', 'present') : undefined,
        credential.savedAt ? row('signed in at', new Date(credential.savedAt).toLocaleString()) : undefined,
        credential.path ? row('stored at', credential.path) : undefined,
      ),
    )

    // Identity prompt provenance — surfaced because a stale snapshot is the
    // single most likely cause of a provider that suddenly stops working.
    root.append(
      element(
        'div',
        { style: STYLES.section },
        element('h4', { style: STYLES.heading }, 'Identity prompt'),
        row('size', `${identity.chars ?? 0} characters`),
        row('healthy', identity.healthy ? 'yes' : 'no'),
        identity.healthy
          ? undefined
          : element('p', { style: STYLES.warning }, identity.warning ?? identity.error ?? 'unknown'),
      ),
    )

    // Quota
    if (quota) {
      const section = element('div', { style: STYLES.section }, element('h4', { style: STYLES.heading }, 'Quota'))
      if (quota.error) {
        section.append(element('p', { style: STYLES.error }, quota.error))
      } else if (!quota.buckets || quota.buckets.length === 0) {
        section.append(element('p', { style: STYLES.note }, 'No quota buckets reported by upstream.'))
      } else {
        for (const bucket of quota.buckets) {
          section.append(
            element(
              'div',
              { style: STYLES.section },
              row(bucket.label, `${bucket.remainingText} / ${bucket.totalText} (${bucket.percent}%)`),
              bar(bucket.percent),
              element('p', { style: STYLES.note }, `${bucket.planName}${bucket.periodEnd ? ` · resets ${formatTime(bucket.periodEnd)}` : ''}`),
            ),
          )
        }
      }
      root.append(section)
    }

    // Sign in / out
    const buttons = element('div', { style: STYLES.buttons })
    if (credential.present) {
      buttons.append(
        element(
          'button',
          {
            style: STYLES.button,
            disabled: state.busy,
            onClick: async () => {
              state.busy = true
              render()
              try {
                await call(ROUTES.logout, { method: 'POST' })
                await refresh()
              } catch (error) {
                state.error = error instanceof Error ? error.message : String(error)
              } finally {
                state.busy = false
                render()
              }
            },
          },
          'Sign out',
        ),
      )
    } else {
      for (const provider of status.providers ?? ['bigmodel', 'zai']) {
        buttons.append(
          element(
            'button',
            {
              style: STYLES.button,
              disabled: state.busy,
              onClick: async () => {
                state.busy = true
                state.error = undefined
                render()
                try {
                  const result = await call(ROUTES.login, { method: 'POST', body: { provider } })
                  state.loginUrl = result.authorizeUrl
                  window.open(result.authorizeUrl, '_blank', 'noopener')
                } catch (error) {
                  state.error = error instanceof Error ? error.message : String(error)
                } finally {
                  state.busy = false
                  render()
                }
              },
            },
            `Sign in (${provider})`,
          ),
        )
      }
    }
    buttons.append(
      element('button', { style: STYLES.button, disabled: state.busy, onClick: refresh }, 'Refresh'),
    )
    root.append(buttons)

    if (state.loginUrl) {
      root.append(
        element(
          'div',
          { style: STYLES.section },
          element('p', { style: STYLES.note }, 'Finish the authorization in the tab that just opened:'),
          element(
            'a',
            { style: STYLES.link, href: state.loginUrl, target: '_blank', rel: 'noopener' },
            state.loginUrl,
          ),
        ),
      )
    }

    if (credential.present && !credential.hasJwt) {
      root.append(
        element(
          'p',
          { style: STYLES.warning },
          'This login has no plan token, so plan-backed models are unavailable. Sign in again with a ' +
            'coding-plan subscription.',
        ),
      )
    }
  }

  let currentRequest

  async function refresh() {
    currentRequest?.abort()
    currentRequest = new AbortController()
    state.loading = true
    state.error = undefined
    render()
    try {
      state.status = await call(ROUTES.status, { signal: currentRequest.signal })
    } catch (error) {
      if (error?.name === 'AbortError') {
        return
      }
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.loading = false
      render()
    }
  }

  // Kick off the first load once the node is in the tree.
  queueMicrotask(refresh)

  return root
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
