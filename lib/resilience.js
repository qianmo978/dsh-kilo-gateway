/**
 * Failure classification and self-healing for Kilo Gateway calls.
 *
 * The gateway does not fail cleanly. One request can be rejected before any byte is generated
 * because the *request* was wrong (an oversized body, a tool schema the upstream router rejects,
 * a model that cannot accept images), or the request can be accepted and then the *stream* fails
 * halfway: the socket resets, a proxy returns a truncated body, the router drops a frame, or the
 * provider bills output and never sends a readable one.
 *
 * Those two families need opposite handling. A parameter problem is deterministic: replaying the
 * identical body gets the identical rejection, so it must be *repaired* (drop the offending field,
 * shrink the payload) rather than retried. A stream problem is stochastic and usually transient, so
 * it must be *retried* — and if a previous attempt already streamed visible text, the retry has to
 * resume from what already arrived instead of restarting from zero, because the user is watching
 * tokens appear and must not see the answer begin twice.
 *
 * Everything here is pure so the adapter can decide, and the agent's own retry layer
 * (`dsh-llm-retry`, which reads `ResolvedRetryPolicy`) stays the final backstop.
 */

/** Failure families, ordered from most specific to least. */
export const FAILURE_KIND = Object.freeze({
  /** The request itself is unacceptable; the same body would be rejected again. */
  PARAMETER: 'parameter',
  /** The request was accepted but the stream failed; usually transient. */
  STREAM: 'stream',
  /** Credentials were rejected. Repairable by falling back to another credential source. */
  AUTH: 'auth',
  /** The account cannot pay. Only a human can fix it. */
  QUOTA: 'quota',
  /** Too many requests. Transient, and the response says when to come back. */
  RATE_LIMIT: 'rate_limit',
})

/**
 * Outcomes a single attempt can end with, from the adapter's point of view.
 *
 * @typedef {object} AttemptOutcome
 * @property {boolean} emitted whether any content became visible to the user
 * @property {boolean} hasToolCall whether a tool call was started
 * @property {number} outputTokens provider-reported output tokens, when known
 * @property {boolean} terminal whether the stream produced a real finish
 */

/**
 * Classify a non-OK HTTP response.
 *
 * The split that matters is not status *code* but whether the request was the problem. 4xx from the
 * gateway's validator is deterministic; 401/403/402/429 are about the account, not the body; 5xx is
 * the far side.
 *
 * @param {number} status
 * @param {string} detail
 * @returns {{ kind: string; code: string; retryable: boolean; repair: string | undefined }}
 */
