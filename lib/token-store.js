/**
 * Kilo credential resolution.
 *
 * Sources, in precedence order:
 *
 *  1. **Configured reference** — `apiKeyEnv`, defaulting to `KILO_API_KEY`. This is the reference the
 *     Models settings page writes a secret into, and the only path that survives a restart.
 *  2. **Ambient environment** — `KILO_API_KEY`, then `KILOCODE_TOKEN`. Layered under the managed store
 *     by the credentials provider itself, so a stored secret is never displaced by an environment
 *     variable.
 *  3. **Stored device grant** — the record `kilo_login` and the authorization flow write.
 *  4. **Anonymous** — nothing configured. The gateway accepts `Bearer anonymous` for free models only
 *     (`:free` ids and `kilo-auto/free`), rate limited to 200 requests/hour per IP.
 *
 * Sources 2 and 3 are *fallbacks* rather than dead ends: a key that was once accepted and later
 * starts returning 401 is demoted for the rest of the process so the next dispatch reaches a
 * working source instead of failing identically forever. That is what makes a long-lived install
 * survive a rotated, expired, or revoked credential.
 *
 * The environment is read here directly as well, so a shell can drive the plugin even where the
 * credentials service is absent.
 *
 * The credentials seam is reached with `ctx.get(...)`: a bundle's own peer copy of the Harness
 * packages is not the same object identity the Loader holds.
 */

import { ENV_KILOCODE_TOKEN, ENV_KILO_API_KEY, ENV_KILO_ORGANIZATION_ID } from './constants.js'

/** The credential reference the API key lives behind, in the reference half of the seam. */
export const KILO_API_KEY_REF = 'KILO_API_KEY'

/** Credential scope this plugin owns inside the credentials store. */
export const KILO_CREDENTIAL_SCOPE = 'dsh-kilo-gateway'

/** The credential record a device-authorization grant lives in. */
export const KILO_TOKEN_KEY = `${KILO_CREDENTIAL_SCOPE}/token`

/** The credential record the selected organization id lives in. */
export const KILO_ORG_KEY = `${KILO_CREDENTIAL_SCOPE}/organization`

/** Where one resolved token came from. */
export const TOKEN_SOURCE = Object.freeze({
  MANAGED: 'managed',
  ENVIRONMENT: 'environment',
  RECORD: 'record',
  ANONYMOUS: 'anonymous',
})

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(env, name) {
  const value = env?.[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The credential configured purely in the process environment, if any.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ value: string; source: 'KILO_API_KEY' | 'KILOCODE_TOKEN' } | undefined}
 */
export function readEnvCredential(env = process.env) {
  const key = readEnv(env, ENV_KILO_API_KEY)
  if (key !== undefined) return { value: key, source: ENV_KILO_API_KEY }
  const token = readEnv(env, ENV_KILOCODE_TOKEN)
  if (token !== undefined) return { value: token, source: ENV_KILOCODE_TOKEN }
  return undefined
}

/**
 * The organization id configured in the environment, if any.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function readEnvOrganizationId(env = process.env) {
  return readEnv(env, ENV_KILO_ORGANIZATION_ID)
}

/**
 * Read the API key from the managed store.
 *
 * `resolve` covers the whole reference half: the stored value first, then ambient environment and
 * `.env` fallbacks. It also enforces the seam rule that an empty stored value is absent, so a blank
 * never masquerades as a configured secret.
 *
 * The reference is the configured `apiKeyEnv` when one is set, so pointing that field at an existing
 * reference (say `KILO_G_API_KEY`) reuses it without copying the secret. It falls back to
 * {@link KILO_API_KEY_REF}, which is what the settings surface prompts for by default.
 *
 * @param {any} ctx
 * @param {string} [configuredRef]
 * @returns {Promise<{ value: string; ref: string } | undefined>}
 */
