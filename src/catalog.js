/**
 * The model catalogue the provider advertises.
 *
 * Context windows and output limits are not guesses: they come from the model
 * rules ZCode ships (`Resources/config/provider/zcode-builtin.json`), which are
 * themselves derived from the vendor's published limits. The relevant rules for
 * the GLM-5.3 family are:
 *
 *     { modelMatch: ".*glm-5\\.3(?:-flash)?…",
 *       config: { properties: { contextWindow: 1000000 },
 *                 optionSpecs: { reasoningLevel: { values: ["low","high","max"] },
 *                                maxOutputTokens: { max: 128000 } } } }
 *
 * The reasoning levels map onto the Anthropic wire shape the plan endpoint
 * expects:
 *
 *     { thinking: { type: "enabled" }, output_config: { effort: <level> } }
 *
 * Which models are actually *offered* is decided at runtime from the account's
 * entitlements (`billing.js`), not from this table — this table only supplies
 * metadata for ids the account is entitled to.
 */

/**
 * @typedef {object} ModelMetadata
 * @property {string} id
 * @property {string} name
 * @property {number} contextWindow
 * @property {number} maxOutputTokens
 * @property {boolean} supportsImages
 * @property {boolean} supportsPdf
 * @property {readonly string[]} reasoningLevels
 * @property {boolean} reasoning
 */

/**
 * Metadata for the models the plan endpoint serves.
 *
 * @type {Record<string, ModelMetadata>}
 */
export const MODEL_CATALOG = Object.freeze({
  'GLM-5.3': Object.freeze({
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsPdf: false,
    reasoningLevels: Object.freeze(['low', 'high', 'max']),
    reasoning: true,
  }),
  'GLM-5.3-Flash': Object.freeze({
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    supportsPdf: true,
    reasoningLevels: Object.freeze(['low', 'high', 'max']),
    reasoning: true,
  }),
  'GLM-5.2': Object.freeze({
    id: 'GLM-5.2',
    name: 'GLM-5.2',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsImages: false,
    supportsPdf: false,
    reasoningLevels: Object.freeze(['low', 'high', 'max']),
    reasoning: true,
  }),
  'GLM-5-Turbo': Object.freeze({
    id: 'GLM-5-Turbo',
    name: 'GLM-5-Turbo',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsImages: false,
    supportsPdf: false,
    reasoningLevels: Object.freeze(['disabled', 'enabled']),
    reasoning: true,
  }),
  'GLM-5': Object.freeze({
    id: 'GLM-5',
    name: 'GLM-5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsImages: false,
    supportsPdf: false,
    reasoningLevels: Object.freeze(['disabled', 'enabled']),
    reasoning: true,
  }),
  'GLM-4.7': Object.freeze({
    id: 'GLM-4.7',
    name: 'GLM-4.7',
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    supportsImages: false,
    supportsPdf: false,
    reasoningLevels: Object.freeze(['disabled', 'enabled']),
    reasoning: true,
  }),
  'GLM-4.6': Object.freeze({
    id: 'GLM-4.6',
    name: 'GLM-4.6',
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    supportsImages: false,
    supportsPdf: false,
    reasoningLevels: Object.freeze(['disabled', 'enabled']),
    reasoning: true,
  }),
})

/**
 * Fallback metadata for a model id that is granted by the account but absent
 * from the catalogue, e.g. a model released after this plugin shipped.
 *
 * @param {string} id
 * @returns {ModelMetadata}
 */
export function fallbackMetadata(id) {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsImages: false,
    supportsPdf: false,
    reasoningLevels: ['low', 'high', 'max'],
    reasoning: true,
  }
}

/**
 * Look up metadata, falling back for unknown ids.
 *
 * Lookup is case-insensitive because entitlements use lowercase ids
 * (`model:glm-5.3`) while the catalogue and the wire use the canonical casing.
 *
 * @param {string} id
 * @returns {ModelMetadata}
 */
export function metadataFor(id) {
  if (typeof id !== 'string' || !id.trim()) {
    return fallbackMetadata('unknown')
  }
  const direct = MODEL_CATALOG[id]
  if (direct) {
    return direct
  }
  const lowered = id.trim().toLowerCase()
  for (const [key, value] of Object.entries(MODEL_CATALOG)) {
    if (key.toLowerCase() === lowered) {
      return value
    }
  }
  if (lowered.includes('flash')) {
    return { ...fallbackMetadata('GLM-5.3-Flash'), id, name: id }
  }
  return fallbackMetadata(id)
}

/**
 * Canonicalise a model id from an entitlement (`model:glm-5.3-flash` ->
 * `GLM-5.3-Flash`).
 *
 * @param {string} id
 * @returns {string}
 */
export function canonicalModelId(id) {
  return metadataFor(id).id
}

/**
 * Build the Anthropic wire options for a reasoning level.
 *
 * Returns `undefined` when the request should not carry thinking options at
 * all, which is the case for `disabled` on the older GLM-5 family.
 *
 * @param {string | undefined} level
 * @returns {{ thinking?: Record<string, unknown>, output_config?: Record<string, unknown> } | undefined}
 */
export function reasoningOptions(level) {
  if (!level) {
    return undefined
  }
  if (level === 'disabled' || level === 'none' || level === 'off') {
    return { thinking: { type: 'disabled' } }
  }
  // The GLM-5.3 family expects an explicit effort alongside enabled thinking.
  return { thinking: { type: 'enabled' }, output_config: { effort: level } }
}
