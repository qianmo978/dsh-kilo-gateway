/**
 * Kilo Gateway LLM adapter.
 *
 * Registers the `kilo` provider route on `ctx.llm` and speaks the OpenRouter-compatible
 * wire protocol that `ai-gateway.kilo.ai/api/openrouter` exposes, translating it into
 * the harness `StreamChunk` vocabulary.
 *
 * The adapter deliberately does **not** import `@deepseek-ai/dsh-llm`. A bundle resolves
 * its peer dependencies to its own copies, so `Service`/`Context.is()` identity would not
 * match the ones the Loader is running, and the registration would be rejected. `ctx.llm`
 * is duck-typed instead, which is exactly what the Loader calls it through.
 */

import { ANONYMOUS_API_KEY, MODEL_CATALOG_TTL_MS, MODELS_FETCH_TIMEOUT_MS } from './constants.js'
import { resolveKiloOpenRouterBaseUrl } from './url.js'
import { getDefaultHeaders, buildKiloHeaders, mergeHeaders } from './headers.js'
import { fetchKiloModels, describeModel, supportsTools } from './models.js'
import { reportTokenRejected, resolveAuth } from './token-store.js'
import { estimateRequestTokens, isFreeModel, limitsOf } from './limits.js'
import {
  applyRepair,
  classifyEmptyStream,
  classifyHttp,
  classifyTransportError,
  planRecovery,
  repairBudget,
  retryDelayMs,
} from './resilience.js'

/** The single provider route this adapter owns. */
export const KILO_PROVIDER = 'kilo'

/** Longest time a single streaming request may stay open. */
const STREAM_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Longest a stream may go without delivering a single byte before it counts as stalled.
 *
 * A dead TCP connection can otherwise hold the request open until `STREAM_TIMEOUT_MS` with no
 * output at all, which reads to the user as a ten-minute freeze. Kilo's own idle budget is well under
 * a minute, so this only fires on a genuinely wedged stream.
 */
const STREAM_IDLE_TIMEOUT_MS = 90 * 1000

/**
 * Block-index bands for one streamed completion. OpenAI reuses `choices[0].index` for every
 * delta kind, so reasoning, answer text, and each tool call need distinct, non-overlapping
 * indices for the harness assembler to keep them apart.
 */
const REASONING_BLOCK_INDEX = 0
const TEXT_BLOCK_INDEX = 1000
const TOOL_BLOCK_INDEX = 100000

/**
 * An error carrying a stable provider-neutral code the harness routes on.
 *
 * Structured as a plain `Error` with `name`/`code` so the harness normalizes it the same way
 * it normalizes its own `HarnessError`, without needing that class identity.
 */
export class KiloLlmError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ status?: number; cause?: unknown }} [options]
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KiloLlmError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
  }
}

/**
 * The retry policy this route exposes.
 *
 * `@deepseek-ai/dsh-llm`'s `resolveRetryPolicy` returns a **flat** policy — its
 * `...resolveBackoff(config.backoff, …)` spread puts `initialDelayMs` / `maxDelayMs` /
 * `jitterRatio` at the top level, not under `backoff` — and `@deepseek-ai/dsh-llm-retry` reads
 * that same flat object on `agent/request-error`, calling
 * `policy.retryableCodes.includes(failure.code)`. So the flat form with a populated
 * `retryableCodes` is the only shape both consumers accept.
 *
 * Values are the harness defaults from `resolveRetryPolicy(undefined, …)`. `MALFORMED_RESPONSE` is
 * deliberately absent: the provider billed output it never sent, so replaying spends the same money
 * for the same empty result.
 */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

/**
 * Read an SSE body and yield each `data:` payload, excluding the `[DONE]` sentinel.
 *
 * Parsed line by line rather than by splitting on a blank-line boundary, because SSE permits
 * `\n`, `\r\n`, or `\r` as the line terminator and a naive `indexOf('\n\n')` misses every frame in
 * a stream that uses CRLF. A frame is terminated by an empty line; consecutive `data:` lines are
 * concatenated with `\n` per the SSE spec.
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @returns {AsyncGenerator<string>}
 */
async function* readSseEvents(body) {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** @type {string[]} */
  let dataLines = []

  const flushFrame = () => {
    if (dataLines.length === 0) return undefined
    const payload = dataLines.join('\n').trim()
    dataLines = []
    return payload.length > 0 && payload !== '[DONE]' ? payload : undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Normalize terminators, then consume only complete lines; the tail stays buffered so a
      // frame split across chunk boundaries is never parsed half-formed.
      buffer = buffer.replace(/\r\n?/g, '\n')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)

        if (line === '') {
          const payload = flushFrame()
          if (payload !== undefined) yield payload
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        // Comments (`:`) and other fields (event:, id:, retry:) are not needed here.

        newline = buffer.indexOf('\n')
      }
    }

    // A stream may end without its terminating blank line; flush what was collected.
    buffer = buffer.replace(/\r\n?/g, '\n')
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''))
    const tail = flushFrame()
    if (tail !== undefined) yield tail
  } finally {
    reader.releaseLock?.()
  }
}

