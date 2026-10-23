/**
 * DSH host plugin entry for ZCode Proxy.
 *
 * Registers a model provider backed by a GLM coding plan (Z.AI / BigModel),
 * reached through ZCode's plan endpoint. Authentication is the plugin's own
 * browser-authorized login, so no ZCode client install is required at runtime.
 *
 * The plugin is deliberately thin: `src/adapter.js` owns the protocol
 * translation, and everything below only wires that into the host.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDER_ID, PROVIDER_NAME, ZcodeAdapter } from './src/adapter.js'
import { fetchQuota, formatUnits, grantedModelIds } from './src/billing.js'
import { canonicalModelId, metadataFor } from './src/catalog.js'
import { inspectIdentity, loadIdentityBlocks } from './src/identity.js'
import { login, PROVIDERS } from './src/oauth.js'
import { clearCredential, describeCredential, loadCredential, saveCredential } from './src/store.js'

/**
 * The installed package version, read from this package's own `package.json`.
 *
 * The path is derived from `import.meta.url` rather than the process CWD,
 * because the host may launch from anywhere and the plugin is loaded from
 * inside a profile's `node_modules`. Reading it at startup — rather than
 * hardcoding it — is what makes the settings card report the version that is
 * actually installed, which is the only useful answer when a stale copy is the
 * suspected cause of a bug.
 *
 * Failing to read it is not fatal: the card simply omits the row.
 *
 * @returns {string | undefined}
 */
function readOwnVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const parsed = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : undefined
  } catch {
    return undefined
  }
}

/** Resolved once at load; the installed version cannot change while running. */
export const VERSION = readOwnVersion()

/**
 * Stable cordis plugin name; must match the `id` of this package's row in
 * `cordis.patch.yml`.
 *
 * It is deliberately the PACKAGE NAME. The market's boot pass matches an
 * installed package against the user's patch layer by exact package name or by
 * the row id derived from that name (`market/lib/hot.js: patchLayerManages`);
 * a row id that differs from the package name matches neither, so the market
 * hot-mounts the package as a second entry and the two collide. Keeping them
 * equal is what lets install, upgrade and reinstall work with no manual edit to
 * the profile — the shape dsh-pocket-nas ships.
 */
export const name = 'dsh-zcode-proxy'

/**
 * Services required before the provider can be registered.
 *
 * `settings` must be listed even though the plugin only *probes* it: cordis
 * raises `cannot get property "settings" without inject` on any read of an
 * undeclared service, so an undeclared probe is itself the failure. Declaring
 * it also guarantees the service is ready before `apply` runs, which removes
 * the need to probe at all.
 */
export const inject = ['llm', 'settings']

/** Settings namespace backing the plugin's card. */
export const SETTINGS_NS = 'llm-zcode-proxy'

/** Same-origin routes the card calls. */
export const ROUTES = Object.freeze({
  status: '/plugins/dsh-zcode-proxy/status',
  quota: '/plugins/dsh-zcode-proxy/quota',
  models: '/plugins/dsh-zcode-proxy/models',
  login: '/plugins/dsh-zcode-proxy/login',
  logout: '/plugins/dsh-zcode-proxy/logout',
})

/**
 * Build the host-visible adapter instance.
 *
 * `Impl` is our own implementation class and `Base` is the host's `LlmAdapter`
 * when it can be imported. The host checks the adapter's identity, so the
 * registered object has to be an instance of the real base class.
 *
 * Copying `Impl.prototype` onto a subclass is not enough: `LlmAdapter` declares
 * no constructor of its own, so a bare `class Adapter extends Base {}` never
 * runs `Impl`'s constructor. `this.dependencies` then stayed `undefined` and
 * the host's first call threw `Cannot read properties of undefined (reading
 * 'providerName')` out of `providerInfo`, which the harness turns into
 * `dsh: fatal load failure` and a refused boot. The subclass therefore has to
 * re-establish that instance state itself.
 *
 * If the import is unavailable (a very old or very new host), the plain
 * implementation is registered instead and the host rejects it loudly rather
 * than silently misbehaving.
 *
 * @param {any} Impl
 * @param {any} Base
 * @param {any} dependencies
 * @returns {any}
 */
