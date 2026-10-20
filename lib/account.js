/**
 * Kilo account state: Kilo Pass, coding-plan quotas, BYOK entries, and notifications.
 *
 * Ported from `packages/kilo-gateway/src/api/kilo-pass.ts`,
 * `src/api/trpc.ts`, and `src/api/notifications.ts`.
 */

import { buildKiloHeaders, getDefaultHeaders } from './headers.js'
import { resolveKiloApiBase } from './url.js'

/** Bound on any tRPC response body this module will buffer. */
const RESPONSE_LIMIT = 512 * 1024

/** Bound on one request. */
const TIMEOUT_MS = 5_000

/** Statuses that still represent a pass the user can consume. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'past_due', 'trialing'])

/**
 * A tRPC call that failed. `kind` is stable and routable; `message` is for humans.
 */
export class KiloCloudError extends Error {
  /**
   * @param {'network' | 'http' | 'protocol' | 'procedure' | 'schema' | 'unauthorized'} kind
   * @param {string} message
   * @param {number} [status]
   */
  constructor(kind, message, status) {
    super(message)
    this.name = 'KiloCloudError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

/**
 * Read a response body with a hard byte ceiling, cancelling the stream once it is exceeded.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBounded(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => undefined)
    throw new KiloCloudError('protocol', 'Kilo returned an oversized response.', response.status)
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > RESPONSE_LIMIT) {
      throw new KiloCloudError('protocol', 'Kilo returned an oversized response.', response.status)
    }
    return new TextDecoder().decode(buffer)
  }

  const reader = response.body.getReader()
  /** @type {Uint8Array[]} */
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => undefined)
        throw new KiloCloudError('protocol', 'Kilo returned an oversized response.', response.status)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * One tRPC `query` over GET. Throws {@link KiloCloudError} on every failure class rather
 * than returning a partial value, so a caller cannot mistake a transport failure for "empty".
 *
 * @param {string} procedure dotted tRPC procedure path
 * @param {string} token
 * @param {(value: unknown) => unknown} parse validator over the `data` payload
 * @param {unknown} [input] procedure input
 * @returns {Promise<any>}
 */
async function query(procedure, token, parse, input) {
  const params = new URLSearchParams()
  if (input !== undefined) params.set('input', JSON.stringify(input))
  const suffix = params.size > 0 ? `?${params.toString()}` : ''

  let response
  try {
    response = await fetch(`${resolveKiloApiBase()}/api/trpc/${procedure}${suffix}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...buildKiloHeaders(),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof KiloCloudError) throw error
    throw new KiloCloudError('network', 'Kilo Cloud is unreachable.')
  }

  if (response.status === 401 || response.status === 403) {
    throw new KiloCloudError('unauthorized', 'The Kilo credential was rejected.', response.status)
  }

  const body = await readBounded(response).catch((error) => {
    throw error instanceof KiloCloudError
      ? error
      : new KiloCloudError('protocol', 'Kilo Cloud returned an unreadable response.', response.status)
  })

  /** @type {any} */
  let envelope
  try {
    envelope = JSON.parse(body)
  } catch {
    throw new KiloCloudError('protocol', 'Kilo Cloud returned a malformed response.', response.status)
  }
  if (envelope?.error != null) {
    throw new KiloCloudError('procedure', 'Kilo Cloud refused the request.', response.status)
  }
  if (!response.ok) {
    throw new KiloCloudError('http', 'Kilo Cloud rejected the request.', response.status)
  }
  if (!envelope?.result) {
    throw new KiloCloudError('protocol', 'Kilo Cloud returned no result.', response.status)
  }

  // tRPC v11 wraps the payload as `data.json` for `json`-mode procedures.
  const data = envelope.result.data
  const value = data !== null && typeof data === 'object' && 'json' in data ? data.json : data
  return parse(value)
}

/** @param {unknown} value */
function object(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : undefined
}

/**
 * Read Kilo Pass subscription state: period credits, usage, and the next billing date.
 *
 * @param {string} token
 * @returns {Promise<{ currentPeriodBaseCreditsUsd: number; currentPeriodUsageUsd: number; currentPeriodBonusCreditsUsd: number; nextBillingAt: string | null } | null>}
 */
export async function fetchKiloPassState(token) {
  /** @param {unknown} value */
  const parse = (value) => {
    // The batch envelope nests the payload three levels deep; accept the unwrapped shape too.
    const root = object(object(object(object(value)?.result)?.data)?.json) ?? object(value)
    const sub = object(root?.subscription)
    if (sub === undefined) return null
    if (sub.currentPeriodBaseCreditsUsd == null && sub.currentPeriodUsageUsd == null) return null
    if (typeof sub.status === 'string' && !LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) return null
    const num = (input) => (typeof input === 'number' && Number.isFinite(input) ? input : 0)
    const next = sub.nextBillingAt ?? sub.nextRenewalAt
    return {
      currentPeriodBaseCreditsUsd: num(sub.currentPeriodBaseCreditsUsd),
      currentPeriodUsageUsd: num(sub.currentPeriodUsageUsd),
      currentPeriodBonusCreditsUsd: num(sub.currentPeriodBonusCreditsUsd),
      nextBillingAt: typeof next === 'string' ? next : null,
    }
  }

  try {
    const params = new URLSearchParams({ batch: '1', input: JSON.stringify({ '0': null }) })
    const response = await fetch(`${resolveKiloApiBase()}/api/trpc/kiloPass.getState?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...buildKiloHeaders(),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    return parse(await response.json())
  } catch {
    return null
  }
}

/**
 * List the account's coding-plan subscriptions.
 *
 * @param {string} token
 * @returns {Promise<{ id: string; planId: string; planName: string; providerName: string; providerId: string; canQueryUsage: boolean; status: string; cancelAtPeriodEnd: boolean }[]>}
 */
export function fetchCodingPlanSubscriptions(token) {
  return query(
    'codingPlans.listSubscriptions',
    token,
    (value) => {
      if (!Array.isArray(value)) throw new KiloCloudError('schema', 'Unexpected subscription payload.')
      return value.map((entry) => {
        const item = object(entry) ?? {}
        return {
          id: String(item.id ?? ''),
          planId: String(item.planId ?? ''),
          planName: String(item.planName ?? ''),
          providerName: String(item.providerName ?? ''),
          providerId: String(item.providerId ?? ''),
          canQueryUsage: item.canQueryUsage === true,
          status: String(item.status ?? 'unknown'),
          cancelAtPeriodEnd: item.cancelAtPeriodEnd === true,
        }
      })
    },
  )
}

/**
 * Read one subscription's remaining quota windows.
 *
 * @param {string} token
 * @param {string} subscriptionId
 * @returns {Promise<{ planName: string; providerName: string; windows: { id: string; remainingPercent: number; resetsAt: string; period: string }[] }>}
 */
export function fetchCodingPlanUsage(token, subscriptionId) {
  return query(
    'codingPlans.getUsage',
    token,
    (value) => {
      const payload = object(value)
      const sub = object(payload?.subscription)
      if (sub === undefined || !Array.isArray(sub.windows)) {
        throw new KiloCloudError('schema', 'Unexpected quota payload.')
      }
      if (String(sub.id ?? '') !== subscriptionId) {
        throw new KiloCloudError('schema', 'Kilo returned a different subscription than requested.')
      }
      return {
        planName: String(sub.planName ?? ''),
        providerName: String(sub.providerName ?? ''),
        windows: sub.windows.map((entry) => {
          const window = object(entry) ?? {}
          const period = object(window.period) ?? {}
          return {
            id: String(window.id ?? ''),
            remainingPercent: typeof window.remainingPercent === 'number' ? window.remainingPercent : 0,
            resetsAt: String(window.resetsAt ?? ''),
            period: `${period.value ?? 1}-${String(period.unit ?? 'month')}`,
          }
        }),
      }
    },
    { subscriptionId },
  )
}

/**
 * List the account's bring-your-own-key entries.
 *
 * @param {string} token
 * @returns {Promise<{ id: string; providerId: string; managementSource: string; isEnabled: boolean }[]>}
 */
export function fetchByokEntries(token) {
  return query(
    'byok.list',
    token,
    (value) => {
      if (!Array.isArray(value)) throw new KiloCloudError('schema', 'Unexpected BYOK payload.')
      return value.map((entry) => {
        const item = object(entry) ?? {}
        return {
          id: String(item.id ?? ''),
          providerId: String(item.provider_id ?? ''),
          managementSource: String(item.management_source ?? 'user'),
          isEnabled: item.is_enabled === true,
        }
      })
    },
    {},
  )
}

/**
 * Fetch account notifications. Clients filter by `showIn`; an unauthenticated call yields none.
 *
 * @param {{ kilocodeToken?: string; kilocodeOrganizationId?: string }} options
 * @returns {Promise<{ id: string; title: string; message: string; actionText?: string; actionURL?: string; suggestModelId?: string }[]>}
 */
export async function fetchKilocodeNotifications(options) {
  const token = options.kilocodeToken
  if (!token) return []

  try {
    const response = await fetch(`${resolveKiloApiBase()}/api/users/notifications`, {
      headers: {
        ...getDefaultHeaders(),
        ...buildKiloHeaders(undefined, { kilocodeOrganizationId: options.kilocodeOrganizationId }),
        Authorization: `Bearer ${token}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return []

    /** @type {any} */
    const json = await response.json()
    if (!Array.isArray(json?.notifications)) return []

    return json.notifications
      .map((/** @type {any} */ entry) => {
        const item = object(entry) ?? {}
        if (typeof item.id !== 'string' || typeof item.title !== 'string') return undefined
        return {
          id: item.id,
          title: item.title,
          message: typeof item.message === 'string' ? item.message : '',
          ...(object(item.action)?.actionText ? { actionText: String(item.action.actionText) } : {}),
          ...(object(item.action)?.actionURL ? { actionURL: String(item.action.actionURL) } : {}),
          ...(item.suggestModelId ? { suggestModelId: String(item.suggestModelId) } : {}),
        }
      })
      .filter((/** @type {any} */ entry) => entry !== undefined)
  } catch {
    return []
  }
}
