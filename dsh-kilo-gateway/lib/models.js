/**
 * Kilo model catalog discovery.
 *
 * Ported from `packages/kilo-gateway/src/api/models.ts`. Kilo exposes an
 * OpenRouter-compatible `/models` route, so the payload shape is OpenRouter's.
 */

import { MODELS_FETCH_TIMEOUT_MS } from './constants.js'
import { resolveKiloOpenRouterBaseUrl, resolveKiloGatewayUrl, getKiloUrlFromToken } from './url.js'
import { getDefaultHeaders, buildKiloHeaders } from './headers.js'
import { isFreeModel as isFreeModelId } from './limits.js'

/**
 * Kilo requires tool calling, so models that explicitly omit "tools" are hidden.
 * A missing or empty `supported_parameters` is treated optimistically (routers
 * such as `typesafe/jev-router` report an empty list).
 *
 * @param {{ supported_parameters?: string[] }} model
 * @returns {boolean}
 */
export function supportsTools(model) {
  const params = model.supported_parameters
  if (!params || params.length === 0) return true
  return params.includes('tools')
}

/**
 * Parse an API price string into per-million-token dollars.
 * The API reports $/token; downstream cost math expects $/M tokens.
 *
 * @param {string | null | undefined} price
 * @returns {number | undefined}
 */
function parseApiPrice(price) {
  if (!price) return undefined
  const parsed = parseFloat(price)
  if (Number.isNaN(parsed) || parsed <= 0) return undefined
  return parsed * 1e6
}

/**
 * Derive the family from a model id, e.g. `anthropic/claude-3-opus` -> `claude`.
 *
 * @param {string} modelId
 * @returns {string | undefined}
 */
function extractFamily(modelId) {
  const parts = modelId.split('/')
  return parts.length > 1 ? parts[1] : undefined
}

/**
 * Map an OpenRouter modality list onto the harness vocabulary, always including text.
 *
 * @param {string[]} modalities
 * @returns {string[]}
 */
function mapModalities(modalities) {
  /** @type {string[]} */
  const result = []
  for (const modality of modalities) {
    if (modality === 'text') result.push('text')
    if (modality === 'image') result.push('image')
    if (modality === 'audio') result.push('audio')
    if (modality === 'video') result.push('video')
    if (modality === 'pdf') result.push('pdf')
  }
  if (!result.includes('text')) result.unshift('text')
  return result
}

/** @typedef {{ id: string; name: string; description?: string; context_length: number; max_completion_tokens?: number | null; pricing?: { prompt?: string | null; completion?: string | null; input_cache_write?: string | null; input_cache_read?: string | null }; architecture?: { input_modalities?: string[] | null; output_modalities?: string[] | null; tokenizer?: string | null }; top_provider?: { max_completion_tokens?: number | null }; supported_parameters?: string[]; preferredIndex?: number; isFree?: boolean; mayTrainOnYourPrompts?: boolean; hasUserByokAvailable?: boolean; opencode?: { family?: string; prompt?: string; variants?: Record<string, unknown>; ai_sdk_provider?: string } }} OpenRouterModel */

/**
 * Shared raw fetch and validation used by the catalog and image-model queries.
 *
 * @param {{ kilocodeToken?: string; kilocodeOrganizationId?: string; baseURL?: string }} [options]
 * @returns {Promise<{ data: OpenRouterModel[] } | { error: { kind: string; status?: number; retryAfter?: number } }>}
 */
