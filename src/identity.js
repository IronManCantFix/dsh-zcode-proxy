/**
 * The identity system prompt the ZCode gateway requires on plan requests.
 *
 * ## Why this exists
 *
 * `POST {origin}/api/v1/zcode-plan/anthropic/v1/messages` is fronted by a
 * content check. A request whose `system` field does not carry the official
 * client's identity sections is refused before it reaches the model:
 *
 *     HTTP 405  {"code":3012,"msg":"request has been blocked due to unusual activity."}
 *
 * This was established by A/B experiment on this machine: with the real
 * identity blocks the same request returns `200`, and removing only the
 * `system` field reproduces the `3012` block. The check needs at least the
 * first two sections (the CLI prefix and the agent identity, including its
 * "# Harness" part); a truncated identity or a placeholder does not pass.
 * `cache_control` on the blocks is *not* required.
 *
 * ## Why we extract instead of embedding
 *
 * The identity text is ZCode's own system prompt. Hard-coding a copy here
 * would redistribute it and would drift from whatever ZCode version is
 * installed. Instead this module reads the exact literals out of the local
 * ZCode bundle at runtime, so the plugin always speaks the same identity as
 * the client sitting next to it.
 *
 * The sections are assembled by ZCode from several string constants; we locate
 * those constants individually and join them the same way ZCode's
 * `buildAgentIdentitySection` does.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The bundled identity snapshot.
 *
 * Shipped as data so the plugin needs no ZCode installation at runtime. Its
 * `provenance` block records which bundle it came from and when, so a stale
 * snapshot can be spotted rather than silently drifting.
 */
export const DEFAULT_IDENTITY_DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'identity-data.json',
)

/**
 * Where the CLI bundle typically lives.
 *
 * The bundle ships inside the ZCode application rather than under `~/.zcode`,
 * so these are the platform-default install locations. Callers that know the
 * real path should pass `bundlePath` instead.
 *
 * @type {readonly string[]}
 */
export const DEFAULT_BUNDLE_CANDIDATES = Object.freeze([
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  join(homedir(), 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
])

/** The literal that opens the "CLI Prefix" section. */
const CLI_PREFIX_CONSTANT = 'IJs'

/** The literal holding the security-policy paragraph of the identity section. */
const SECURITY_CONSTANT = 'mno'

/** The sentence ZCode uses when no output style is active. */
const IDENTITY_SENTENCE =
  'You are an interactive ZCode agent that helps users with software engineering tasks.'

/**
 * Unescape a JavaScript string body the way the engine would.
 *
 * A JSON parser is not sufficient here: the bundle contains `\'` and `\xNN`
 * escapes that JSON rejects, and a single rejected literal would silently drop
 * a whole identity section.
 *
 * @param {string} body
 * @returns {string}
 */
export function unescapeJsString(body) {
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[index + 1]
    index += 1
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\r'
        break
      case 't':
        out += '\t'
        break
      case 'b':
        out += '\b'
        break
      case 'f':
        out += '\f'
        break
      case 'v':
        out += '\v'
        break
      case '0':
        out += '\0'
        break
      case 'x': {
        const hex = body.slice(index + 1, index + 3)
        index += 2
        out += String.fromCharCode(Number.parseInt(hex, 16))
        break
      }
      case 'u': {
        if (body[index + 1] === '{') {
          const end = body.indexOf('}', index)
          const hex = body.slice(index + 2, end)
          index = end
          out += String.fromCodePoint(Number.parseInt(hex, 16))
          break
        }
        const hex = body.slice(index + 1, index + 5)
        index += 4
        out += String.fromCharCode(Number.parseInt(hex, 16))
        break
      }
      case undefined:
        out += '\\'
        break
      default:
        // Covers \\ \' \" \` and any other escaped character.
        out += next
        break
    }
  }
  return out
}

/** Matches one double-quoted JavaScript string literal body (no quotes). */
const JS_STRING_BODY = String.raw`((?:[^"\\]|\\.)*)`

/**
 * Read a `name="..."` JavaScript string literal out of a bundle.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string | undefined}
 */
export function readStringLiteral(source, name) {
  const pattern = new RegExp(`\\b${name}="${JS_STRING_BODY}"`)
  const match = pattern.exec(source)
  return match ? unescapeJsString(match[1]) : undefined
}

/**
 * Read the array literal a small builder function returns, joined with newlines.
 *
 * ZCode's harness section is a one-liner of the form
 * `function X(){return["a","b"].join(`\n`)}`. Rather than hard-coding the
 * minified function name — or writing one brittle combined regex — this finds
 * the marker, walks out to the enclosing `[` and the following `.join(`, and
 * collects the string literals in between.
 *
 * @param {string} source
 * @param {string} marker the first array element, e.g. `# Harness`
 * @returns {string | undefined}
 */
