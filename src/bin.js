#!/usr/bin/env node
/**
 * Command line entry for dsh-zcode-connect.
 *
 * Verbs:
 *   login [--provider zai|bigmodel]   browser authorization
 *   logout                            forget the stored credential
 *   status                            what is configured, without any network call
 *   doctor                            full diagnostics, including a live call
 *   quota                             plan quota snapshot
 *   refresh-identity                  re-extract the identity prompt from ZCode
 *   models                            the models this account is entitled to
 *
 * Every verb prints human-readable output by default and JSON with `--json`, so
 * the same code serves both a person at a terminal and a script.
 */

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

import { fetchQuota, formatUnits, grantedModelIds } from './billing.js'
import { canonicalModelId, metadataFor } from './catalog.js'
import { discoverZcodeAccount } from './credentials.js'
import {
  DEFAULT_IDENTITY_DATA_PATH,
  extractFromInstalledZcode,
  inspectIdentity,
  loadIdentityBlocks,
} from './identity.js'
import { login, PROVIDERS } from './oauth.js'
import {
  clearCredential,
  describeCredential,
  loadCredential,
  resolveStoreSecret,
  saveCredential,
  storePath,
} from './store.js'
import { sendMessages } from './transport.js'

const USAGE = `dsh-zcode-connect — use a GLM coding plan inside DSH

Usage:
  zcode-connect login [--provider zai|bigmodel]   authorize in a browser
  zcode-connect logout                            forget the stored credential
  zcode-connect status                            show configuration
  zcode-connect doctor                            full diagnostics
  zcode-connect quota                             plan quota snapshot
  zcode-connect models                            entitled models
  zcode-connect refresh-identity                  re-extract the identity prompt

Options:
  --json        machine-readable output
  --help, -h    this message
`

/**
 * Print a value.
 *
 * @param {unknown} value
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Open a URL in the user's browser without blocking.
 *
 * @param {string} url
 */
function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Best effort: the URL is printed as well, so the user can open it manually.
  }
}

/**
 * @param {string} text
 */
function heading(text) {
  process.stdout.write(`\n${text}\n${'-'.repeat(text.length)}\n`)
}

/**
 * @param {string} label
 * @param {unknown} value
 */
