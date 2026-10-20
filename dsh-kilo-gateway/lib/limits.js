/**
 * Model capability resolution and request fitting.
 *
 * Every Kilo model declares its own `context_length` and `top_provider.max_completion_tokens`,
 * and they differ by three orders of magnitude (a 256K router next to a 32K small model). Sending
 * a history that fits one but not the other is what produces the gateway's
 * `context_length_exceeded` rejection, so this module:
 *
 *  - keeps each model's real limits from the live catalog,
 *  - caps the requested `max_tokens` so input + output cannot exceed the window, and
 *  - estimates the assembled request's token count and refuses early with a code the harness
 *    can route, rather than letting the provider reject a body it never had room for.
 *
 * Anonymous access reaches only free models, so the gate for that lives here too.
 */

import { FREE_AUTO_MODEL, FREE_MODEL_SUFFIX } from './constants.js'

/** Conservative fallback window when a model is missing from the catalog. */
export const FALLBACK_CONTEXT_WINDOW = 128_000

/** Conservative fallback output cap. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 8_192

/**
 * Fraction of the window reserved for the reply when the caller does not ask for a specific
 * `max_tokens`. Kept low because an agentic turn spends most of its budget on input.
 */
const DEFAULT_OUTPUT_SHARE = 0.2

/**
 * Headroom `@deepseek-ai/dsh-compaction-basic` subtracts from the window before it will compact.
 * Its own default is 65536; a model whose window cannot absorb that plus a completion reservation
 * makes compaction throw `TargetPressureConfigError` instead of compacting, which would leave the
 * request to be rejected by the provider. Windows that cannot clear the arithmetic are widened to
 * something that can, because an over-reported window only costs a missed compaction while an
 * unusable one costs the turn.
 */
const COMPACTION_HEADROOM_TOKENS = 65_536

/**
 * Message budget that must survive after the harness's headroom.
 *
 * Compaction budgets `contextWindow − reservedCompletionTokens − headroomTokens` and throws when
 * that is non-positive. A model that declares a completion cap near its own window would otherwise
 * clamp the reservation to exactly `window − headroom`, leaving a pressure budget of zero — the
 * very failure this accounting exists to avoid. Reserving this much on top keeps it positive.
 */
const MINIMUM_PRESSURE_TOKENS = 32_768

/**
 * Smallest output reservation this adapter will allow, so a tiny declared model still gets a
 * usable completion budget instead of collapsing to one token.
 */
const MINIMUM_OUTPUT_TOKENS = 4_096

/**
 * Smallest window this adapter will report.
 *
 * Must cover the headroom, the pressure floor, and a usable completion reservation; anything less
 * makes `outputCeiling` collapse and starve the reply.
 */
export const MINIMUM_REPORTABLE_CONTEXT_WINDOW =
  COMPACTION_HEADROOM_TOKENS + MINIMUM_PRESSURE_TOKENS + MINIMUM_OUTPUT_TOKENS

/** `dsh-compaction-basic`'s default compaction threshold, as a fraction of the window. */
const COMPACTION_THRESHOLD_RATIO = 0.8

/** `dsh-compaction-basic`'s default retained verbatim tail, as a fraction of the message budget. */
const COMPACTION_RETAIN_RATIO = 0.16

/**
 * Characters-per-token divisor used for the pre-flight estimate. Deliberately pessimistic:
 * English and code average nearer 4, and over-estimating only costs a truncation attempt.
 */
const CHARS_PER_TOKEN = 3

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Whether a model id is reachable without credentials.
 *
 * Free models carry a `:free` suffix, and the `kilo-auto/free` router is free too. Kilo states
 * plainly that anonymous requests reach free models only.
 *
 * @param {string} modelId
 * @param {boolean} [isFree] the catalog's own `isFree` flag, when available
 * @returns {boolean}
 */
export function isFreeModel(modelId, isFree) {
  if (typeof modelId !== 'string') return false
  if (modelId.endsWith(FREE_MODEL_SUFFIX)) return true
  if (modelId === FREE_AUTO_MODEL) return true
  return isFree === true
}

/**
 * The limits one model imposes.
 *
 * @typedef {{ id: string; contextWindow: number; maxOutputTokens: number; isFree: boolean }} ModelLimits
 */

