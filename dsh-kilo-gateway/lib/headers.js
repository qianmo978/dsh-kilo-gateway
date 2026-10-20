/**
 * Kilo request headers.
 *
 * Ported from `packages/kilo-gateway/src/headers.ts`.
 */

import {
  CONTENT_TYPE,
  DEFAULT_EDITOR_NAME,
  ENV_EDITOR_NAME,
  ENV_FEATURE,
  ENV_VERSION,
  HEADER_EDITORNAME,
  HEADER_FEATURE,
  HEADER_MACHINEID,
  HEADER_ORGANIZATIONID,
  HEADER_PROJECTID,
  HEADER_TASKID,
  HEADER_TESTER,
  TESTER_SUPPRESS_VALUE,
  USER_AGENT_BASE,
} from './constants.js'

/**
 * Feature header value from `KILOCODE_FEATURE`. Returns `undefined` when unset —
 * the gateway stores NULL (unattributed), so callers must opt in explicitly.
 *
 * @returns {string | undefined}
 */
export function getFeatureHeader() {
  return process.env[ENV_FEATURE] || undefined
}

/**
 * User-Agent header value, appending `KILOCODE_VERSION` when available.
 *
 * @returns {string}
 */
export function getUserAgent() {
  const version = process.env[ENV_VERSION]
  return version ? `${USER_AGENT_BASE}/${version}` : USER_AGENT_BASE
}

/**
 * Default headers for Kilo requests.
 *
 * @returns {Record<string, string>}
 */
export function getDefaultHeaders() {
  return {
    'User-Agent': getUserAgent(),
    'Content-Type': CONTENT_TYPE,
  }
}

/**
 * Editor name header value. An explicit `KILOCODE_EDITOR_NAME` wins verbatim;
 * otherwise the default editor name carries `KILOCODE_VERSION` when set.
 *
 * @returns {string}
 */
export function getEditorNameHeader() {
  const custom = process.env[ENV_EDITOR_NAME]
  if (custom) return custom
  const version = process.env[ENV_VERSION]
  return version ? `${DEFAULT_EDITOR_NAME} ${version}` : DEFAULT_EDITOR_NAME
}

/**
 * Build Kilo-specific headers from metadata and options.
 *
 * @param {{ taskId?: string; projectId?: string }} [metadata]
 * @param {{ kilocodeOrganizationId?: string; kilocodeTesterWarningsDisabledUntil?: number; machineId?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildKiloHeaders(metadata, options) {
  const feature = getFeatureHeader()
  /** @type {Record<string, string>} */
  const headers = {
    [HEADER_EDITORNAME]: getEditorNameHeader(),
    ...(feature ? { [HEADER_FEATURE]: feature } : {}),
  }

  if (metadata?.taskId) {
    headers[HEADER_TASKID] = metadata.taskId
  }

  if (options?.kilocodeOrganizationId) {
    headers[HEADER_ORGANIZATIONID] = options.kilocodeOrganizationId
    if (metadata?.projectId) {
      headers[HEADER_PROJECTID] = metadata.projectId
    }
  }

  if (options?.kilocodeTesterWarningsDisabledUntil && options.kilocodeTesterWarningsDisabledUntil > Date.now()) {
    headers[HEADER_TESTER] = TESTER_SUPPRESS_VALUE
  }

  if (options?.machineId) {
    headers[HEADER_MACHINEID] = options.machineId
  }

  return headers
}

/**
 * Merge the default headers, Kilo headers, and per-request headers into one plain object.
 *
 * @param {Record<string, string>} base
 * @param {Record<string, string> | undefined} extra
 * @returns {Record<string, string>}
 */
export function mergeHeaders(base, extra) {
  return { ...base, ...(extra ?? {}) }
}