function row(label, value) {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`)
}

/**
 * `login`
 *
 * @param {{ provider: string | undefined, json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandLogin(options) {
  const provider = options.provider ?? 'bigmodel'
  if (!PROVIDERS.includes(provider)) {
    process.stderr.write(`unknown provider: ${provider}. Use one of ${PROVIDERS.join(', ')}.\n`)
    return 2
  }

  if (!options.json) {
    process.stdout.write(`Starting ${provider} authorization…\n`)
  }

  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  const result = await login({
    provider,
    signal: controller.signal,
    onAuthorizeUrl: (url) => {
      if (options.json) {
        printJson({ stage: 'authorize', url })
      } else {
        process.stdout.write(`\nOpen this URL to authorize:\n\n  ${url}\n\n`)
        process.stdout.write('Waiting for the authorization to complete…\n')
      }
      openBrowser(url)
    },
  })

  const path = saveCredential({
    provider: result.provider,
    accessToken: result.accessToken,
    jwt: result.jwt,
    savedAt: new Date().toISOString(),
  })
  if (options.json) {
    printJson({ ok: true, provider: result.provider, storePath: path, hasJwt: Boolean(result.jwt) })
  } else {
    process.stdout.write(`\nSigned in as ${result.provider}.\n`)
    row('credential', path)
    row('plan token', result.jwt ? 'yes' : 'no (coding-plan only)')
  }
  return 0
}

/**
 * `logout`
 *
 * @param {{ json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandLogout(options) {
  const removed = clearCredential()
  if (options.json) {
    printJson({ removed, storePath: storePath() })
  } else {
    process.stdout.write(removed ? 'Stored credential removed.\n' : 'No stored credential to remove.\n')
  }
  return 0
}

/**
 * `status`
 *
 * @param {{ json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandStatus(options) {
  const credential = describeCredential()
  let identity
  try {
    identity = inspectIdentity(loadIdentityBlocks())
  } catch (error) {
    identity = { chars: 0, healthy: false, warning: error instanceof Error ? error.message : String(error) }
  }

  const payload = {
    credential,
    identity: { path: DEFAULT_IDENTITY_DATA_PATH, ...identity },
    secretSource: process.env.ZCODE_CONNECT_CREDENTIAL_SECRET ? 'environment' : 'machine-derived',
  }

  if (options.json) {
    printJson(payload)
    return 0
  }

  heading('Credential')
  row('signed in', credential.present ? 'yes' : 'no')
  row('store', credential.path)
  if (credential.present) {
    row('provider', credential.provider)
    row('plan token', credential.hasJwt ? 'yes' : 'no')
    row('saved at', credential.savedAt)
  }
  if (credential.error) {
    row('error', credential.error)
  }

  heading('Identity snapshot')
  row('blocks', `${identity.chars} characters`)
  row('healthy', identity.healthy ? 'yes' : 'NO')
  if (identity.warning) {
    process.stdout.write(`\n  ! ${identity.warning}\n`)
  }

  heading('Storage encryption')
  row('seed source', payload.secretSource)
  if (payload.secretSource === 'machine-derived') {
    process.stdout.write(
      '\n  Note: the machine-derived seed is obfuscation, not protection.\n' +
        '  Set ZCODE_CONNECT_CREDENTIAL_SECRET to make the file actually private.\n',
    )
  }

  if (!credential.present) {
    process.stdout.write('\nRun `zcode-connect login` to sign in.\n')
  }
  return 0
}

/**
 * `doctor`
 *
 * @param {{ json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandDoctor(options) {
  /** @type {Array<{ check: string, ok: boolean, detail: string }>} */
  const checks = []
  const add = (check, ok, detail) => checks.push({ check, ok, detail })

  // 1. identity snapshot
  let identity
  try {
    const loaded = loadIdentityBlocks()
    identity = inspectIdentity(loaded)
    add(
      'identity snapshot',
      identity.healthy,
      `${identity.chars} characters from ${loaded.source}`,
    )
    if (loaded.provenance?.sha256OfSource) {
      add(
        'identity provenance',
        true,
        `ZCode ${loaded.provenance.appVersion ?? '?'} · ${String(loaded.provenance.sha256OfSource).slice(0, 12)}…`,
      )
    }
  } catch (error) {
    add('identity snapshot', false, error instanceof Error ? error.message : String(error))
  }

  // 2. stored credential
  const credential = describeCredential()
  add('stored credential', credential.present, credential.present ? credential.path : 'not signed in')

  // 3. optional: a ZCode install to refresh from
  let refreshable = false
  try {
    const extracted = extractFromInstalledZcode()
    refreshable = true
    add('ZCode install (refresh source)', true, `${extracted.source}`)
  } catch (error) {
    add(
      'ZCode install (refresh source)',
      true, // optional, so not a failure
      'not found — only needed for refresh-identity',
    )
  }

  // 4. live probe
  /** @type {any} */
  let probe
  const stored = credential.present ? loadCredential() : undefined
  if (stored?.jwt || stored?.accessToken) {
    try {
      const account = safeZcodeAccount()
      const result = await sendMessages({
        credential: stored,
        model: 'GLM-5.3-Flash',
        maxTokens: 64,
        messages: [{ role: 'user', content: 'reply with exactly: ok' }],
        deviceMid: account?.deviceMid,
      })
      probe = { ok: true, text: result.text.trim(), usage: result.usage }
      add('live call', true, `model replied ${JSON.stringify(result.text.trim().slice(0, 40))}`)
    } catch (error) {
      probe = { ok: false, error: error instanceof Error ? error.message : String(error) }
      const hint = /** @type {any} */ (error)?.hint
      add('live call', false, `${probe.error}${hint ? ` — ${hint}` : ''}`)
    }
  } else {
    add('live call', false, 'skipped: no stored credential')
  }

  // 5. quota
  if (stored?.jwt) {
    try {
      const quota = await fetchQuota({ jwt: stored.jwt })
      add('quota', quota.buckets.length > 0, `${quota.buckets.length} bucket(s)`)
    } catch (error) {
      add('quota', false, error instanceof Error ? error.message : String(error))
    }
  }

  const ok = checks.every((check) => check.ok)
  if (options.json) {
    printJson({ ok, checks, probe, refreshable })
    return ok ? 0 : 1
  }

  heading('Diagnostics')
  for (const check of checks) {
    process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.check.padEnd(30)} ${check.detail}\n`)
  }
  if (probe && !probe.ok) {
    process.stdout.write(`\nThe live call failed.\n`)
  }
  process.stdout.write(`\n${ok ? 'Everything checks out.' : 'Some checks failed.'}\n`)
  return ok ? 0 : 1
}

/**
 * Read the local ZCode account if one is present, without failing when it is not.
 *
 * @returns {ReturnType<typeof discoverZcodeAccount> | undefined}
 */
function safeZcodeAccount() {
  try {
    return discoverZcodeAccount()
  } catch {
    return undefined
  }
}