async function fetchRawKiloModels(options = {}) {
  const token = options.kilocodeToken
  const organizationId = options.kilocodeOrganizationId

  const defaultBaseURL = organizationId
    ? resolveKiloGatewayUrl(`organizations/${organizationId}`)
    : resolveKiloOpenRouterBaseUrl()

  const baseURL = options.baseURL ?? defaultBaseURL
  const finalBaseURL = token ? getKiloUrlFromToken(baseURL, token) : baseURL
  const modelsURL = `${finalBaseURL}/models`

  const response = await fetch(modelsURL, {
    headers: {
      ...getDefaultHeaders(),
      ...buildKiloHeaders(undefined, { kilocodeOrganizationId: organizationId }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  }).catch((error) => error)

  if (response instanceof Error) return { error: { kind: 'network' } }

  if (!response.ok) {
    // An anonymous 401 against the organization route retries once anonymously.
    if (response.status === 401 && token && !organizationId && !finalBaseURL.includes('/organizations/')) {
      return fetchRawKiloModels({})
    }
    const kind = response.status === 401 || response.status === 403 ? 'unauthorized' : 'http'
    const header = response.headers.get('retry-after')
    const seconds =
      header == null ? Number.NaN : /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000
    const retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds) : undefined
    return { error: { kind, status: response.status, ...(retryAfter == null ? {} : { retryAfter }) } }
  }

  const json = await response.json().catch(() => null)
  if (json === null || typeof json !== 'object' || !Array.isArray(json.data)) {
    return { error: { kind: 'schema' } }
  }

  return { data: /** @type {OpenRouterModel[]} */ (json.data) }
}

/**
 * Fetch and validate the Kilo model catalog.
 *
 * @param {{ kilocodeToken?: string; kilocodeOrganizationId?: string; baseURL?: string }} [options]
 * @returns {Promise<{ models: OpenRouterModel[]; error?: { kind: string; status?: number } }>}
 */
export async function fetchKiloModels(options = {}) {
  const raw = await fetchRawKiloModels(options)
  if ('error' in raw) return { models: [], error: raw.error }
  return { models: raw.data.filter((model) => typeof model?.id === 'string' && typeof model?.name === 'string') }
}

/**
 * Fetch the models whose output modalities include `image`.
 *
 * @param {{ kilocodeToken?: string; kilocodeOrganizationId?: string; baseURL?: string }} [options]
 * @returns {Promise<{ models: { id: string; name: string; description?: string }[]; error?: { kind: string } }>}
 */
export async function fetchKiloImageModels(options = {}) {
  const raw = await fetchRawKiloModels(options)
  if ('error' in raw) return { models: [], error: raw.error }
  return {
    models: raw.data
      .filter((model) => model.architecture?.output_modalities?.includes('image'))
      .map((model) => ({ id: model.id, name: model.name, ...(model.description ? { description: model.description } : {}) })),
  }
}

/**
 * Describe one catalog entry as harness model metadata.
 *
 * @param {OpenRouterModel} model
 * @returns {{ provider: string; id: string; name: string; description?: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[]; supportsTools: boolean }}
 */
export function describeModel(model) {
  const inputModalities = model.architecture?.input_modalities ?? []
  const outputModalities = model.architecture?.output_modalities ?? []
  const inputPrice = parseApiPrice(model.pricing?.prompt)
  const outputPrice = parseApiPrice(model.pricing?.completion)
  const maxOutputTokens =
    model.top_provider?.max_completion_tokens || model.max_completion_tokens || Math.ceil(model.context_length * 0.2)

  return {
    id: model.id,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    family: model.opencode?.family ?? extractFamily(model.id),
    contextWindow: model.context_length,
    maxTokens: maxOutputTokens,
    supportsTools: supportsTools(model),
    inputModalities: inputModalities.length > 0 || outputModalities.length > 0 ? mapModalities(inputModalities) : ['text'],
    supportsImages: inputModalities.includes('image'),
    supportsReasoning: (model.supported_parameters ?? []).includes('reasoning'),
    // `isFree` is the catalog's own signal; the `:free` suffix and the free auto-router are
    // equivalent markers, and anonymous access depends on recognising all three.
    isFree: model.isFree === true || isFreeModelId(model.id),
    ...(inputPrice !== undefined && outputPrice !== undefined
      ? { cost: { input: inputPrice, output: outputPrice } }
      : {}),
  }
}
