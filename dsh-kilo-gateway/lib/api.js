/**
 * Kilo REST API: profile, balance, and device authorization.
 *
 * Ported from `packages/kilo-gateway/src/api/profile.ts` and `src/auth/device.ts`.
 */

import { DEFAULT_FREE_MODEL, DEFAULT_MODEL, MODELS_FETCH_TIMEOUT_MS, POLL_INTERVAL_MS } from './constants.js'
import { resolveKiloApiBase, resolveKiloGatewayBaseUrl } from './url.js'
import { getDefaultHeaders } from './headers.js'

/** @typedef {{ id: string; name: string; role: string }} Organization */
/** @typedef {{ email: string; name?: string; organizations?: Organization[]; selectedOrganizationId?: string; hasPersonalAccount?: boolean }} KilocodeProfile */
/** @typedef {{ balance: number }} KilocodeBalance */
/** @typedef {{ code: string; verificationUrl: string; expiresIn: number }} DeviceAuthInitiateResponse */
/** @typedef {{ status: 'pending' | 'approved' | 'denied' | 'expired'; token?: string; userEmail?: string }} DeviceAuthPollResponse */

/**
 * Fetch the signed-in user's profile.
 *
 * @param {string} token
 * @returns {Promise<KilocodeProfile>}
 */
export async function fetchProfile(token) {
  const response = await fetch(`${resolveKiloApiBase()}/api/profile`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...getDefaultHeaders(),
    },
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Kilo rejected the stored token; sign in again.')
    }
    throw new Error(`Failed to fetch Kilo profile: ${response.status}`)
  }

  const data = await response.json()
  // The backend returns `{ user: { email, name, ... }, organizations }`.
  return {
    email: data.user?.email ?? data.email ?? '',
    name: data.user?.name ?? data.name,
    organizations: data.organizations,
    selectedOrganizationId: data.selectedOrganizationId ?? undefined,
    hasPersonalAccount: data.hasPersonalAccount ?? undefined,
  }
}

/**
 * Resolve the organization a fresh login should default to.
 *
 * Prefers the cloud's validated `selectedOrganizationId`, then falls back to the
 * first organization when the account has no personal account. Returns `undefined`
 * to mean "personal account".
 *
 * @param {KilocodeProfile} profile
 * @returns {string | undefined}
 */
export function defaultOrganizationId(profile) {
  const orgs = profile.organizations ?? []
  const selected = profile.selectedOrganizationId
  const valid = selected && orgs.some((org) => org.id === selected) ? selected : undefined
  return valid ?? (profile.hasPersonalAccount === false ? orgs[0]?.id : undefined)
}

/**
 * Fetch the account balance. Returns `null` on any failure so a transient
 * billing outage never breaks a session.
 *
 * @param {string} token
 * @param {string} [organizationId]
 * @returns {Promise<KilocodeBalance | null>}
 */