async function resolveManagedKey(ctx, configuredRef) {
  /** @type {string[]} */
  const candidates = []
  const trimmed = typeof configuredRef === 'string' ? configuredRef.trim() : ''
  // A configured reference that is not a legal reference name is skipped rather than raising, so a
  // typo degrades to the next source instead of breaking dispatch.
  if (trimmed.length > 0 && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(trimmed)) candidates.push(trimmed)
  if (!candidates.includes(KILO_API_KEY_REF)) candidates.push(KILO_API_KEY_REF)

  for (const ref of candidates) {
    try {
      const hit = await ctx.get?.('credentials')?.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        return { value: hit.value, ref }
      }
    } catch {
      // A missing or broken credentials service falls through to the next candidate.
    }
  }
  return undefined
}

/**
 * Read one credential record's `key` field.
 *
 * Records are a discriminated union: `{kind:'api-key', key?, env?}` or `{kind:'grant', payload}`.
 * Only an `api-key` record carries a readable secret, so a `grant` record reads as "nothing stored".
 *
 * @param {any} ctx
 * @param {string} recordKey
 * @returns {Promise<string | undefined>}
 */
async function readRecordKey(ctx, recordKey) {
  try {
    const record = await ctx.get?.('credentials')?.readRecord(recordKey)
    if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) {
      return record.key
    }
  } catch {
    // Absent or unreadable records read as "nothing stored".
  }
  return undefined
}

/**
 * Why a request is being made the way it is. Surfaced so the adapter can explain an anonymous
 * rejection instead of letting the gateway's 401 read as a plugin bug.
 *
 * @typedef {{ token: string | undefined; organizationId: string | undefined; anonymous: boolean; source: string; ref: string | undefined }} KiloAuth
 */

/**
 * Per-context process-lifetime memory of credentials the gateway has rejected.
 *
 * Kept on a WeakMap keyed by the plugin's own context so a reload or a new context starts clean and
 * nothing leaks between fibers. The public surface is the two functions below.
 *
 * @type {WeakMap<object, Map<string, { until: number; reason: string }>>}
 */
const suppressed = new WeakMap()

/** How long a rejected token stays suppressed before it is tried again. */
const SUPPRESS_MS = 10 * 60 * 1000

/**
 * @param {any} ctx
 * @returns {Map<string, { until: number; reason: string }>}
 */
function suppressions(ctx) {
  const key = ctx !== null && typeof ctx === 'object' ? ctx : GLOBAL_KEY
  let map = suppressed.get(key)
  if (map === undefined) {
    map = new Map()
    suppressed.set(key, map)
  }
  return map
}

/** Fallback owner for calls made without a context, so suppression still works. */
const GLOBAL_KEY = {}

/**
 * Remember that one token was rejected, and stop offering it for a while.
 *
 * Only the *token value* is keyed, never the reference: two sources may legitimately hold the same
 * secret, and the failing fact is about the secret rather than about where it was read from.
 *
 * @param {any} ctx
 * @param {string} token
 * @param {string} reason
 */
export function reportTokenRejected(ctx, token, reason) {
  if (typeof token !== 'string' || token.length === 0) return
  suppressions(ctx).set(token, { until: Date.now() + SUPPRESS_MS, reason })
}

/**
 * Whether one token is currently suppressed as known-bad.
 *
 * @param {any} ctx
 * @param {string | undefined} token
 * @returns {boolean}
 */
export function isTokenSuppressed(ctx, token) {
  if (typeof token !== 'string' || token.length === 0) return false
  const entry = suppressions(ctx).get(token)
  if (entry === undefined) return false
  if (entry.until <= Date.now()) {
    suppressions(ctx).delete(token)
    return false
  }
  return true
}

/**
 * Forget every suppression, so the next dispatch re-reads all sources.
 *
 * Called after a successful sign-in or key write, where the previous credential state is known to be
 * stale.
 *
 * @param {any} ctx
 */
export function clearSuppressions(ctx) {
  suppressions(ctx).clear()
}

/**
 * Resolve the effective credential for one dispatch.
 *
 * Every candidate source is consulted, and any token known to be rejected is passed over. That is
 * what lets a stale `KILO_API_KEY` in the environment fall through to a valid stored grant instead
 * of failing every request until the process restarts.
 *
 * @param {any} ctx
 * @param {{ env?: Record<string, string | undefined>; apiKeyEnv?: string }} [options]
 * @returns {Promise<KiloAuth>}
 */