/**
 * Derive one model's limits from a raw catalog entry.
 *
 * @param {Record<string, any>} model
 * @returns {ModelLimits}
 */
export function limitsOf(model) {
  const declaredWindow = positiveNumber(model.context_length)
    ? model.context_length
    : positiveNumber(model.top_provider?.context_length)
      ? model.top_provider.context_length
      : FALLBACK_CONTEXT_WINDOW

  // Report a window compaction can actually budget against. A model too small for the harness's
  // headroom would make compaction throw and let the request leave untruncated; widening the
  // reported figure trades a missed early compaction for a turn that still runs.
  const contextWindow = Math.max(declaredWindow, MINIMUM_REPORTABLE_CONTEXT_WINDOW)

  const declaredOutput = positiveNumber(model.top_provider?.max_completion_tokens)
    ? model.top_provider.max_completion_tokens
    : positiveNumber(model.max_completion_tokens)
      ? model.max_completion_tokens
      : undefined

  // The output reservation must leave a usable message budget after the harness's headroom.
  // Clamping to `window - headroom` alone is not enough: a model declaring a completion cap near
  // its own window would land exactly on `window - headroom`, leaving a pressure budget of zero
  // and making compaction throw. Reserving pressure tokens on top keeps that strictly positive.
  const outputCeiling = Math.max(
    MINIMUM_OUTPUT_TOKENS,
    contextWindow - COMPACTION_HEADROOM_TOKENS - MINIMUM_PRESSURE_TOKENS,
  )
  const maxOutputTokens = Math.min(
    declaredOutput ?? Math.floor(contextWindow * DEFAULT_OUTPUT_SHARE),
    outputCeiling,
  )

  return {
    id: typeof model.id === 'string' ? model.id : '',
    // True catalog figure, so diagnostics and the free-model gate stay honest.
    declaredContextWindow: declaredWindow,
    contextWindow,
    maxOutputTokens: Math.max(1, maxOutputTokens),
    isFree: isFreeModel(model.id, model.isFree),
  }
}

/**
 * Estimate the token count of an assembled request without a tokenizer.
 *
 * A deliberate over-estimate: it counts message text, tool schemas, and a per-message envelope,
 * and divides by a pessimistic characters-per-token ratio.
 *
 * @param {{ messages?: readonly any[]; tools?: readonly any[] }} request
 * @returns {number}
 */
export function estimateRequestTokens(request) {
  let characters = 0

  const visit = (value) => {
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      characters += value.length
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      characters += 8
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        // Base64 image payloads dominate a request without being tokens, so price them flat.
        if (key === 'image_url') {
          characters += 4000
          continue
        }
        characters += key.length
        visit(item)
      }
    }
  }

  for (const message of request.messages ?? []) {
    visit(message)
    // Role tags, delimiters, and tool-call envelopes.
    characters += 32
  }
  for (const tool of request.tools ?? []) visit(tool)

  return Math.ceil(characters / CHARS_PER_TOKEN)
}

/**
 * Mirror of `dsh-compaction-basic`'s own budget arithmetic, so a caller can see whether this
 * model will actually compact.
 *
 * The harness computes `contextWindow - reservedCompletionTokens - headroomTokens` and compacts
 * once measured history passes `min(contextWindow * 0.8, that budget)`. When the subtraction goes
 * non-positive it raises `TargetPressureConfigError`, catches it, and continues with the request
 * untruncated — so this function exists to make that state visible rather than silent.
 *
 * @param {import('./limits.js').ModelLimits} limits
 * @returns {{ messageBudgetTokens: number; pressureBudgetTokens: number; thresholdTokens: number; retainTokens: number; usable: boolean }}
 */
export function compactionBudget(limits) {
  const window = limits.contextWindow
  const reserved = limits.maxOutputTokens
  const messageBudgetTokens = window - reserved
  const pressureBudgetTokens = messageBudgetTokens - COMPACTION_HEADROOM_TOKENS
  const thresholdTokens = Math.floor(Math.min(window * COMPACTION_THRESHOLD_RATIO, pressureBudgetTokens))
  const retainTokens = Math.floor(messageBudgetTokens * COMPACTION_RETAIN_RATIO)
  return {
    messageBudgetTokens,
    pressureBudgetTokens,
    thresholdTokens,
    retainTokens,
    usable: thresholdTokens > 0 && retainTokens < thresholdTokens,
  }
}