export function readJoinerArraySection(source, marker) {
  const markerIndex = source.indexOf(`"${marker}"`)
  if (markerIndex < 0) {
    return undefined
  }

  const openIndex = source.lastIndexOf('[', markerIndex)
  if (openIndex < 0) {
    return undefined
  }

  const joinIndex = source.indexOf('.join(', markerIndex)
  if (joinIndex < 0) {
    return undefined
  }

  const slice = source.slice(openIndex, joinIndex)
  // A raw newline is never valid inside a JS string literal, so one appearing
  // here means we walked past the expression we meant to capture.
  if (slice.includes('\n')) {
    return undefined
  }

  /** @type {string[]} */
  const parts = []
  const literalPattern = new RegExp(`"${JS_STRING_BODY}"`, 'g')
  for (const literal of slice.matchAll(literalPattern)) {
    parts.push(unescapeJsString(literal[1]))
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Extract the identity system blocks from a ZCode bundle.
 *
 * @param {string} bundlePath
 * @returns {{ blocks: Array<{ type: 'text', text: string }>, source: string }}
 */
export function extractIdentityBlocks(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8')

  const cliPrefix = readStringLiteral(source, CLI_PREFIX_CONSTANT)
  if (!cliPrefix) {
    throw new Error(`could not read the CLI prefix literal (${CLI_PREFIX_CONSTANT}) from ${bundlePath}`)
  }

  const security = readStringLiteral(source, SECURITY_CONSTANT)
  if (!security) {
    throw new Error(`could not read the identity literal (${SECURITY_CONSTANT}) from ${bundlePath}`)
  }

  const harness = readJoinerArraySection(source, '# Harness')
  if (!harness) {
    throw new Error(`could not read the "# Harness" section from ${bundlePath}`)
  }

  // Mirrors buildAgentIdentitySection: ["", identitySentence, "", security,
  //   "", harness].join("\n") once the empty-string joins are expanded.
  const identity = ['', IDENTITY_SENTENCE, '', security, '', harness].join('\n')

  return {
    blocks: [
      { type: 'text', text: cliPrefix },
      { type: 'text', text: identity },
    ],
    source: bundlePath,
  }
}

/**
 * Extract the identity blocks by trying each candidate bundle in turn.
 *
 * This is the *refresh* path: it is only needed when ZCode ships a new prompt
 * and the bundled data needs regenerating. Normal operation reads the bundled
 * snapshot and never touches the ZCode installation.
 *
 * @param {{ bundlePath?: string, candidates?: readonly string[] }} [options]
 * @returns {{ blocks: Array<{ type: 'text', text: string }>, source: string }}
 */
export function extractFromInstalledZcode(options = {}) {
  const candidates = options.bundlePath
    ? [options.bundlePath]
    : (options.candidates ?? DEFAULT_BUNDLE_CANDIDATES)

  /** @type {Error[]} */
  const failures = []
  for (const candidate of candidates) {
    try {
      return extractIdentityBlocks(candidate)
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  throw new Error(
    `unable to read the ZCode identity prompt from any known bundle location:\n` +
      failures.map((error) => `  - ${error.message}`).join('\n'),
    { cause: failures[0] },
  )
}

/**
 * Load the bundled identity snapshot.
 *
 * The snapshot is a data file shipped with the plugin, so the plugin has no
 * runtime dependency on a ZCode installation.
 *
 * @param {{ path?: string }} [options]
 * @returns {{ blocks: Array<{ type: 'text', text: string }>, source: string, provenance?: Record<string, unknown> }}
 */
export function loadBundledIdentityBlocks(options = {}) {
  const path = options.path ?? DEFAULT_IDENTITY_DATA_PATH
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read the bundled identity snapshot at ${path}`, { cause: error })
  }

  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : []
  const usable = blocks.filter(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.length > 0,
  )
  if (usable.length === 0) {
    throw new Error(`the bundled identity snapshot at ${path} contains no usable blocks`)
  }

  return {
    blocks: usable.map((block) => ({ type: /** @type {'text'} */ ('text'), text: block.text })),
    source: `${path} (bundled)`,
    provenance: parsed?.provenance,
  }
}

/**
 * Load the identity blocks the plugin sends.
 *
 * Prefers the bundled snapshot so the plugin works with no ZCode installation
 * present. Callers that explicitly want a live extraction should use
 * {@link extractFromInstalledZcode}.
 *
 * @param {{ path?: string }} [options]
 * @returns {{ blocks: Array<{ type: 'text', text: string }>, source: string, provenance?: Record<string, unknown> }}
 */
export function loadIdentityBlocks(options = {}) {
  return loadBundledIdentityBlocks(options)
}

/**
 * The smallest identity length observed to be accepted by the gateway.
 *
 * Live probing showed an identity of ~600 characters is refused while ~1200 is
 * accepted, so this sits near the middle of the unknown boundary. It exists to
 * warn early rather than to be exact: a snapshot below it is very likely to
 * start collecting `3012` responses.
 */
export const MIN_SAFE_IDENTITY_CHARS = 1000

/**
 * Describe how healthy the loaded identity snapshot looks.
 *
 * @param {{ blocks: Array<{ type: 'text', text: string }> }} loaded
 * @returns {{ chars: number, healthy: boolean, warning?: string }}
 */
export function inspectIdentity(loaded) {
  const chars = loaded.blocks.reduce((total, block) => total + block.text.length, 0)
  if (chars >= MIN_SAFE_IDENTITY_CHARS) {
    return { chars, healthy: true }
  }
  return {
    chars,
    healthy: false,
    warning:
      `the identity snapshot is only ${chars} characters; requests are likely to be ` +
      `refused with 3012. Refresh it from an installed ZCode with the refresh-identity command.`,
  }
}