/**
 * Flatten content blocks into plain text.
 *
 * @param {readonly any[]} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' || block.type === 'reasoning' ? block.text : ''))
    .join('')
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  const chunks = []
  const size = 0x8000
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + size)))
  }
  return btoa(chunks.join(''))
}

/**
 * Render an image attachment as a base64 data URL.
 *
 * The harness normalizes images into request versions before dispatch; when a model is
 * text-only the caller's own projection has already replaced the block with placeholder text,
 * so this path only ever sees an image the model can actually accept.
 *
 * @param {Record<string, any>} attachment
 * @returns {string}
 */
function imageDataUrl(attachment) {
  const version = attachment.version ?? attachment
  const bytes = version.data ?? version.bytes
  const mediaType = version.mediaType ?? attachment.mediaType ?? 'image/png'
  if (bytes instanceof Uint8Array) return `data:${mediaType};base64,${bytesToBase64(bytes)}`
  if (typeof bytes === 'string') {
    return bytes.startsWith('data:') ? bytes : `data:${mediaType};base64,${bytes}`
  }
  if (typeof attachment.dataUrl === 'string') return attachment.dataUrl
  return ''
}

/**
 * Convert a harness message list into OpenAI chat-completion messages.
 *
 * @param {readonly any[]} messages
 * @returns {unknown[]}
 */
function toWireMessages(messages) {
  /** @type {unknown[]} */
  const wire = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer': {
        wire.push({ role: 'system', content: textOf(message.content) })
        break
      }
      case 'tool': {
        wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) })
        break
      }
      case 'assistant': {
        const blocks = Array.isArray(message.content) ? message.content : []
        const text = blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        const reasoning = blocks
          .filter((block) => block.type === 'reasoning')
          .map((block) => block.text)
          .join('')
        const toolCalls = blocks
          .filter((block) => block.type === 'tool-call')
          .map((block) => ({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.arguments },
          }))
        wire.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(reasoning.length > 0 ? { reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
        break
      }
      default: {
        const blocks = Array.isArray(message.content) ? message.content : []
        const parts = []
        for (const block of blocks) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            const url = imageDataUrl(block.attachment ?? {})
            if (url.length > 0) parts.push({ type: 'image_url', image_url: { url } })
            else parts.push({ type: 'text', text: '[image omitted: no readable request version]' })
          }
        }
        if (parts.length === 0) parts.push({ type: 'text', text: '' })
        wire.push({
          role: 'user',
          content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
        })
      }
    }
  }
  return wire
}

/**
 * Put the caller's system prompt at the head of the conversation.
 *
 * Only prepended when the message list does not already open with a system message, so a transcript
 * that carries its own instructions never gets a second, contradictory one.
 *
 * @param {string | undefined} system
 * @param {readonly any[]} messages
 * @returns {unknown[]}
 */
function prependSystem(system, messages) {
  if (typeof system !== 'string' || system.trim().length === 0) return messages
  if (messages[0]?.role === 'system') return messages
  return [{ role: 'system', content: system }, ...messages]
}

/**
 * Translate the harness tool declarations into OpenAI function tools.
 *
 * @param {readonly any[] | undefined} tools
 * @returns {unknown[] | undefined}
 */
function toWireTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

/**
 * Fold the tools declared mid-session into the set sent on the wire.
 *
 * `GenerateOptions` splits tools into the base `tools` and a `toolHistory` of per-message additions
 * and removals. Sending only the base set would make the request disagree with the transcript: the
 * model would see tool results for calls it was never offered, and would be unable to call a tool
 * added later in the session. Applying the history keeps the declared capability set exact.
 *
 * @param {readonly any[] | undefined} tools
 * @param {readonly { messageId: string; additions: readonly any[] }[] | undefined} toolHistory
 * @returns {unknown[] | undefined}
 */
function applyToolHistory(tools, toolHistory) {
  if (tools === undefined || toolHistory === undefined || toolHistory.length === 0) return toWireTools(tools)

  /** @type {Map<string, any>} */
  const byName = new Map()
  for (const tool of tools) {
    if (typeof tool?.name === 'string') byName.set(tool.name, tool)
  }
  for (const update of toolHistory) {
    for (const removal of update?.removals ?? []) {
      if (typeof removal?.toolName === 'string') byName.delete(removal.toolName)
    }
    for (const addition of update?.additions ?? []) {
      if (typeof addition?.name === 'string' && !byName.has(addition.name)) byName.set(addition.name, addition)
    }
  }
  return toWireTools([...byName.values()])
}

