/**
 * Kilo sign-in as an agent tool.
 *
 * The `authorization` seam already renders a "Kilo Gateway" sign-in flow in every Harness
 * surface. This tool covers the case the agent drives itself: when the user asks the agent to
 * sign in, or when a request is rejected because the stored token expired.
 *
 * It calls the same tRPC procedure the seam does, so a token committed here is indistinguishable
 * from one committed through the UI.
 */

import { resolveKiloApiBase } from './url.js'
import { getDefaultHeaders } from './headers.js'
import { storeGrantToken, resolveAuth } from './token-store.js'

/** Bound on one device-auth request. */
const TIMEOUT_MS = 20_000

/** Status codes that end the wait rather than continue it. */
const TERMINAL_STATUS = { DENIED: 'DENIED', EXPIRED: 'EXPIRED' }

/**
 * @param {unknown} value
 * @returns {Record<string, any> | undefined}
 */
function record(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : undefined
}

/**
 * Ask Kilo Cloud to start a device authorization.
 *
 * @param {string} token the current credential, used only to authorize the request
 * @returns {Promise<{ code: string; verificationUrl: string; expiresIn: number }>}
 */
async function initiateDeviceAuth(token) {
  const response = await fetch(`${resolveKiloApiBase()}/api/device-auth/codes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...getDefaultHeaders(),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('The stored Kilo credential was rejected. Sign in again from the account page first.')
  }
  if (!response.ok) {
    throw new Error(`Kilo refused to start device authorization (${response.status}).`)
  }
  const body = record(await response.json())
  if (typeof body?.code !== 'string' || typeof body?.verificationUrl !== 'string') {
    throw new Error('Kilo returned a malformed device authorization response.')
  }
  return {
    code: body.code,
    verificationUrl: body.verificationUrl,
    expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 300,
  }
}

/**
 * Poll one device-authorization code.
 *
 * @param {string} token
 * @param {string} code
 * @returns {Promise<{ status: string; token?: string }>}
 */
async function pollDeviceAuth(token, code) {
  const response = await fetch(
    `${resolveKiloApiBase()}/api/device-auth/codes/${encodeURIComponent(code)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...getDefaultHeaders(),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )
  // 202 means "still pending", which is not an error.
  if (response.status === 202) return { status: 'pending' }
  if (response.status === 410) return { status: TERMINAL_STATUS.EXPIRED }
  if (response.status === 403) return { status: TERMINAL_STATUS.DENIED }
  if (response.status === 401) {
    throw new Error('The stored Kilo credential was rejected while polling.')
  }
  if (!response.ok) {
    throw new Error(`Kilo device authorization poll failed (${response.status}).`)
  }
  const body = record(await response.json())
  if (typeof body?.token === 'string' && body.token.length > 0) {
    return { status: 'approved', token: body.token }
  }
  return { status: typeof body?.status === 'string' ? body.status : 'pending' }
}

/**
 * Register the Kilo sign-in tool.
 *
 * @param {any} ctx
 * @param {{ apiKeyEnv?: string }} [options]
 * @returns {() => void}
 */
export function registerKiloLoginTool(ctx, options = {}) {
  const tools = ctx.get?.('tools')
  if (tools === undefined || typeof tools.register !== 'function') return () => undefined

  const errorBranch = {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['code', 'message'],
  }

  return tools.register({
    name: 'kilo_login',
    description:
      'Sign in to Kilo Gateway with a device code. Returns a verification URL and a one-time code for the user to enter. This requires an existing Kilo credential to authorize the request, so it renews a token that exists but was rejected — it cannot create the first credential. For a first-time sign-in, use the Kilo Gateway entry on the account page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string' },
              signedIn: { type: 'boolean' },
              verificationUrl: { type: 'string' },
              code: { type: 'string' },
              expiresIn: { type: 'integer' },
            },
            required: ['status', 'signedIn', 'verificationUrl', 'code', 'expiresIn'],
          },
          errorBranch,
        ],
      },
      render: (_args, value) => {
        if (typeof value?.verificationUrl === 'string') {
          return [
            {
              type: 'text',
              text: `Ask the user to open ${value.verificationUrl} and enter code ${value.code}. This code expires in ${value.expiresIn} seconds.`,
            },
          ]
        }
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    timeoutMs: 25_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      try {
        // Any configured credential can authorize the request — the managed key, an ambient
        // variable, or a previously stored grant — because Kilo needs a valid bearer to mint a
        // device code at all.
        const auth = await resolveAuth(ctx, { ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}) })
        if (auth.token === undefined) {
          return {
            code: 'not_signed_in',
            message:
              'No Kilo credential is configured, and device authorization needs one to authorize the request. ' +
              'Type an API key into the Kilo Gateway entry on the Models settings page, or export KILO_API_KEY, first.',
          }
        }

        const { code, verificationUrl, expiresIn } = await initiateDeviceAuth(auth.token)
        const pending = await pollDeviceAuth(auth.token, code).catch(() => ({ status: 'pending' }))
        if (pending.status === 'approved' && pending.token !== undefined) {
          await commitToken(ctx, pending.token)
          return { status: 'approved', signedIn: true, verificationUrl, code, expiresIn }
        }
        // The common case is still-pending: hand the user the URL and code.
        void exec
        return { status: 'pending', signedIn: false, verificationUrl, code, expiresIn }
      } catch (error) {
        return { code: 'login_failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Sign in to Kilo Gateway', kind: 'execute' }),
  })
}

/**
 * Write a freshly issued token into the credentials store.
 *
 * @param {any} ctx
 * @param {string} token
 */
async function commitToken(ctx, token) {
  await storeGrantToken(ctx, token)
}