export async function fetchBalance(token, organizationId) {
  try {
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...getDefaultHeaders(),
    }
    if (organizationId) headers['x-kilocode-organizationid'] = organizationId
    const response = await fetch(`${resolveKiloApiBase()}/api/profile/balance`, {
      headers,
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const data = await response.json()
    return { balance: data.balance ?? 0 }
  } catch {
    return null
  }
}

/**
 * Fetch the default model for an organization context, falling back to the
 * free model when the request fails or the account is anonymous.
 *
 * @param {string} [token]
 * @param {string} [organizationId]
 * @returns {Promise<string>}
 */
export async function fetchDefaultModel(token, organizationId) {
  const fallback = token ? DEFAULT_MODEL : DEFAULT_FREE_MODEL
  const path = organizationId ? `/api/organizations/${organizationId}/defaults` : '/api/defaults'
  try {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json', ...getDefaultHeaders() }
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetch(`${resolveKiloApiBase()}${path}`, {
      headers,
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return fallback
    const data = await response.json()
    return (token ? data.defaultModel : data.defaultFreeModel) || fallback
  } catch {
    return fallback
  }
}

/**
 * Begin the device authorization flow.
 *
 * @returns {Promise<DeviceAuthInitiateResponse>}
 */
export async function initiateDeviceAuth() {
  const response = await fetch(`${resolveKiloApiBase()}/api/device-auth/codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getDefaultHeaders() },
    signal: AbortSignal.timeout(30 * 1000),
  })

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Too many pending Kilo authorization requests. Try again later.')
    }
    throw new Error(`Failed to start Kilo device authorization: ${response.status}`)
  }

  return (await response.json())
}

/**
 * Poll one device authorization code.
 *
 * @param {string} code
 * @returns {Promise<DeviceAuthPollResponse>}
 */
export async function pollDeviceAuth(code) {
  const response = await fetch(`${resolveKiloApiBase()}/api/device-auth/codes/${encodeURIComponent(code)}`, {
    headers: { ...getDefaultHeaders() },
    signal: AbortSignal.timeout(30 * 1000),
  })

  if (response.status === 202) return { status: 'pending' }
  if (response.status === 403) return { status: 'denied' }
  if (response.status === 410) return { status: 'expired' }
  if (!response.ok) throw new Error(`Failed to poll Kilo device authorization: ${response.status}`)

  return (await response.json())
}

/**
 * Sleep that rejects early when the caller aborts.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function delay(ms, signal) {
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
 * Drive the device authorization flow to completion.
 *
 * The caller is expected to surface `onPrompt` (verification URL and code) to the
 * user before the first poll, and to abort the signal when the user gives up.
 *
 * @param {{ onPrompt?: (info: { code: string; verificationUrl: string; expiresIn: number }) => void | Promise<void>; signal?: AbortSignal }} [options]
 * @returns {Promise<{ token: string; userEmail?: string }>}
 */
export async function runDeviceAuthFlow(options = {}) {
  const { code, verificationUrl, expiresIn } = await initiateDeviceAuth()
  await options.onPrompt?.({ code, verificationUrl, expiresIn })

  const maxAttempts = Math.max(1, Math.ceil((expiresIn * 1000) / POLL_INTERVAL_MS))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await pollDeviceAuth(code)
    if (result.status === 'approved') {
      if (!result.token) throw new Error('Kilo approved the device but returned no token.')
      return { token: result.token, userEmail: result.userEmail }
    }
    if (result.status === 'denied') throw new Error('Kilo authorization was denied.')
    if (result.status === 'expired') throw new Error('The Kilo authorization code expired.')
    await delay(POLL_INTERVAL_MS, options.signal)
  }
  throw new Error('Kilo authorization timed out before it was approved.')
}

/** The catalog returned when Kilo cannot be reached. */
export const EMPTY_EMBEDDING_CATALOG = Object.freeze({ defaultModel: '', models: [], aliases: {} })

/**
 * @param {unknown} value
 * @returns {Record<string, any> | undefined}
 */
function record(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : undefined
}

/**
 * @param {unknown} ms
 * @param {AbortSignal} [signal]
 */
function backoff(ms, signal) {
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
 * @param {number} status
 * @returns {boolean}
 */
function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Fetch the embedding-model catalogue Kilo advertises.
 *
 * A failure never throws: the caller gets {@link EMPTY_EMBEDDING_CATALOG} plus the issue,
 * because a missing catalogue should not break a session.
 *
 * @param {{ token?: string; signal?: AbortSignal; onIssue?: (issue: { code: string; message: string; status?: number }) => void }} [options]
 * @returns {Promise<{ defaultModel: string; models: { id: string; name: string; dimension: number; scoreThreshold: number; note?: string }[]; aliases: Record<string, string> }>}
 */
export async function fetchEmbeddingModelCatalog(options = {}) {
  /** @type {{ code: string; message: string; status?: number } | undefined} */
  let issue
  const attempts = 3

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason
    try {
      const response = await fetch(new URL('embedding-models', resolveKiloGatewayBaseUrl({ ...(options.token ? { token: options.token } : {}) })), {
        redirect: 'error',
        signal: options.signal,
      })
      if (!response.ok) {
        issue = {
          code: 'http',
          message: `Unable to load Kilo embedding models (HTTP ${response.status}).`,
          status: response.status,
        }
        if (!retryableStatus(response.status) || attempt === attempts - 1) break
        await backoff(200 * 2 ** attempt, options.signal)
        continue
      }
      const parsed = record(await response.json().catch(() => undefined))
      if (
        parsed === undefined ||
        typeof parsed.defaultModel !== 'string' ||
        !Array.isArray(parsed.models) ||
        record(parsed.aliases) === undefined
      ) {
        issue = { code: 'invalid-response', message: 'Kilo returned an invalid embedding model catalog.' }
        break
      }
      return {
        defaultModel: parsed.defaultModel,
        models: parsed.models
          .map((entry) => {
            const model = record(entry)
            if (model === undefined || typeof model.id !== 'string' || typeof model.name !== 'string') return undefined
            if (typeof model.dimension !== 'number' || !Number.isFinite(model.dimension) || model.dimension <= 0) {
              return undefined
            }
            return {
              id: model.id,
              name: model.name,
              dimension: model.dimension,
              scoreThreshold: typeof model.scoreThreshold === 'number' ? model.scoreThreshold : 0,
              ...(typeof model.note === 'string' ? { note: model.note } : {}),
            }
          })
          .filter((entry) => entry !== undefined),
        aliases: parsed.aliases,
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      issue = { code: 'network', message: 'Unable to connect to Kilo to load embedding models.' }
      if (attempt === attempts - 1) break
      await backoff(200 * 2 ** attempt, options.signal)
    }
  }

  options.onIssue?.(issue)
  return EMPTY_EMBEDDING_CATALOG
}