/**
 * Tracks which block indices a stream has opened, so `block-start` is emitted once each.
 *
 * The accumulated text is not bookkeeping: `block-end` carries the finished `ContentBlock`, so this
 * is the only place a completed answer, reasoning trace, or tool call actually comes into being. A
 * stream that never ends its blocks delivers nothing the agent loop can commit.
 */
class BlockTracker {
  constructor() {
    /** @type {Map<number, { kind: string; text: string; id?: string; name?: string }>} */
    this.blocks = new Map()
    /** Indices in the order they were first opened, so blocks end deterministically. */
    this.order = []
  }

  /** @param {number} index */
  has(index) {
    return this.blocks.has(index)
  }

  /**
   * Append text or tool-call arguments to a block, opening it on first use.
   *
   * @param {number} index
   * @param {'text' | 'reasoning' | 'tool-call'} kind
   * @param {string} delta
   * @param {{ id?: string; name?: string }} [identity]
   */
  append(index, kind, delta, identity) {
    let block = this.blocks.get(index)
    if (block === undefined) {
      block = { kind, text: '' }
      this.blocks.set(index, block)
      this.order.push(index)
    }
    if (identity?.id) block.id = identity.id
    if (identity?.name) block.name = identity.name
    block.text += delta
  }

  /**
   * Build the finished block for one index.
   *
   * @param {number} index
   * @returns {any}
   */
  blockOf(index) {
    const entry = this.blocks.get(index)
    if (entry === undefined) return undefined
    if (entry.kind === 'tool-call') {
      return {
        type: 'tool-call',
        // A provider that never sent an id still has to produce a valid branded id, so derive a
        // stable one from the index rather than emitting `undefined`.
        id: /** @type {any} */ (entry.id ?? `kilo-call-${index}`),
        name: entry.name ?? '',
        // Tool arguments are a JSON *string* on the wire; an incomplete stream would otherwise
        // commit malformed JSON as history.
        arguments: entry.text,
      }
    }
    return { type: entry.kind, text: entry.text }
  }

  /**
   * Close every open block, in the order it was opened.
   *
   * @returns {Generator<{ index: number; block: any }>}
   */
  *closeAll() {
    for (const index of this.order) {
      const block = this.blockOf(index)
      if (block !== undefined) yield { index, block }
    }
  }

  /**
   * Whether any tool call was opened. Used to stop retrying once a side effect may be in flight.
   *
   * @returns {boolean}
   */
  hasToolCall() {
    for (const entry of this.blocks.values()) {
      if (entry.kind === 'tool-call') return true
    }
    return false
  }
}

/**
 * The Kilo Gateway adapter.
 *
 * Token and organization are resolved per dispatch from the credential service, so a sign-in
 * or organization switch takes effect on the next request without re-registering the adapter.
 */
