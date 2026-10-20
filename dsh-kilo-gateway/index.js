/**
 * Kilo Gateway bundle for the DeepSeek Harness.
 *
 * Registers the Kilo Code Gateway (https://ai-gateway.kilo.ai) as the `kilo` model provider, plus
 * the agent tools covering the Kilo capability the harness has no seam for: account state, FIM /
 * Next Edit completion, the embedding catalogue, and notifications. The browser half of this same
 * bundle contributes a dedicated "Kilo Gateway" page in the Settings panel that holds the API-key
 * form.
 *
 * Upstream source: https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-gateway
 * License: MIT
 *
 * ## Why the key form lives on this bundle's own settings page
 *
 * The web Models page is not a generic schema renderer. Its editor picks one of exactly two curated
 * layouts from the *settings namespace*, and renders nothing but a hint for any other:
 *
 * ```js
 * function layoutOf(ns) {
 *   if (ns === 'llm-deepseek') return 'deepseek'
 *   if (ns === 'llm-pi-ai')   return 'pi-ai'
 *   return 'unknown' // <- "Other fields live in cordis.patch.yml" and no inputs at all
 * }
 * ```
 *
 * A private namespace can therefore never show an API-key input there, whatever a plugin's own
 * `Config` schema marks as `role('credential-ref')`. This bundle consequently does not declare
 * itself into the Models directory at all: it serves the `kilo` route with its own adapter, and the
 * key is entered on the settings page `client.js` registers, which writes the secret through the
 * generated `remote.credentials` namespace into the credential store.
 *
 * Services are reached through the context rather than imported, because a bundle resolves its peer
 * dependencies to its own copies: importing `@deepseek-ai/*` runtime classes here would break the
 * `Service`/`Context` identity the Loader checks.
 */

import { KiloGatewayAdapter, KILO_PROVIDER } from './lib/adapter.js'
import { registerKiloAuth } from './lib/authorization.js'
import {
  describeToken,
  resolveAuth,
  KILO_API_KEY_REF,
  KILO_TOKEN_KEY,
  KILO_ORG_KEY,
} from './lib/token-store.js'
import { registerKiloTools } from './lib/tools.js'
import { registerKiloLoginTool } from './lib/login-tool.js'
import { Config, DEFAULT_API_KEY_REF } from './lib/config.js'

/**
 * The settings namespace this plugin's own `Config` schema owns.
 *
 * Patch edits under this row configure the plugin; the API key is deliberately not one of those
 * fields, because it belongs in the credential store, not in a patch file.
 */
const SETTINGS_NS = 'dsh-kilo-gateway'

/**
 * The `llm-pi-ai` profile an earlier revision of this bundle seeded by mistake, identified by the
 * endpoint it wrote. {@link removeSeededProfile} unsets exactly this shape and nothing else.
 */
const SEEDED_PI_AI_PROFILE_BASE = 'https://ai-gateway.kilo.ai/api/openrouter'

/**
 * Keep a configured numeric override, dropping anything that is not a usable finite number so a typo
 * in the patch falls back to the default instead of disabling the feature.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The plugin-level settings, read once so every registration below agrees on them.
 *
 * @param {Record<string, unknown>} config
 */
function readSettings(config) {
  return {
    apiKeyEnv:
      typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim().length > 0
        ? config.apiKeyEnv.trim()
        : DEFAULT_API_KEY_REF,
    baseURL:
      typeof config.baseURL === 'string' && config.baseURL.trim().length > 0
        ? config.baseURL.trim()
        : undefined,
    organizationId:
      typeof config.organizationId === 'string' && config.organizationId.trim().length > 0
        ? config.organizationId.trim()
        : undefined,
    repairBudget: numberOrUndefined(config.repairBudget),
    streamIdleTimeoutMs: numberOrUndefined(config.streamIdleTimeoutMs),
  }
}