/**
 * `quota`
 *
 * @param {{ json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandQuota(options) {
  const stored = loadCredential()
  if (!stored?.jwt) {
    process.stderr.write('No plan token stored. Run `zcode-connect login` first.\n')
    return 1
  }

  const quota = await fetchQuota({ jwt: stored.jwt })

  if (options.json) {
    printJson(quota)
    return 0
  }

  heading('Plan quota')
  if (quota.buckets.length === 0) {
    process.stdout.write('  upstream reported no buckets\n')
  }
  for (const bucket of quota.buckets) {
    const percent = bucket.total > 0 ? Math.round((bucket.remaining / bucket.total) * 100) : 0
    process.stdout.write(
      `  ${bucket.label.padEnd(18)} ${formatUnits(bucket.remaining).padStart(9)} left` +
        ` / ${formatUnits(bucket.total).padStart(9)}  (${percent}%)  ${bucket.planName}\n`,
    )
  }
  for (const warning of quota.warnings) {
    process.stdout.write(`\n  ! ${warning}\n`)
  }
  return 0
}

/**
 * `models`
 *
 * @param {{ json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandModels(options) {
  const stored = loadCredential()
  if (!stored?.jwt) {
    process.stderr.write('No plan token stored. Run `zcode-connect login` first.\n')
    return 1
  }

  const quota = await fetchQuota({ jwt: stored.jwt })
  const ids = grantedModelIds(quota).map(canonicalModelId)
  const models = ids.map((id) => {
    const meta = metadataFor(id)
    return {
      id: meta.id,
      name: meta.name,
      contextWindow: meta.contextWindow,
      maxOutputTokens: meta.maxOutputTokens,
      reasoningLevels: [...meta.reasoningLevels],
      supportsImages: meta.supportsImages,
    }
  })

  if (options.json) {
    printJson(models)
    return 0
  }

  heading('Entitled models')
  for (const model of models) {
    process.stdout.write(
      `  ${model.name.padEnd(18)} ctx ${formatUnits(model.contextWindow).padStart(6)}` +
        `  out ${formatUnits(model.maxOutputTokens).padStart(6)}` +
        `  reasoning ${model.reasoningLevels.join('/')}\n`,
    )
  }
  if (models.length === 0) {
    process.stdout.write('  none reported by upstream\n')
  }
  return 0
}

/**
 * `refresh-identity`
 *
 * @param {{ json: boolean }} options
 * @returns {Promise<number>}
 */
async function commandRefreshIdentity(options) {
  let extracted
  try {
    extracted = extractFromInstalledZcode()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const inspection = inspectIdentity(extracted)
  const payload = {
    source: extracted.source,
    blocks: extracted.blocks.map((block) => block.text.length),
    chars: inspection.chars,
    healthy: inspection.healthy,
    target: DEFAULT_IDENTITY_DATA_PATH,
  }

  if (options.json) {
    printJson(payload)
    return inspection.healthy ? 0 : 1
  }

  heading('Extracted identity')
  row('from', extracted.source)
  row('blocks', extracted.blocks.map((block) => block.text.length).join(' + '))
  row('total', `${inspection.chars} characters`)
  row('healthy', inspection.healthy ? 'yes' : 'NO')
  process.stdout.write(
    `\nWrite this into ${DEFAULT_IDENTITY_DATA_PATH} to use it.\n` +
      'The file is JSON: {"blocks":[{"type":"text","text":"…"}]}.\n',
  )
  return inspection.healthy ? 0 : 1
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }

  const { values, positionals } = parsed
  const command = positionals[0]

  if (values.help || !command) {
    process.stdout.write(USAGE)
    return command ? 0 : values.help ? 0 : 2
  }

  try {
    switch (command) {
      case 'login':
        return await commandLogin({ provider: values.provider, json: Boolean(values.json) })
      case 'logout':
        return await commandLogout({ json: Boolean(values.json) })
      case 'status':
        return await commandStatus({ json: Boolean(values.json) })
      case 'doctor':
        return await commandDoctor({ json: Boolean(values.json) })
      case 'quota':
        return await commandQuota({ json: Boolean(values.json) })
      case 'models':
        return await commandModels({ json: Boolean(values.json) })
      case 'refresh-identity':
        return await commandRefreshIdentity({ json: Boolean(values.json) })
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    const hint = /** @type {any} */ (error)?.hint
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`)
    if (hint) {
      process.stderr.write(`\n  ${hint}\n`)
    }
    return 1
  }
}

// Only run when invoked directly, so the module stays importable for tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      process.exitCode = 1
    },
  )
}

export { main, USAGE }
export { resolveStoreSecret, storePath }