export async function resolveAuth(ctx, options = {}) {
  const env = options.env ?? process.env
  const organizationId =
    readEnvOrganizationId(env) ?? (await readRecordKey(ctx, KILO_ORG_KEY)) ?? undefined

  const managed = await resolveManagedKey(ctx, options.apiKeyEnv)
  if (managed !== undefined && !isTokenSuppressed(ctx, managed.value)) {
    return { token: managed.value, organizationId, anonymous: false, source: TOKEN_SOURCE.MANAGED, ref: managed.ref }
  }

  const fromEnv = readEnvCredential(env)
  if (fromEnv !== undefined && !isTokenSuppressed(ctx, fromEnv.value)) {
    return {
      token: fromEnv.value,
      organizationId,
      anonymous: false,
      source: TOKEN_SOURCE.ENVIRONMENT,
      ref: fromEnv.source,
    }
  }

  // A device-authorization grant stored by `kilo_login` or the authorization flow.
  const granted = await readRecordKey(ctx, KILO_TOKEN_KEY)
  if (granted !== undefined && !isTokenSuppressed(ctx, granted)) {
    return { token: granted, organizationId, anonymous: false, source: TOKEN_SOURCE.RECORD, ref: KILO_TOKEN_KEY }
  }

  return { token: undefined, organizationId, anonymous: true, source: TOKEN_SOURCE.ANONYMOUS, ref: undefined }
}

/**
 * The stored device-authorization token, ignoring the reference half.
 *
 * @param {any} ctx
 * @returns {Promise<string | undefined>}
 */
export function readToken(ctx) {
  return readRecordKey(ctx, KILO_TOKEN_KEY)
}

/**
 * The stored organization id, ignoring the environment.
 *
 * @param {any} ctx
 * @returns {Promise<string | undefined>}
 */
export function readOrganizationId(ctx) {
  return readRecordKey(ctx, KILO_ORG_KEY)
}

/**
 * Describe the Kilo credential state without revealing the token.
 *
 * @param {any} ctx
 * @param {{ env?: Record<string, string | undefined>; apiKeyEnv?: string }} [options]
 * @returns {Promise<{ signedIn: boolean; source: KiloAuth['source'] }>}
 */
export async function describeToken(ctx, options = {}) {
  const auth = await resolveAuth(ctx, options)
  return { signedIn: !auth.anonymous, source: auth.source }
}

/**
 * Store an API key the way the credentials provider expects.
 *
 * The record must be a tagged `api-key`: `assertStorableApiKey` reads `key`/`env`, and an entry
 * without a `kind` is rejected by the parser at the *next boot*, which would fail the credentials
 * plugin's activation rather than merely losing the value.
 *
 * @param {any} ctx
 * @param {string} value
 */
export async function storeApiKey(ctx, value) {
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) {
    throw new Error('The credentials service is unavailable, so the key could not be stored.')
  }
  await credentials.set(KILO_API_KEY_REF, value)
  // The previous credential state is now known to be stale.
  clearSuppressions(ctx)
}

/**
 * Store a device-authorization token as a properly tagged record.
 *
 * @param {any} ctx
 * @param {string} value
 */
export async function storeGrantToken(ctx, value) {
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) {
    throw new Error('The credentials service is unavailable, so the token could not be stored.')
  }
  await credentials.modifyRecord(KILO_TOKEN_KEY, () => Promise.resolve({ kind: 'api-key', key: value }))
  clearSuppressions(ctx)
}

/**
 * Store the selected organization id as a tagged record.
 *
 * @param {any} ctx
 * @param {string} value
 */
export async function storeOrganizationId(ctx, value) {
  const credentials = ctx.get?.('credentials')
  if (credentials === undefined) return
  await credentials.modifyRecord(KILO_ORG_KEY, () => Promise.resolve({ kind: 'api-key', key: value }))
}