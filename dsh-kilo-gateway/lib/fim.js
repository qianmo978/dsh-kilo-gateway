/**
 * Kilo fill-in-the-middle and Next Edit endpoints.
 *
 * Ported from `packages/kilo-gateway/src/autocomplete.ts` and `src/fim.ts`.
 *
 * These back code completion, not chat: the harness has no FIM seam today, so this module is
 * exposed as an agent tool rather than wired into an editor.
 */

/** Autocomplete model catalogue. Kilo is the default; the others are direct BYOK routes. */
export const AUTOCOMPLETE_MODELS = Object.freeze([
  {
    id: 'kilo/mistralai/codestral-2508',
    modelID: 'mistralai/codestral-2508',
    label: 'Codestral',
    providerID: 'kilo',
    provider: 'Kilo Gateway',
    requestModel: 'mistralai/codestral-2508',
    temperature: 0.2,
  },
  {
    id: 'kilo/inception/mercury-edit-2',
    modelID: 'inception/mercury-edit-2',
    label: 'Mercury Edit 2 (FIM)',
    providerID: 'kilo',
    provider: 'Kilo Gateway',
    requestModel: 'inception/mercury-edit-2',
    temperature: 0,
  },
  {
    id: 'kilo/inception/mercury-next-edit',
    modelID: 'inception/mercury-next-edit',
    label: 'Mercury Edit 2 (Next Edit)',
    providerID: 'kilo',
    provider: 'Kilo Gateway',
    // The wire model is the edit model; only the route differs.
    requestModel: 'inception/mercury-edit-2',
    temperature: 0,
    kind: 'edit',
  },
  {
    id: 'mistral/codestral-2508',
    modelID: 'codestral-2508',
    label: 'Codestral',
    providerID: 'mistral',
    provider: 'Mistral',
    requestModel: 'codestral-2508',
    directProvider: 'mistral',
    temperature: 0.2,
  },
  {
    id: 'inception/mercury-edit-2',
    modelID: 'mercury-edit-2',
    label: 'Mercury Edit 2 (FIM)',
    providerID: 'inception',
    provider: 'Inception',
    requestModel: 'mercury-edit-2',
    directProvider: 'inception',
    temperature: 0,
  },
])

/** Default autocomplete provider: Kilo Gateway. */
export const DEFAULT_AUTOCOMPLETE_PROVIDER_ID = 'kilo'

/** Default autocomplete model. */
export const DEFAULT_AUTOCOMPLETE_MODEL_ID = 'inception/mercury-next-edit'

/** Legacy model ids kept resolvable so old settings do not silently reroute. */
const MODEL_ALIASES = Object.freeze({
  'inception/mercury-edit': 'inception/mercury-edit-2',
})

/**
 * The default autocomplete model definition.
 *
 * @returns {typeof AUTOCOMPLETE_MODELS[number]}
 */
export function defaultAutocompleteModel() {
  const found = AUTOCOMPLETE_MODELS.find(
    (model) => model.providerID === DEFAULT_AUTOCOMPLETE_PROVIDER_ID && model.modelID === DEFAULT_AUTOCOMPLETE_MODEL_ID,
  )
  if (found === undefined) {
    throw new Error(`default autocomplete model not found: ${DEFAULT_AUTOCOMPLETE_PROVIDER_ID}/${DEFAULT_AUTOCOMPLETE_MODEL_ID}`)
  }
  return found
}

/**
 * Resolve an autocomplete model by provider and model id.
 *
 * Direct-provider use must be opted into explicitly, never inferred from a model name: the
 * same plain model id can exist on several providers.
 *
 * @param {string} [provider]
 * @param {string} [model]
 * @returns {typeof AUTOCOMPLETE_MODELS[number]}
 */
export function getAutocompleteModel(provider, model) {
  const providerId = provider ?? DEFAULT_AUTOCOMPLETE_PROVIDER_ID
  const modelId = MODEL_ALIASES[model ?? ''] ?? model
  for (const candidate of AUTOCOMPLETE_MODELS) {
    if (candidate.providerID === providerId && candidate.modelID === modelId) return candidate
  }
  return defaultAutocompleteModel()
}

/**
 * Resolve an autocomplete model by its stable composite id.
 *
 * @param {string} id
 * @returns {typeof AUTOCOMPLETE_MODELS[number]}
 */
export function getAutocompleteModelById(id) {
  for (const candidate of AUTOCOMPLETE_MODELS) {
    if (candidate.id === id) return candidate
  }
  return defaultAutocompleteModel()
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function validAutocompleteProvider(value) {
  return typeof value === 'string' && AUTOCOMPLETE_MODELS.some((model) => model.providerID === value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function validAutocompleteModel(value) {
  if (typeof value !== 'string') return false
  return AUTOCOMPLETE_MODELS.some((model) => model.modelID === (MODEL_ALIASES[value] ?? value))
}

/**
 * Issue one FIM or Next Edit completion against the Kilo Gateway.
 *
 * @param {{
 *   prompt: string;
 *   suffix?: string;
 *   model?: string;
 *   kind?: 'fim' | 'edit';
 *   maxTokens?: number;
 *   token?: string;
 *   organizationId?: string;
 *   signal?: AbortSignal;
 *   gatewayBase: string;
 *   headers: (token?: string, organizationId?: string) => Record<string, string>;
 *   fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<{ completion: string; model: string; kind: string }>}
 */
export async function requestCompletion(options) {
  const doFetch = options.fetchImpl ?? fetch
  // Only Kilo-hosted models are routable here; the caller refuses the direct BYOK ones.
  const definition = getAutocompleteModel('kilo', options.model)
  const kind = options.kind ?? (definition.kind === 'edit' ? 'edit' : 'fim')
  const path = kind === 'edit' ? 'edit' : 'fim/completions'
  const url = `${options.gatewayBase.replace(/\/+$/, '')}/${path}`

  // Both routes take the same body: `prompt` is the text before the cursor and `suffix` the
  // text after it. Next Edit additionally reads an instruction, which the caller supplies
  // through `prompt`.
  const body = {
    model: definition.requestModel,
    prompt: options.prompt,
    ...(options.suffix === undefined ? {} : { suffix: options.suffix }),
    temperature: definition.temperature,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
  }

  const response = await doFetch(url, {
    method: 'POST',
    headers: { ...options.headers(options.token, options.organizationId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: options.signal,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Kilo ${kind} request failed (${response.status}): ${text.slice(0, 300)}`)
  }

  /** @type {any} */
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Kilo returned a malformed completion response.')
  }

  // FIM returns `choices[0].text`; Next Edit returns `choices[0].delta.content` or `text`.
  const choice = payload?.choices?.[0]
  const completion = choice?.text ?? choice?.delta?.content ?? choice?.message?.content ?? ''
  return {
    completion: typeof completion === 'string' ? completion : '',
    model: definition.requestModel,
    kind,
  }
}