export function wrapAdapter(Impl, Base, dependencies) {
  if (typeof Base !== 'function') {
    return new Impl(dependencies)
  }

  const prototype = Object.getOwnPropertyDescriptors(Impl.prototype)
  delete prototype.constructor

  const Adapter = class extends Base {
    constructor(deps = {}) {
      super()
      this.dependencies = deps
    }
  }
  Object.defineProperties(Adapter.prototype, prototype)
  return new Adapter(dependencies)
}

/**
 * Wrap our adapter in the host's `LlmAdapter` base class when it is available.
 *
 * @param {any} dependencies
 * @returns {Promise<any>}
 */
async function createAdapter(dependencies) {
  let Base = undefined
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    Base = mod?.LlmAdapter
  } catch {
    Base = undefined
  }

  return wrapAdapter(ZcodeAdapter, Base, dependencies)
}

/**
 * Read the account's entitled models, falling back to a sensible default when
 * the account cannot be queried.
 *
 * @returns {Promise<Array<{ id: string, name: string, contextWindow: number, maxTokens: number, inputModalities: string[] }>>}
 */
async function discoverModels() {
  const credential = loadCredential()
  if (credential?.jwt) {
    try {
      const quota = await fetchQuota({ jwt: credential.jwt })
      const ids = grantedModelIds(quota).map(canonicalModelId)
      if (ids.length > 0) {
        return ids.map((id) => toHostModel(id))
      }
    } catch {
      // Fall through to the default list; the card surfaces the real error.
    }
  }
  return ['GLM-5.3', 'GLM-5.3-Flash'].map((id) => toHostModel(id))
}

/**
 * Build one discovered-model record in the shape the host validates.
 *
 * `provider` is NOT optional. `LlmService.listModels` checks every entry with
 *
 *     model.provider !== provider -> throw LlmError(..., 'INVALID_CATALOG')
 *
 * and the settings surface renders that failure verbatim as
 *
 *     ZCode 加载失败: adapter returned invalid or duplicate model metadata
 *
 * Omitting the field is what produced that message: the host compares against
 * the provider route it asked about (`zcode`), so the value has to be
 * `PROVIDER_ID` and not merely "some string".
 *
 * @param {string} id
 * @returns {{ provider: string, id: string, name: string, contextWindow: number, maxTokens: number, inputModalities: string[] }}
 */
function toHostModel(id) {
  const meta = metadataFor(id)
  return {
    provider: PROVIDER_ID,
    id: meta.id,
    name: meta.name,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxOutputTokens,
    inputModalities: meta.supportsImages ? ['text', 'image'] : ['text'],
  }
}