export class KiloGatewayAdapter {
  /**
   * @param {any} ctx
   * @param {{ apiKeyEnv?: string; baseURL?: string; organizationId?: string; repairBudget?: number; streamIdleTimeoutMs?: number }} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    /** Credential reference holding the API key, from the plugin's `apiKeyEnv` config. */
    this.apiKeyEnv = typeof options.apiKeyEnv === 'string' && options.apiKeyEnv.trim().length > 0
      ? options.apiKeyEnv.trim()
      : undefined
    /** Configured gateway base URL override, honoured on every dispatch. */
    this.baseURL = typeof options.baseURL === 'string' && options.baseURL.trim().length > 0
      ? options.baseURL.trim()
      : undefined
    /** Configured organization scope, which outranks the environment and the stored record. */
    this.organizationId = typeof options.organizationId === 'string' && options.organizationId.trim().length > 0
      ? options.organizationId.trim()
      : undefined
    /** Self-healing budget for one dispatch, from config. */
    this.repairBudget = typeof options.repairBudget === 'number' ? options.repairBudget : undefined
    /** Idle budget for one stream, from config. */
    this.streamIdleTimeoutMs =
      typeof options.streamIdleTimeoutMs === 'number' && options.streamIdleTimeoutMs > 0
        ? options.streamIdleTimeoutMs
        : STREAM_IDLE_TIMEOUT_MS
    /** @type {Map<string, ReturnType<typeof describeModel>>} */
    this.catalog = new Map()
    /** @type {Promise<void> | undefined} */
    this.catalogPromise = undefined
    /** When the current catalog expires; a live catalog is never refetched per dispatch. */
    this.catalogExpiresAt = 0
    this.retryPolicy = DEFAULT_RETRY_POLICY
    /** Cached anonymous-refusal, keyed by credential state so it is built once per situation. */
    this.blockedFor = undefined
    /** @type {(() => Error) | undefined} */
    this.blockedError = undefined
    /** The model of the dispatch in progress, used only to phrase an error message. */
    this.blockedModel = undefined
  }

  /**
   * @param {string} _provider
   * @returns {{ id: string; name: string }}
   */
  providerInfo(_provider) {
    return { id: KILO_PROVIDER, name: 'Kilo Gateway' }
  }

  /**
   * @param {string} _provider
   */
  providerRetryPolicy(_provider) {
    return this.retryPolicy
  }

  /**
   * Resolve the effective credential state for one dispatch.
   *
   * The managed store wins, honouring the configured `apiKeyEnv` reference so an existing
   * reference can be reused without copying the secret. Ambient variables layer underneath, and
   * with none of them the request goes out anonymous and reaches free models only.
   *
   * @returns {Promise<import('./token-store.js').KiloAuth>}
   */
  resolveAuth() {
    return resolveAuth(this.ctx, { ...(this.apiKeyEnv ? { apiKeyEnv: this.apiKeyEnv } : {}) })
  }

  /**
   * The credential plus the routing overrides that apply to every request from this adapter.
   *
   * Configured `organizationId` and `baseURL` win over the environment and the stored record, so a
   * profile that pins an organization does not silently drift with the ambient environment. Keeping
   * this in one place is what stops the catalog fetch, the headers, and the chat request from
   * disagreeing about which organization they are talking to.
   *
   * @returns {Promise<import('./token-store.js').KiloAuth>}
   */
  async effectiveAuth() {
    const auth = await this.resolveAuth()
    if (this.organizationId === undefined) return auth
    return { ...auth, organizationId: this.organizationId }
  }

  /**
   * Load the Kilo catalog, coalescing concurrent callers into one fetch.
   *
   * The catalog is cached with a TTL rather than fetched forever or per request: a long-running
   * session should not re-fetch ~400 model entries on every dispatch, but it should still notice a
   * newly published model. A failed refresh deliberately keeps the previous catalog, so a transient
   * gateway outage degrades to slightly stale metadata rather than to an empty model list.
   *
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<Map<string, ReturnType<typeof describeModel>>>}
   */
  async loadCatalog(options = {}) {
    const fresh = this.catalog.size > 0 && Date.now() < this.catalogExpiresAt
    if (fresh && options.force !== true) return this.catalog
    if (this.catalogPromise === undefined) {
      this.catalogPromise = (async () => {
        const auth = await this.effectiveAuth()
        const { models, error } = await fetchKiloModels({
          ...(auth.token ? { kilocodeToken: auth.token } : {}),
          ...(auth.organizationId ? { kilocodeOrganizationId: auth.organizationId } : {}),
          ...(this.baseURL ? { baseURL: this.baseURL } : {}),
        })
        if (error) {
          // A 401 here means the credential we just resolved is no longer accepted; suppressing it
          // lets the next dispatch fall through to a different source instead of failing again.
          if (error.kind === 'unauthorized') reportTokenRejected(this.ctx, auth.token, 'catalog rejected the credential')
          this.ctx?.logger?.warn?.('kilo-gateway: model catalog fetch failed', error)
          return
        }
        const next = new Map()
        for (const model of models) {
          // Kilo requires tool calling; hide models that explicitly opt out.
          if (!supportsTools(model)) continue
          next.set(model.id, describeModel(model))
        }
        if (next.size > 0) {
          this.catalog = next
          this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
        }
      })().finally(() => {
        this.catalogPromise = undefined
      })
    }
    await this.catalogPromise
    return this.catalog
  }

  /**
   * List the models Kilo advertises, narrowed to what the current credential can actually reach.
   *
   * Anonymous callers reach free models only, so offering the full 402-model catalog would just
   * produce a 401 on the first paid model selected.
   *
   * @param {string} provider
   */
  async listModels(provider) {
    const [catalog, auth] = await Promise.all([this.loadCatalog(), this.effectiveAuth()])
    const entries = [...catalog.values()]
    const usable = auth.anonymous ? entries.filter((model) => model.isFree === true) : entries
    return usable.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    }))
  }

  /**
   * The real limits of one model, from the live catalog.
   *
   * @param {string} model
   * @returns {Promise<import('./limits.js').ModelLimits>}
   */
  async limitsFor(model) {
    let catalog = this.catalog
    if (catalog.size === 0) {
      try {
        catalog = await this.loadCatalog()
      } catch {
        catalog = this.catalog
      }
    }
    const entry = catalog.get(model)
    if (entry === undefined) return limitsOf({ id: model })
    return limitsOf({
      id: model,
      context_length: entry.contextWindow,
      top_provider: { context_length: entry.contextWindow, max_completion_tokens: entry.maxTokens },
      isFree: entry.isFree,
    })
  }

  /**
   * Resolve metadata for one exact model.
   *
   * The runtime validates this shape strictly (`LlmRuntime.normalizeModelInfo`):
   * `provider` must equal the registered route, `id` must equal the requested model, `name` must
   * be non-empty, `context.contextWindow` must be a positive integer, and `defaultMaxTokens` must
   * be a positive safe integer. Anything else raises `INVALID_MODEL_INFO`,
   * `INVALID_MODEL_CONTEXT`, or `INVALID_MODEL_MAX_TOKENS`.
   *
   * An unknown id still resolves against the fallback window, because catalog membership is
   * advisory and Kilo accepts unlisted routes.
   *
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    let catalog = this.catalog
    if (catalog.size === 0) {
      try {
        catalog = await this.loadCatalog()
      } catch {
        catalog = this.catalog
      }
    }

    const entry = catalog.get(model)
    const limits = entry === undefined
      ? limitsOf({ id: model })
      : limitsOf({
          id: model,
          context_length: entry.contextWindow,
          top_provider: { context_length: entry.contextWindow, max_completion_tokens: entry.maxTokens },
          isFree: entry.isFree,
        })

    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.description ? { description: entry.description } : {}),
      inputModalities: entry?.inputModalities ?? ['text'],
      // Nested, and integral: the runtime rejects a float or a top-level `contextWindow`.
      context: { contextWindow: Math.max(1, Math.floor(limits.contextWindow)) },
      defaultMaxTokens: Math.max(1, Math.floor(limits.maxOutputTokens)),
    }
  }

  /**
   * Bind model metadata and dispatch to one adapter generation, so a settings change between
   * preparation and streaming cannot mix two endpoints.
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      /**
       * @param {any} options
       * @returns {AsyncIterable<any>}
       */
      stream: (options) => this.streamCall(options, model),
    }
  }

  /**
   * Build the wire request headers for one dispatch.
   *
   * @param {{ organizationId?: string }} auth
   * @param {string | undefined} token
   * @returns {Record<string, string>}
   */
  requestHeaders(auth, token) {
    return mergeHeaders(
      mergeHeaders(getDefaultHeaders(), { Accept: 'text/event-stream' }),
      mergeHeaders(buildKiloHeaders(undefined, { kilocodeOrganizationId: auth.organizationId }), {
        Authorization: `Bearer ${token ?? ANONYMOUS_API_KEY}`,
      }),
    )
  }

  /**
   * Execute one streaming chat completion, healing transient and repairable failures in place.
   *
   * One dispatch is up to `1 + repairBudget()` upstream attempts. The user is never told about a
   * recovered attempt: nothing is emitted on screen or surfaced to the agent unless every attempt
   * fails. A caller abort aborts immediately and is never retried.
   *
   * @param {any} options
   * @param {string} model
   * @returns {AsyncGenerator<any>}
   */
  async *streamCall(options, model) {
    this.blockedModel = model
    const limits = await this.limitsFor(model)
    if (limits.isFree === false) {
      const blocked = await this.credentialBlocked()
      if (blocked !== undefined) throw blocked()
    }

    /** How many repair-and-replay rounds this dispatch may spend. */
    const budget = repairBudget(
      this.repairBudget === undefined ? undefined : { repairBudget: this.repairBudget },
    )
    let request = {
      // `GenerateOptions.system` is carried alongside the messages rather than inside them, so a
      // caller that only sets it would otherwise send an instruction-free request.
      messages: prependSystem(options.system, toWireMessages(options.messages ?? [])),
      tools: applyToolHistory(options.tools, options.toolHistory),
    }

    /** @type {{ kind: string; code: string; retryable: boolean; repair?: string }} */
    let last = { kind: 'stream', code: 'UNKNOWN', retryable: false }
    let attempt = 0

    while (attempt <= budget) {
      const outcome = yield* this.attemptStream(options, model, limits, request, attempt)

      if (outcome.done) return
      last = outcome.classification

      // The caller cancelled. That is a decision, not a fault: rethrow the caller's own error so
      // the harness sees a cancellation rather than a mislabelled gateway failure.
      if (outcome.aborted) {
        throw outcome.error ?? new KiloLlmError('The Kilo Gateway request was cancelled.', 'ABORTED')
      }

      const plan = planRecovery(outcome.classification, outcome)
      if (!plan.retry) throw this.toLlmError(outcome.classification, outcome.detail)

      // A rejected credential is demoted so the *next* dispatch reaches a different source instead
      // of failing identically forever.
      if (outcome.classification.kind === 'auth') {
        reportTokenRejected(this.ctx, outcome.authToken, outcome.detail ?? 'gateway rejected the credential')
      }

      if (outcome.classification.repair !== undefined) {
        const repaired = applyRepair(request, outcome.classification.repair)
        request = { messages: repaired.messages, tools: repaired.tools }
        this.ctx?.logger?.warn?.(
          `kilo-gateway: repaired the request for "${model}" (dropped ${repaired.dropped}) after ${outcome.classification.code}`,
        )
      }

      attempt += 1
      if (attempt > budget) break
      await sleep(retryDelayMs(attempt - 1, this.retryPolicy), options.signal)
    }

    throw this.toLlmError(last, undefined)
  }

  /**
   * The credential refusal for a non-free model, cached per credential state so an anonymous session
   * does not pay a credentials round trip on every turn to rediscover the same missing key.
   *
   * @returns {Promise<(() => Error) | undefined>}
   */
  async credentialBlocked() {
    const auth = await this.effectiveAuth()
    if (!auth.anonymous) {
      this.blockedFor = undefined
      return undefined
    }
    if (this.blockedFor === `anonymous:${auth.organizationId ?? ''}`) return this.blockedError
    this.blockedFor = `anonymous:${auth.organizationId ?? ''}`
    this.blockedError = () =>
      new KiloLlmError(
        `"${this.blockedModel}" is not a free model, and the request has no Kilo credential. ` +
          'Enter a Kilo Gateway API key in Models settings, sign in with the Kilo Gateway device flow, ' +
          'or choose a free model (a ":free" id or kilo-auto/free).',
        'AUTH',
      )
    return this.blockedError
  }

  /**
   * Turn one exhausted failure into the harness-facing error.
   *
   * The message states what happened rather than what was tried, because by this point every
   * recoverable attempt has already been spent.
   *
   * @param {{ kind: string; code: string; retryable: boolean; repair?: string }} classification
   * @param {string | undefined} [detail]
   * @returns {KiloLlmError}
   */
  toLlmError(classification, detail) {
    const suffix = detail === undefined || detail.length === 0 ? '' : `: ${detail.slice(0, 500)}`
    switch (classification.kind) {
      case 'auth':
        return new KiloLlmError(
          `Kilo Gateway rejected the stored credential. Sign in again from the account page, or replace the key in Models settings.${suffix}`,
          'AUTH',
        )
      case 'quota':
        return new KiloLlmError(`Kilo Gateway reports no available credit.${suffix}`, 'QUOTA')
      case 'rate_limit':
        return new KiloLlmError(`Kilo Gateway rate limit reached; the request was retried and still failed.${suffix}`, 'RATE_LIMIT')
      case 'parameter':
        return new KiloLlmError(
          `Kilo Gateway rejected the request for "${this.blockedModel ?? ''}" and it could not be repaired automatically.${suffix}`,
          classification.code,
        )
      default:
        return new KiloLlmError(`Kilo Gateway stream failed after retries.${suffix}`, classification.code)
    }
  }

  /**
   * One upstream attempt.
   *
   * Yields live chunks as they arrive and *returns* a disposition rather than throwing, so the
   * caller decides whether to replay without having already torn the stream down.
   *
   * @param {any} options
   * @param {string} model
   * @param {import('./limits.js').ModelLimits} limits
   * @param {{ messages: unknown[]; tools?: unknown[] }} request
   * @param {number} attempt zero-based attempt index
   * @returns {AsyncGenerator<any>}
   */
  async *attemptStream(options, model, limits, request, attempt) {
    const auth = await this.effectiveAuth()

    if (auth.anonymous && !limits.isFree) {
      return disposition({ classification: { kind: 'auth', code: 'AUTH', retryable: false } })
    }

    const estimatedInputTokens = estimateRequestTokens(request)
    if (estimatedInputTokens >= limits.contextWindow) {
      // Deterministic and unrepairable by trimming: the harness itself produced an oversized
      // request, so only compaction or a larger window can fix it.
      return disposition({
        classification: { kind: 'parameter', code: 'CONTEXT_WINDOW_EXCEEDED', retryable: false },
        detail: `the assembled request is about ${estimatedInputTokens.toLocaleString()} tokens and "${model}" accepts ${limits.contextWindow.toLocaleString()}`,
      })
    }

    const baseURL = resolveKiloOpenRouterBaseUrl({
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(auth.token ? { token: auth.token } : {}),
    })

    // Output budget: the caller's request, else the model's own cap, never beyond what the remaining
    // room allows. The harness already reserved `defaultMaxTokens` while compacting, so this only
    // ever trims a request that would not fit.
    const remaining = limits.contextWindow - estimatedInputTokens
    const requested = positiveNumber(options.maxTokens) ? options.maxTokens : limits.maxOutputTokens
    const maxTokens = Math.max(1, Math.min(requested, limits.maxOutputTokens, remaining))

    /** @type {Record<string, unknown>} */
    const body = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: request.messages,
      max_tokens: maxTokens,
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined) body.stop = options.stop
    if (options.reasoningEffort !== undefined) body.reasoning = { effort: options.reasoningEffort }
    if (request.tools) body.tools = request.tools

    // The caller's signal when there is one, plus an idle watchdog either way: a wedged connection
    // must not hold the request open until the hard ceiling with nothing on screen.
    const watchdog = withIdleWatchdog(this.streamIdleTimeoutMs)
    const signal = combineSignals(options.signal, watchdog.signal)

    let response
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.requestHeaders(auth, auth.token),
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      })
    } catch (error) {
      watchdog.dispose()
      if (options.signal?.aborted) {
        // The caller's own cancellation wins over the transport error that happened to surface
        // alongside it, so the harness sees why the request actually stopped.
        return disposition({
          classification: classifyTransportError(error),
          aborted: true,
          error: options.signal.reason ?? error,
        })
      }
      // The gateway never accepted the body, so replaying it unchanged is safe.
      return disposition({ classification: classifyTransportError(error), detail: messageOf(error) })
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      watchdog.dispose()
      const classification = classifyHttp(response.status, detail || response.statusText)
      return disposition({ classification, authToken: auth.token, detail: `HTTP ${response.status} ${detail.slice(0, 300)}`.trim() })
    }

    const tracker = new BlockTracker()
    let emitted = 0
    /** Whether any reasoning arrived, so a truncated reasoning-only turn reports `max-tokens`. */
    let sawReasoning = false
    /** The provider's terminal reason, recorded rather than acted on until the stream truly ends. */
    let finishReason
    /** @type {{ inputTokens: number; outputTokens: number; reasoningTokens?: number } | undefined} */
    let usage

    try {
      for await (const payload of readSseEvents(response.body)) {
        watchdog.touch()

        /** @type {Record<string, any>} */
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          // One unparsable frame is not a reason to lose the stream: skip it and keep reading, since
          // the next frame usually restores the sequence.
          continue
        }

        // The gateway can carry a provider error *inside* an otherwise-OK 200 response.
        if (event.error) {
          const message = String(event.error?.message ?? event.error ?? 'stream error')
          return disposition({
            classification: classifyHttp(event.error?.code === 429 ? 429 : 500, message),
            emitted: emitted > 0,
            hasToolCall: tracker.hasToolCall(),
            outputTokens: usage?.outputTokens ?? 0,
            authToken: auth.token,
            detail: message,
          })
        }

        if (event.usage !== undefined && event.usage !== null) {
          const input = numberOr(event.usage.prompt_tokens, 0)
          const output = numberOr(event.usage.completion_tokens, 0)
          const reasoning = numberOr(event.usage.completion_tokens_details?.reasoning_tokens, 0)
          usage = { inputTokens: input, outputTokens: output, ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}) }
          continue
        }

        const choice = event.choices?.[0]
        if (choice === undefined) continue

        if (choice.finish_reason) {
          // OpenRouter-compatible streams commonly send the terminal `finish_reason` *before* the
          // usage frame, so ending here would drop the accounting for every such response. The
          // terminal reason is therefore recorded and the loop keeps reading until the stream ends
          // or `[DONE]`, at which point blocks, usage, and finish are emitted in contract order.
          finishReason = finishKind(choice.finish_reason)
          continue
        }

        const delta = choice.delta ?? {}
        const choiceIndex = typeof choice.index === 'number' ? choice.index : 0

        // Kilo sends reasoning twice: a plain `reasoning` string and a structured `reasoning_details`
        // array. Prefer the string, but fall back to the structured text so a provider that only
        // populates `reasoning_details` still yields a readable block.
        const reasoningText =
          typeof delta.reasoning === 'string' && delta.reasoning.length > 0
            ? delta.reasoning
            : reasoningTextOf(delta.reasoning_details)

        if (reasoningText.length > 0) {
          const index = REASONING_BLOCK_INDEX + choiceIndex
          if (!tracker.has(index)) yield { type: 'block-start', index, blockType: 'reasoning' }
          tracker.append(index, 'reasoning', reasoningText)
          yield { type: 'reasoning-delta', index, text: reasoningText }
          sawReasoning = true
          emitted += 1
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          const index = TEXT_BLOCK_INDEX + choiceIndex
          if (!tracker.has(index)) yield { type: 'block-start', index, blockType: 'text' }
          tracker.append(index, 'text', delta.content)
          yield { type: 'text-delta', index, text: delta.content }
          emitted += 1
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const [position, call] of delta.tool_calls.entries()) {
            const index = TOOL_BLOCK_INDEX + (typeof call.index === 'number' ? call.index : position)
            const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
            if (argumentsDelta.length === 0 && !call.id && !call.function?.name) continue
            if (!tracker.has(index)) yield { type: 'block-start', index, blockType: 'tool-call' }
            tracker.append(index, 'tool-call', argumentsDelta, {
              ...(call.id ? { id: call.id } : {}),
              ...(call.function?.name ? { name: call.function.name } : {}),
            })
            yield {
              type: 'tool-call-delta',
              index,
              ...(call.id ? { id: call.id } : {}),
              ...(call.function?.name ? { name: call.function.name } : {}),
              argumentsDelta,
            }
            emitted += 1
          }
        }
      }
    } catch (error) {
      // A dead socket mid-stream. Whatever arrived is already on screen, so this attempt ends as a
      // partial answer rather than a hard failure.
      for (const closed of tracker.closeAll()) {
        yield { type: 'block-end', index: closed.index, block: closed.block }
      }
      const classification = classifyTransportError(error)
      const sawContent = emitted > 0
      const outcome = disposition({
        classification,
        emitted: sawContent,
        hasToolCall: tracker.hasToolCall(),
        outputTokens: usage?.outputTokens ?? 0,
        // Resuming would need the upstream continuation Kilo does not expose, so a partial answer is
        // kept rather than replayed into duplicated text.
        canResume: false,
        detail: messageOf(error),
      })
      // A caller cancel can surface here too: the watchdog and the caller's signal share one
      // combined signal, so the fetch rejects whichever fired first.
      if (options.signal?.aborted === true) {
        outcome.aborted = true
        outcome.error = options.signal.reason ?? error
      } else {
        outcome.error = error
      }
      return outcome
    } finally {
      watchdog.dispose()
    }

    // The stream has ended, either normally or without ever reporting a terminal reason.
    for (const closed of tracker.closeAll()) {
      yield { type: 'block-end', index: closed.index, block: closed.block }
    }

    if (emitted > 0) {
      // `finishReason` is what the provider reported; when it sent none, a reasoning-only turn cut
      // off by `max_tokens` is a real outcome rather than a defect, so the truncation is reported
      // honestly instead of being disguised as a clean stop.
      if (usage !== undefined) {
        yield { type: 'usage', usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } }
      }
      yield { type: 'finish', reason: { kind: finishReason ?? (sawReasoning ? 'max-tokens' : 'stop') } }
      return disposition({ done: true, classification: OK })
    }

    const classification = classifyEmptyStream({ outputTokens: usage?.outputTokens ?? 0 })
    return disposition({
      classification,
      outputTokens: usage?.outputTokens ?? 0,
      detail:
        classification.code === 'MALFORMED_RESPONSE'
          ? 'output tokens were billed but no readable content arrived'
          : 'the stream closed with no content',
    })
  }
}

