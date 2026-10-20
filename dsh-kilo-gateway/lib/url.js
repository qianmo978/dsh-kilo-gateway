/**
 * Kilo Gateway URL resolution.
 *
 * Ported from `packages/kilo-gateway/src/api/url.ts` and `src/auth/token.ts`.
 */

import {
  DEFAULT_KILO_API_URL,
  ENV_KILO_API_URL,
  resolveKiloAiGatewayBase,
} from './constants.js'

/**
 * Parse a Kilo URL encoded inside a token. Some tokens carry `https://host:port` prefixes.
 *
 * @param {string} defaultUrl
 * @param {string} token
 * @returns {string}
 */
export function getKiloUrlFromToken(defaultUrl, token) {
  if (!token) return defaultUrl
  const match = token.match(/^(https?:\/\/[^:]+(?::\d+)?(?:\/[^:]*)?):/)
  if (!match) return defaultUrl
  try {
    return new URL(match[1]).toString().replace(/\/+$/, '')
  } catch {
    return defaultUrl
  }
}

/**
 * Validate a Kilo token's shape. Kilo issues long opaque tokens, so anything
 * plausibly non-empty is accepted; an empty value is refused.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isValidKilocodeToken(token) {
  return typeof token === 'string' && token.trim().length > 0
}

/**
 * Read the API key from an options bag, mirroring the upstream helper.
 *
 * @param {{ kilocodeToken?: string; apiKey?: string }} options
 * @returns {string | undefined}
 */
export function getApiKey(options) {
  return options.kilocodeToken ?? options.apiKey
}

function clean(raw) {
  const url = new URL(raw)
  url.search = ''
  url.hash = ''
  return url
}

/** Legacy API app route, e.g. `https://api.kilo.ai/api/openrouter/`. */
function route(raw, name) {
  const url = clean(raw)
  const parts = url.pathname.split('/').filter(Boolean)
  const api = parts.lastIndexOf('api')
  const prefix = api >= 0 ? parts.slice(0, api) : parts
  url.pathname = `/${[...prefix, 'api', name].join('/')}/`
  return url.toString()
}

/**
 * The AI gateway root when `raw` is the configured AI gateway base, `undefined` otherwise.
 *
 * Exported because the FIM and Next Edit endpoints live on the gateway root rather than the
 * legacy `/api/<name>/` app routes.
 *
 * @param {string} raw
 * @returns {string | undefined}
 */
export function gateway(raw) {
  const text = clean(raw).toString().replace(/\/+$/, '')
  const configured = clean(resolveKiloAiGatewayBase()).toString().replace(/\/+$/, '')
  if (text !== configured) return undefined
  return `${text}/`
}

function resolve(options, name) {
  const raw = getKiloUrlFromToken(options.baseURL ?? resolveKiloAiGatewayBase(), options.token ?? '')
  // Always return a bare root with no trailing slash: callers append `/<path>` directly, and a
  // doubled slash makes the gateway's wildcard route miss.
  return (gateway(raw) ?? route(raw, name)).replace(/\/+$/, '')
}

/**
 * Resolve the Kilo API base (profile, balance, device auth, trpc).
 *
 * @returns {string}
 */
export function resolveKiloApiBase() {
  const custom = process.env[ENV_KILO_API_URL]?.trim()
  return custom ? custom.replace(/\/+$/, '') : DEFAULT_KILO_API_URL
}

/**
 * Gateway root, e.g. `https://ai-gateway.kilo.ai/api/v1/`.
 *
 * @param {{ baseURL?: string; token?: string }} [options]
 * @returns {string}
 */
export function resolveKiloGatewayBaseUrl(options = {}) {
  return resolve(options, 'gateway')
}

/**
 * OpenRouter-compatible root, e.g. `https://ai-gateway.kilo.ai/api/openrouter/`.
 * Chat completions, responses, messages, and models live here.
 *
 * @param {{ baseURL?: string; token?: string }} [options]
 * @returns {string}
 */
export function resolveKiloOpenRouterBaseUrl(options = {}) {
  return resolve(options, 'openrouter')
}

/**
 * Resolve a Kilo AI gateway endpoint, e.g. `fim/completions`, against the gateway base.
 *
 * @param {string} path
 * @returns {string}
 */
export function resolveKiloGatewayUrl(path) {
  return `${resolveKiloAiGatewayBase()}/${path}`
}