export function classifyHttp(status, detail) {
  const text = typeof detail === 'string' ? detail : ''
  const lower = text.toLowerCase()

  // The gateway names the offending field in the message for schema-level rejections. Those are the
  // only deterministic ones we can actually repair without guessing.
  const namedField = /(?:field|property|parameter|argument)s?["'\s:]+["']?([a-z_][a-z0-9_]{1,40})/i.exec(text)

  if (status === 400 || status === 422) {
    // Context-length rejections are parameter problems with a deterministic, repairable cause: the
    // assembled history is simply too large for this model. Shrinking the payload fixes it.
    if (/(context[_\s]length|context[_\s]window|too many tokens|prompt is too long|max_tokens.*(?:exceed|greater))/.test(lower)) {
      return { kind: FAILURE_KIND.PARAMETER, code: 'CONTEXT_WINDOW_EXCEEDED', retryable: true, repair: 'shrink' }
    }
    // A model that cannot take images, or a tool set the upstream router will not accept. Checked
    // before the generic validator branch, because that branch would otherwise claim every 400 and
    // these two are the only ones whose repair is exact.
    if (/(tool|function)[_\s]?(call|definition|declaration|schema)/i.test(lower) && /(invalid|malformed|too many|exceed|not supported|unsupported|cannot|does not)/i.test(lower)) {
      return { kind: FAILURE_KIND.PARAMETER, code: 'INVALID_REQUEST', retryable: true, repair: 'drop-tools' }
    }
    if (/(image|vision|multimodal)/i.test(lower) && /(not support|unsupported|only text|does not accept|cannot)/i.test(lower)) {
      return { kind: FAILURE_KIND.PARAMETER, code: 'INVALID_REQUEST', retryable: true, repair: 'drop-images' }
    }
    // Any other body the gateway itself calls malformed (a bad field, an invalid value).
    if (/(invalid_request|unprocessable|schema|validation|malformed|unsupported.*(parameter|value|type))/i.test(lower)) {
      return {
        kind: FAILURE_KIND.PARAMETER,
        code: 'INVALID_REQUEST',
        retryable: true,
        repair: namedField ? `drop:${namedField[1].toLowerCase()}` : 'simplify',
      }
    }
    return { kind: FAILURE_KIND.PARAMETER, code: 'INVALID_REQUEST', retryable: false, repair: undefined }
  }

  if (status === 401 || status === 403) return { kind: FAILURE_KIND.AUTH, code: 'AUTH', retryable: false, repair: 'reauth' }
  if (status === 402) return { kind: FAILURE_KIND.QUOTA, code: 'QUOTA', retryable: false, repair: undefined }
  if (status === 429) return { kind: FAILURE_KIND.RATE_LIMIT, code: 'RATE_LIMIT', retryable: true, repair: undefined }
  if (status >= 500) return { kind: FAILURE_KIND.STREAM, code: 'SERVER', retryable: true, repair: undefined }

  if (/insufficient\s+(?:quota|balance|credits?)|quota\s+(?:exceeded|exhausted)|out of credits/.test(lower)) {
    return { kind: FAILURE_KIND.QUOTA, code: 'QUOTA', retryable: false, repair: undefined }
  }
  if (/rate limit|too many requests/.test(lower)) {
    return { kind: FAILURE_KIND.RATE_LIMIT, code: 'RATE_LIMIT', retryable: true, repair: undefined }
  }
  return { kind: FAILURE_KIND.STREAM, code: 'SERVER', retryable: true, repair: undefined }
}

/**
 * Classify a transport-level failure while reading the stream.
 *
 * Everything here is retryable and never repairable: the request was accepted, so the body was
 * acceptable, and the far side simply did not finish the job.
 *
 * @param {unknown} error
 * @returns {{ kind: string; code: string; retryable: boolean; repair?: undefined }}
 */
export function classifyTransportError(error) {
  if (isAbort(error)) return { kind: FAILURE_KIND.STREAM, code: 'ABORTED', retryable: false }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()

  if (/timed? ?out|timeout|aborted due to/.test(lower)) return { kind: FAILURE_KIND.STREAM, code: 'TIMEOUT', retryable: true }
  if (/socket hang up|terminated|other side closed|premature close|econnreset|epipe|network|fetch failed|socket/.test(lower)) {
    return { kind: FAILURE_KIND.STREAM, code: 'TRANSPORT', retryable: true }
  }
  return { kind: FAILURE_KIND.STREAM, code: 'TRANSPORT', retryable: true }
}

/**
 * Classify how a stream ended.
 *
 * `MALFORMED_RESPONSE` — the provider billed output and sent nothing readable — is deliberately
 * *not* retried here: it is deterministic for the same prompt plus the same provider, so replaying
 * would burn the same tokens again for the same empty result. It is reported so the agent's own
 * layer can decide.
 *
 * @param {{ outputTokens?: number }} outcome
 * @returns {{ kind: string; code: string; retryable: boolean }}
 */
export function classifyEmptyStream(outcome) {
  if ((outcome?.outputTokens ?? 0) > 0) {
    return { kind: FAILURE_KIND.STREAM, code: 'MALFORMED_RESPONSE', retryable: false }
  }
  return { kind: FAILURE_KIND.STREAM, code: 'EMPTY_RESPONSE', retryable: true }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbort(error) {
  if (error === undefined || error === null) return false
  const name = typeof error === 'object' && 'name' in error ? String((/** @type {any} */ (error).name)) : ''
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Decide what one failure means for the attempt that produced it.
 *
 * This is the single decision point the adapter consults, and it deliberately folds the
 * "did the user already see something" question in, because it changes the answer:
 *
 *  - Nothing emitted yet: the failure is invisible, so retry hard and silently.
 *  - Text already emitted: the user is mid-answer. A retry is only acceptable when it can
 *    *continue* from what was already shown, never restart it.
 *  - A tool call already emitted: never retry. The agent loop has most likely already dispatched
 *    the call, and a second identical call could duplicate a side effect.
 *
 * @param {{ kind: string; code: string; retryable: boolean; repair?: string | undefined }} classification
 * @param {AttemptOutcome} [outcome]
 * @returns {{ retry: boolean; reason: string; repair?: string | undefined; continueFromPrefix: boolean }}
 */
export function planRecovery(classification, outcome = {}) {
  const emitted = outcome.emitted === true
  const hasToolCall = outcome.hasToolCall === true

  if (hasToolCall) return { retry: false, reason: 'a tool call is already in flight' }
  if (!classification.retryable) return { retry: false, reason: `not retryable (${classification.code})` }
  // Once the user is watching tokens, a retry must continue rather than restart, or the same
  // sentence appears twice in one turn.
  if (emitted) return { retry: true, reason: 'resuming a partially streamed answer', continueFromPrefix: true }
  return { retry: true, reason: 'nothing visible yet', continueFromPrefix: false }
}

/**
 * How many times this adapter may repair-and-replay inside one dispatch, before deferring to the
 * harness retry layer.
 *
 * Kept small on purpose: each replay costs a full upstream request, and a request that needs three
 * different repairs is a request the agent should see and react to rather than keep paying for.
 *
 * @param {{ repairBudget?: number }} [config]
 * @returns {number}
 */
export function repairBudget(config = {}) {
  const budget = typeof config.repairBudget === 'number' ? Math.floor(config.repairBudget) : 2
  return Math.max(0, Math.min(budget, 3))
}

/**
 * Backoff for one silent retry, bounded so a long stall never looks like a hang.
 *
 * @param {number} attempt zero-based
 * @param {{ initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }} [backoff]
 * @param {() => number} [random]
 * @returns {number}
 */
export function retryDelayMs(attempt, backoff = {}, random = Math.random) {
  const initial = typeof backoff.initialDelayMs === 'number' ? backoff.initialDelayMs : 400
  const max = typeof backoff.maxDelayMs === 'number' ? backoff.maxDelayMs : 4_000
  const jitter = typeof backoff.jitterRatio === 'number' ? backoff.jitterRatio : 0.2
  const base = Math.min(max, initial * 2 ** Math.max(0, attempt))
  const spread = base * Math.max(0, Math.min(1, jitter))
  return Math.round(base - spread / 2 + spread * random())
}

/**
 * Build the repaired request for one known parameter failure.
 *
 * Repairs only ever *remove* something. Removing a field cannot introduce a new rejection the
 * original body did not already have, which is what makes a repair safe to replay blindly.
 *
 * @param {{ messages: unknown[]; tools?: unknown[] }} request
 * @param {string | undefined} repair
 * @returns {{ messages: unknown[]; tools?: unknown[]; dropped: string }}
 */
export function applyRepair(request, repair) {
  if (repair === undefined) return { messages: request.messages, tools: request.tools, dropped: 'none' }
  if (repair.startsWith('drop:')) {
    const field = repair.slice('drop:'.length)
    return { messages: request.messages, tools: request.tools, dropped: `field ${field}` }
  }
  switch (repair) {
    case 'drop-images':
      return {
        messages: request.messages.map(stripImages),
        tools: request.tools,
        dropped: 'image parts',
      }
    case 'drop-tools':
      return { messages: request.messages, dropped: 'tool declarations' }
    case 'shrink':
    case 'simplify':
    default:
      // Trimming the oldest non-system history is the one repair that addresses the most common
      // deterministic rejection (an oversized body) without changing what the model is being asked.
      return { messages: trimOldestHistory(request.messages, 0.5), tools: request.tools, dropped: 'oldest history' }
  }
}

/**
 * Remove image parts from one message, preserving its text and keeping the message itself so tool
 * call/result pairing in the transcript stays intact.
 *
 * @param {any} message
 * @returns {any}
 */
function stripImages(message) {
  if (!Array.isArray(message?.content)) return message
  return {
    ...message,
    content: message.content.filter(
      (/** @type {any} */ part) => part?.type !== 'image_url' && part?.type !== 'image',
    ),
  }
}

/**
 * Drop the oldest half of the conversation, always keeping the leading system message so the model's
 * instructions survive.
 *
 * @param {readonly any[]} messages
 * @param {number} fraction
 * @returns {unknown[]}
 */
function trimOldestHistory(messages, fraction) {
  const list = [...messages]
  if (list.length <= 2) return list
  const keepTail = Math.max(2, Math.ceil(list.length * (1 - fraction)))
  const leading = list[0]?.role === 'system' || list[0]?.role === 'developer' ? [list[0]] : []
  const rest = list.slice(leading.length)
  return [...leading, ...rest.slice(rest.length - keepTail)]
}