/** The disposition of a successful attempt. */
const OK = Object.freeze({ kind: 'stream', code: 'OK', retryable: false })

/**
 * Build one attempt disposition with the fields every caller of `planRecovery` reads.
 *
 * @param {{ classification: { kind: string; code: string; retryable: boolean; repair?: string }, done?: boolean, aborted?: boolean, emitted?: boolean, hasToolCall?: boolean, canResume?: boolean, outputTokens?: number, authToken?: string, detail?: string, error?: unknown }} fields
 */
function disposition(fields) {
  return {
    done: false,
    aborted: false,
    emitted: false,
    hasToolCall: false,
    canResume: false,
    outputTokens: 0,
    authToken: undefined,
    detail: undefined,
    error: undefined,
    ...fields,
  }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Extract readable text from an OpenAI-style `reasoning_details` array.
 *
 * Kilo emits `{ type: 'reasoning.text', text }` entries alongside an encrypted
 * `{ type: 'reasoning.encrypted', data }` entry that carries no readable payload. Only the
 * readable variants contribute.
 *
 * @param {unknown} details
 * @returns {string}
 */
function reasoningTextOf(details) {
  if (!Array.isArray(details)) return ''
  let text = ''
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.text === 'string' && entry.text.length > 0) text += entry.text
  }
  return text
}

