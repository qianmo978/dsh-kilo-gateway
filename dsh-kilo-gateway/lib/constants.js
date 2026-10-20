/**
 * Kilo Gateway configuration constants.
 *
 * Ported from `@kilocode/kilo-gateway` (packages/kilo-gateway/src/api/constants.ts)
 * so this plugin speaks the same wire protocol as the Kilo CLI and VS Code extension.
 */

/** Environment variable for a custom Kilo API URL (profile, balance, device auth). */
export const ENV_KILO_API_URL = 'KILO_API_URL'

/** Default Kilo API URL. */
export const DEFAULT_KILO_API_URL = 'https://api.kilo.ai'

/** Environment variable for a custom Kilo AI Gateway URL (gateway traffic only). */
export const ENV_KILO_AI_GATEWAY_URL = 'KILO_AI_GATEWAY_URL'

/** Default Kilo AI Gateway URL. */
export const DEFAULT_KILO_AI_GATEWAY_URL = 'https://ai-gateway.kilo.ai/api/v1'

/** Environment variable for a custom Event Service URL. */
export const KILO_EVENT_SERVICE_URL_ENV = 'EVENT_SERVICE_URL'

/** Default Event Service URL (WebSocket endpoint for kilo-chat events). */
export const KILO_DEFAULT_EVENT_SERVICE_URL = 'wss://events.kiloapps.io'

/**
 * Resolve the base URL for AI gateway traffic (chat, models, embeddings, FIM, ...).
 *
 * `KILO_AI_GATEWAY_URL` takes precedence. When only the legacy `KILO_API_URL` is set,
 * gateway traffic goes to `${KILO_API_URL}/api/gateway/v1`, which the API app
 * rewrites to the AI gateway's `/api/v1` routes.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveKiloAiGatewayBase(env = process.env) {
  const value = env[ENV_KILO_AI_GATEWAY_URL]?.trim()
  if (value) return value.replace(/\/+$/, '')
  const api = env[ENV_KILO_API_URL]?.trim()
  if (api) return `${api.replace(/\/+$/, '')}/api/gateway/v1`
  return DEFAULT_KILO_AI_GATEWAY_URL
}

/** Device auth polling interval in milliseconds. */
export const POLL_INTERVAL_MS = 3000

/** Token expiration duration in milliseconds (1 year). */
export const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000

/** User-Agent header base value for requests. */
export const USER_AGENT_BASE = 'deepseek-harness-kilo-plugin'

/** Content-Type header value for requests. */
export const CONTENT_TYPE = 'application/json'

/** Environment variable for a Kilo Gateway API key. */
export const ENV_KILO_API_KEY = 'KILO_API_KEY'

/** Environment variable for a Kilo Code device/session token (older clients). */
export const ENV_KILOCODE_TOKEN = 'KILOCODE_TOKEN'

/** Environment variable for the organization id sent as `X-KiloCode-OrganizationId`. */
export const ENV_KILO_ORGANIZATION_ID = 'KILOCODE_ORGANIZATIONID'

/**
 * Bearer value the gateway accepts for unauthenticated access.
 *
 * Per https://kilo.ai/docs/gateway/authentication, anonymous requests reach only the free
 * models (`:free` ids) and are rate limited to 200 requests/hour per IP.
 */
export const ANONYMOUS_API_KEY = 'anonymous'

/** Model-id suffix marking a model as free and therefore reachable anonymously. */
export const FREE_MODEL_SUFFIX = ':free'

/**
 * Virtual auto-routing tiers, which are free-accessible and resolve server-side.
 * `kilo-auto/free` is the anonymous-capable one.
 */
export const FREE_AUTO_MODEL = 'kilo-auto/free'

/** Default model for anonymous/free usage. */
export const DEFAULT_FREE_MODEL = FREE_AUTO_MODEL

/** Default model for authenticated users. */
export const DEFAULT_MODEL = 'kilo-auto/efficient'

/** Fetch timeout for model requests in milliseconds (10 seconds). */
export const MODELS_FETCH_TIMEOUT_MS = 10 * 1000

/** Default model-discovery page size. */
export const MODEL_DISCOVERY_LIMIT = 500

/**
 * How long a fetched model catalog is reused before a refresh is attempted.
 *
 * Kilo republishes its catalogue occasionally, but a session should not re-fetch several hundred
 * entries on every dispatch. Fifteen minutes keeps a newly published model reachable in a
 * long-lived session without adding per-request traffic. A failed refresh keeps the previous
 * catalogue, so a transient outage never empties the model list.
 */
export const MODEL_CATALOG_TTL_MS = 15 * 60 * 1000

/** Header names carried on Kilo requests. */
export const HEADER_ORGANIZATIONID = 'X-KILOCODE-ORGANIZATIONID'
export const HEADER_TASKID = 'X-KILOCODE-TASKID'
export const HEADER_PARENT_TASKID = 'X-KILOCODE-PARENT-TASKID'
export const HEADER_PROJECTID = 'X-KILOCODE-PROJECTID'
export const HEADER_TESTER = 'X-KILOCODE-TESTER'
export const HEADER_EDITORNAME = 'X-KILOCODE-EDITORNAME'
export const HEADER_MACHINEID = 'X-KILOCODE-MACHINEID'
export const HEADER_FEATURE = 'X-KILOCODE-FEATURE'

/** Default editor name value. */
export const DEFAULT_EDITOR_NAME = 'DeepSeek Harness'

/** Environment variable name for custom editor name. */
export const ENV_EDITOR_NAME = 'KILOCODE_EDITOR_NAME'

/** Environment variable name for version. */
export const ENV_VERSION = 'KILOCODE_VERSION'

/** Tester header value for suppressing warnings. */
export const TESTER_SUPPRESS_VALUE = 'SUPPRESS'

/** Environment variable name for feature override. */
export const ENV_FEATURE = 'KILOCODE_FEATURE'