/**
 * Whether a failure is the route being held by another adapter.
 *
 * `LlmError` is duck-typed: this bundle must not import `@deepseek-ai/dsh-llm` for the class, since
 * its own peer copy has a different identity than the one the Loader is running.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRouteHeld(error) {
  if (error !== null && typeof error === 'object') {
    if (error.code === 'DUPLICATE_ADAPTER') return true
    if (error instanceof Error && /DUPLICATE_ADAPTER/.test(error.message)) return true
  }
  return false
}

/**
 * Remove the `kilo` profile an earlier revision of this bundle seeded into the `llm-pi-ai` settings
 * document.
 *
 * That revision served chat through `@deepseek-ai/dsh-llm-pi-ai`, which registers one generic
 * adapter covering every configured profile; a leftover `kilo` profile therefore makes pi-ai claim
 * the `kilo` route, and the adapter this bundle registers collides with it (`DUPLICATE_ADAPTER`).
 * Writing another plugin's namespace was a mistake, and this removes exactly what that revision
 * wrote: the profile is only unset when it still carries this bundle's seeded endpoint, so anything
 * the user configured by hand is left alone.
 *
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function removeSeededProfile(ctx) {
  const settings = ctx.get?.('settings')
  if (
    settings === undefined ||
    typeof settings.describe !== 'function' ||
    typeof settings.mutate !== 'function'
  ) {
    return
  }
  try {
    const descriptors = settings.describe({ redactSecrets: true })
    const descriptor = Array.isArray(descriptors)
      ? descriptors.find((entry) => entry?.ns === 'llm-pi-ai')
      : undefined
    const profile = descriptor?.value?.providers?.[KILO_PROVIDER]
    if (profile?.baseURL !== SEEDED_PI_AI_PROFILE_BASE) return
    await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', KILO_PROVIDER] }])
    ctx.logger?.info?.('kilo-gateway: removed the llm-pi-ai profile an earlier revision seeded')
  } catch (error) {
    // Best-effort: a failed cleanup only means the retry path below has to win the race instead.
    ctx.logger?.warn?.('kilo-gateway: could not remove the seeded llm-pi-ai profile', error)
  }
}

/**
 * Host half of the Kilo Gateway bundle.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const settings = readSettings(config)

  /** @type {(() => void)[]} */
  const disposers = []
  const disposeAll = () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // Teardown must continue past a failing disposer.
      }
    }
  }

  // Agent tools are optional: a profile without the tools seam still gets the provider route.
  disposers.push(registerKiloTools(ctx, settings))
  disposers.push(registerKiloLoginTool(ctx, settings))

  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    ctx.logger?.warn?.('kilo-gateway: the llm service is unavailable; the provider route was not registered')
    return disposeAll
  }

  // If an earlier revision of this bundle seeded a kilo profile into llm-pi-ai's settings, pi-ai is
  // holding the route. The unset makes pi-ai drop it on the next volatile update, so it is fired
  // before the adapter below is registered.
  void removeSeededProfile(ctx)

  const adapter = new KiloGatewayAdapter(ctx, settings)

  /** Adapter registration state: the disposer lands here whenever the route is finally won. */
  const registration = { dispose: () => undefined, installed: false, unloaded: false }
  disposers.push(() => {
    registration.unloaded = true
    registration.dispose()
  })

  /**
   * Try to take the route, tolerating the window where pi-ai has not yet reacted to the unset.
   *
   * @param {number} attempt zero-based
   */
  const install = (attempt) => {
    if (registration.installed || registration.unloaded) return
    try {
      registration.dispose = llm.registerAdapter([KILO_PROVIDER], adapter)
      registration.installed = true
      return
    } catch (error) {
      if (!isRouteHeld(error)) throw error
      if (attempt >= 2) {
        ctx.logger?.error?.(
          'kilo-gateway: the kilo route is still held by llm-pi-ai. ' +
            'Remove the kilo profile from the llm-pi-ai settings and reload the profile.',
          error,
        )
        return
      }
    }
    const retry = () => install(attempt + 1)
    const timer = ctx.timer?.timeout?.(attempt === 0 ? 500 : 2000)
    if (timer !== undefined && typeof timer.then === 'function') {
      timer.then(retry, retry)
    } else {
      // No timer service: one immediate retry is still better than giving up on the first try.
      if (attempt === 0) retry()
    }
  }

  try {
    install(0)
  } catch (error) {
    ctx.logger?.warn?.('kilo-gateway: could not register the provider route', error)
  }

  // Device-authorization sign-in, so a user can obtain a credential from any surface that renders
  // authorization flows.
  disposers.push(registerKiloAuth(ctx))

  return disposeAll
}

/** Services this plugin contributes against. */
export const inject = ['llm']

export {
  Config,
  SETTINGS_NS,
  KILO_PROVIDER,
  KILO_API_KEY_REF,
  DEFAULT_API_KEY_REF,
  KILO_TOKEN_KEY,
  KILO_ORG_KEY,
  resolveAuth,
  describeToken,
}