/**
 * Reject requests that did not originate on the loopback interface.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isTrustedRequest(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !origin) {
    return true
  }
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  if (chunks.length === 0) {
    return {}
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Build the status document the card renders.
 *
 * @param {Record<string, unknown>} [extra] Route-owned fields to merge in, such
 *   as the pending login's outcome; `/status` is how the card learns a detached
 *   login settled.
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildStatus(extra = {}) {
  const credential = describeCredential()
  let identity
  try {
    const loaded = loadIdentityBlocks()
    identity = { source: loaded.source, ...inspectIdentity(loaded) }
  } catch (error) {
    identity = { healthy: false, chars: 0, error: error instanceof Error ? error.message : String(error) }
  }

  /** @type {Record<string, unknown> | undefined} */
  let quota
  const stored = credential.present ? loadCredential() : undefined
  if (stored?.jwt) {
    try {
      const summary = await fetchQuota({ jwt: stored.jwt })
      quota = {
        buckets: summary.buckets.map((bucket) => ({
          label: bucket.label,
          planName: bucket.planName,
          remaining: bucket.remaining,
          total: bucket.total,
          used: bucket.used,
          remainingText: formatUnits(bucket.remaining),
          totalText: formatUnits(bucket.total),
          percent: bucket.total > 0 ? Math.round((bucket.remaining / bucket.total) * 100) : 0,
          periodEnd: bucket.periodEnd,
          expiresAt: bucket.expiresAt,
        })),
        plans: summary.plans,
        warnings: summary.warnings,
        fetchedAt: summary.fetchedAt,
      }
    } catch (error) {
      quota = { error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    provider: { id: PROVIDER_ID, name: PROVIDER_NAME },
    version: VERSION,
    credential,
    identity,
    quota,
    providers: PROVIDERS,
    ...extra,
  }
}

/**
 * Register one same-origin route, tolerating an identical route owned by another
 * live instance of this plugin.
 *
 * `webServer.register` throws `webserver: duplicate exact route "<path>"` when a
 * second owner appears. A duplicate mount of this package would otherwise fail
 * the *second* plugin's activation — which the host escalates to
 * `1 required plugin did not activate` and a refused boot. The first mount
 * already serves the route, so the duplicate is skipped with a warning and a
 * no-op disposer.
 *
 * @param {any} webCtx
 * @param {any} route
 * @returns {() => void}
 */
function registerRoute(webCtx, route) {
  try {
    return webCtx.webServer.register(route)
  } catch (error) {
    warnSkippedRegistration(
      `route ${route.path}`,
      error instanceof Error ? error.message : String(error),
    )
    return () => {}
  }
}

/**
 * Register the same-origin routes the card uses.
 *
 * @param {any} ctx
 */
function registerRoutes(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = []

      disposers.push(
        registerRoute(webCtx, {
          kind: 'exact',
          path: ROUTES.status,
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              return json(res, 405, { error: 'method not allowed' })
            }
            if (!isTrustedRequest(req)) {
              return json(res, 403, { error: 'origin not trusted' })
            }
            try {
              json(res, 200, await buildStatus({ login: loginAttempt }))
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      disposers.push(
        registerRoute(webCtx, {
          kind: 'exact',
          path: ROUTES.models,
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              return json(res, 405, { error: 'method not allowed' })
            }
            if (!isTrustedRequest(req)) {
              return json(res, 403, { error: 'origin not trusted' })
            }
            try {
              json(res, 200, { models: await discoverModels() })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      disposers.push(
        registerRoute(webCtx, {
          kind: 'exact',
          path: ROUTES.logout,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              return json(res, 405, { error: 'method not allowed' })
            }
            if (!isTrustedRequest(req)) {
              return json(res, 403, { error: 'origin not trusted' })
            }
            try {
              const removed = clearCredential()
              json(res, 200, { removed })
            } catch (error) {
              json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      // Login is a mutation with a long tail: it hands back the authorization
      // URL immediately and finishes in the background, so the card can show
      // the link without holding a request open for minutes.
      //
      // The handler must NOT await the exchange. It used to, so that the card's
      // post-login `/status` re-read could not race the credential write — but
      // that made the request live for as long as the user took to authorize
      // (up to DEFAULT_LOGIN_TIMEOUT_MS, ten minutes). The card's own refresh
      // aborts whatever request it owns, so pressing 刷新 mid-authorization
      // killed the login request while the exchange kept running server-side,
      // leaving `loading`/`busy` stuck and every button disabled: the pane
      // froze on 加载中… with the credential already on disk.
      //
      // Returning promptly and publishing the outcome separately keeps the
      // write ordering observable without binding it to a request lifetime.
      /** @type {AbortController | undefined} */
      let activeLogin
      /**
       * Outcome of the most recent login attempt, read by `/status`.
       *
       * `pending` while the browser authorization is still open, then the
       * settled result. The card polls `/status` and stops once this leaves
       * `pending`, which is the signal that replaced awaiting the request.
       *
       * @type {{ state: 'idle' | 'pending' | 'signed-in' | 'failed', provider?: string, error?: string, at?: string }}
       */
      let loginAttempt = { state: 'idle' }
      disposers.push(() => {
        activeLogin?.abort()
      })

      disposers.push(
        registerRoute(webCtx, {
          kind: 'exact',
          path: ROUTES.login,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              return json(res, 405, { error: 'method not allowed' })
            }
            if (!isTrustedRequest(req)) {
              return json(res, 403, { error: 'origin not trusted' })
            }

            const body = await readJsonBody(req)
            const provider = typeof body.provider === 'string' ? body.provider : 'bigmodel'
            if (!PROVIDERS.includes(provider)) {
              return json(res, 400, { error: `provider must be one of ${PROVIDERS.join(', ')}` })
            }

            activeLogin?.abort()
            activeLogin = new AbortController()
            const controller = activeLogin

            let resolveUrl
            const urlPromise = new Promise((resolve) => {
              resolveUrl = resolve
            })

            loginAttempt = { state: 'pending', provider }

            // Detached on purpose: the response below only waits for the
            // authorize URL. The settlement is published into `loginAttempt`
            // instead of into this request, so `/status` can report it whether
            // or not the originating request is still open.
            void login({
              provider,
              signal: controller.signal,
              onAuthorizeUrl: (url) => {
                resolveUrl(url)
              },
            })
              .then((result) => {
                saveCredential({
                  provider: result.provider,
                  accessToken: result.accessToken,
                  jwt: result.jwt,
                  savedAt: new Date().toISOString(),
                })
                // Only publish if this attempt is still the current one; a
                // superseded login must not overwrite a newer attempt's state.
                if (activeLogin === controller) {
                  loginAttempt = {
                    state: 'signed-in',
                    provider: result.provider,
                    at: new Date().toISOString(),
                  }
                }
              })
              .catch((error) => {
                if (activeLogin !== controller) {
                  return
                }
                // A superseded attempt is aborted, not failed: the user pressed
                // sign-in again, or the plugin unloaded. Reporting that as a
                // failure would surface a spurious error card for an action the
                // user never saw fail, so the attempt just goes idle and the
                // newer attempt's own state takes over.
                const aborted = controller.signal.aborted || error?.kind === 'aborted'
                loginAttempt = aborted
                  ? { state: 'idle' }
                  : {
                      state: 'failed',
                      provider,
                      error: error instanceof Error ? error.message : String(error),
                      at: new Date().toISOString(),
                    }
              })

            // The response waits only for the authorize URL, never for the
            // exchange; the card follows the settlement through `/status`.
            const url = await urlPromise
            json(res, 200, { authorizeUrl: url, provider, pending: true })
          },
        }),
      )

      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            // A failed disposer must not prevent the others from running.
          }
        }
      }
    })
  })
}

/** Deduplicates the warnings below; one line per (surface, reason) per process. */
const warnedRegistrations = new Set()

/**
 * Warn once per process about a registration this instance deliberately skipped.
 *
 * A duplicate mount is a composition fact, not a plugin bug: it is how the
 * market hot-mounts a second loader row (`mkt-<id>`) beside the bundle row, and
 * how a profile ends up with both a bundle row and a hand-written marker row.
 * The first instance owns the route; the second must step aside quietly enough
 * not to break the boot, but loudly enough to be diagnosable.
 *
 * @param {string} what
 * @param {string} [reason]
 */
function warnSkippedRegistration(what, reason) {
  const key = `${what}:${reason ?? ''}`
  if (warnedRegistrations.has(key)) {
    return
  }
  warnedRegistrations.add(key)
  console.warn(
    `[dsh-zcode-proxy] ${what} skipped: ${reason ?? 'already registered by another live instance'}. ` +
      'This happens when the same package is mounted twice (bundle row + hot-mount row, or a ' +
      'bundle row + a manual marker row in the profile patch); the first instance keeps serving it.',
  )
}

/**
 * Whether a provider route already has an adapter registered by someone.
 *
 * `listProviders()` is the host's public, detached view of the adapter
 * registry, so this is a read, not a probe of an undeclared service.
 *
 * @param {any} llm
 * @returns {boolean}
 */
function providerHasAdapter(llm) {
  try {
    return llm.listProviders().some((entry) => entry?.id === PROVIDER_ID)
  } catch {
    return false
  }
}

/**
 * Whether a configurable provider is already declared by someone.
 *
 * @param {any} llm
 * @returns {boolean}
 */
function providerIsDeclared(llm) {
  try {
    return llm.listConfigurableProviders().some((entry) => entry?.provider === PROVIDER_ID)
  } catch {
    return false
  }
}

/**
 * Cordis plugin entry.
 *
 * Every registration below is a SINGLE-OWNER host registry, and each one
 * throws on a second owner:
 *
 *   - `llm.registerAdapter`         -> DUPLICATE_ADAPTER
 *   - `llm.registerConfigurableProviders` -> DUPLICATE_DIRECTORY
 *   - `llm.registerModelDiscovery`  -> DUPLICATE_DISCOVERY
 *   - `webServer.register`          -> `webserver: duplicate exact route`
 *
 * On DSH 0.2.1-rc.2 a second mount therefore killed the host outright. The
 * adapter registration is asynchronous, so its rejection escaped as an
 * *unhandled rejection* — which the harness escalates to
 * `dsh: fatal load failure` and exit code 1:
 *
 *     [harness-node] unhandled rejection: LlmError:
 *       an adapter for provider "zcode" is already registered
 *     dsh: fatal load failure: LlmError: ...
 *
 * A plugin must never be able to do that to its host. Every registration is
 * now either skipped when another live instance owns the surface, or contained
 * and logged. The plugin still refuses to lie: if it cannot register, it says
 * so on stderr instead of pretending the provider is live.
 *
 * @param {any} ctx
 */
export function apply(ctx) {
  const adapter = createAdapter({ discoverModels, providerName: PROVIDER_NAME })

  // `createAdapter` is async, so registration happens once it settles. The
  // effect keeps the handle disposal tied to the plugin's lifetime.
  ctx.effect(() => {
    let releaseAdapter
    let released = false

    Promise.resolve(adapter)
      .then((instance) => {
        if (released) {
          return
        }
        if (providerHasAdapter(ctx.llm)) {
          warnSkippedRegistration('adapter registration')
          return
        }
        releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], instance)
      })
      .catch((error) => {
        // Never let this escape: an unhandled rejection here is a fatal host
        // load failure, not a degraded provider.
        warnSkippedRegistration(
          'adapter registration',
          error instanceof Error ? error.message : String(error),
        )
      })

    return () => {
      released = true
      try {
        releaseAdapter?.()
      } catch {
        // A failed disposer must not prevent the rest of the teardown.
      }
    }
  })

  ctx.effect(() => {
    if (providerIsDeclared(ctx.llm)) {
      warnSkippedRegistration('configurable-provider declaration')
      return
    }
    return ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER_ID,
        displayName: PROVIDER_NAME,
        settingsNs: SETTINGS_NS,
        settingsPath: [],
        declared: false,
      },
    ])
  })

  ctx.effect(() => {
    try {
      return ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request) => {
        if (request?.provider !== undefined && request.provider !== PROVIDER_ID) {
          return []
        }
        return await discoverModels()
      })
    } catch (error) {
      warnSkippedRegistration(
        'model discovery',
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    }
  })

  // The settings service gained `configure` in 0.1.7; older hosts expose
  // `installSection` instead. `settings` is declared in `inject`, so the
  // service is guaranteed to be here; only the method may differ.
  if (typeof ctx.settings.configure === 'function') {
    ctx.effect(() => {
      try {
        return ctx.settings.configure({ auto: true }, ctx.fiber)
      } catch (error) {
        // A second mount of the same package configures the same presentation
        // slot; that is a composition duplicate, not a reason to fail the boot.
        warnSkippedRegistration(
          'settings presentation',
          error instanceof Error ? error.message : String(error),
        )
        return undefined
      }
    })
  }

  registerRoutes(ctx)
}

export { PROVIDER_ID, PROVIDER_NAME }

/**
 * The discovered-model builder, exposed for the contract test.
 *
 * The host validates this exact shape and reports a violation as
 * `adapter returned invalid or duplicate model metadata`; a test that asserted
 * the source text alone would not catch a wrong value, only a missing field.
 */
export const toHostModelForTest = toHostModel