/**
 * Sleep that rejects as soon as the caller aborts, so a retry in progress never outlives a cancel.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * An abort signal that fires when a stream goes quiet for longer than `idleMs`.
 *
 * A hung TCP connection would otherwise hold the request open until the hard ceiling with nothing
 * on screen, which reads to the user as a long freeze rather than a retry. `touch()` is called for
 * every chunk that arrives.
 *
 * @param {number} idleMs
 */
function withIdleWatchdog(idleMs) {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(new Error('stream idle timeout')), idleMs)
  return {
    signal: controller.signal,
    touch() {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new Error('stream idle timeout')), idleMs)
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}

/**
 * Combine the caller's cancellation with this request's own watchdog, so aborting either stops the
 * fetch.
 *
 * @param {AbortSignal | undefined} caller
 * @param {AbortSignal} own
 * @returns {AbortSignal}
 */
function combineSignals(caller, own) {
  if (caller === undefined) return own
  const controller = new AbortController()
  const abort = (reason) => controller.abort(reason)
  // Abort first when the caller has already cancelled, so an already-aborted signal is never
  // forwarded as a live one.
  if (caller.aborted) {
    abort(caller.reason)
    return controller.signal
  }
  caller.addEventListener('abort', () => abort(caller.reason), { once: true })
  own.addEventListener('abort', () => abort(own.reason), { once: true })
  // The caller may have cancelled between the check above and the listener attaching.
  if (caller.aborted) abort(caller.reason)
  return controller.signal
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Map an OpenAI `finish_reason` onto the harness finish vocabulary.
 *
 * @param {string} reason
 * @returns {string}
 */
function finishKind(reason) {
  switch (reason) {
    case 'length':
      return 'max-tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'stop'
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
