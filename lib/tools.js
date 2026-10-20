/**
 * Kilo Gateway agent tools.
 *
 * These expose the Kilo capability that has no first-class harness seam: account state,
 * autocomplete (FIM / Next Edit), the embedding-model catalogue, and notifications.
 * Chat is already served by the `kilo` provider route on `ctx.llm`, so it is not duplicated here.
 *
 * Both `parameters` and `output.schema` are written as **raw JSON Schema** on purpose. Shipped
 * tools pass through `defineTool` to compile the author DSL, but a bundle cannot import
 * `@deepseek-ai/dsh-tools` (its peer copy is a different object identity than the registry is
 * running), and `register` validates `output.schema` as raw JSON Schema. Hand-writing the raw
 * form is what the registry actually accepts.
 *
 * Enforced subset: exactly one of `type` or `oneOf` per node; `required` must name keys present
 * in `properties`; `additionalProperties` is mandatory on every object; no type arrays.
 */

import {
  fetchByokEntries,
  fetchCodingPlanSubscriptions,
  fetchCodingPlanUsage,
  fetchKilocodeNotifications,
  fetchKiloPassState,
  KiloCloudError,
} from './account.js'
import { fetchEmbeddingModelCatalog, fetchProfile } from './api.js'
import { AUTOCOMPLETE_MODELS, getAutocompleteModel, getAutocompleteModelById, requestCompletion } from './fim.js'
import { buildKiloHeaders, getDefaultHeaders, mergeHeaders } from './headers.js'
import { describeToken, resolveAuth } from './token-store.js'
import { resolveKiloAiGatewayBase } from './constants.js'

/**
 * A tool outcome the model can read and act on, rather than a thrown harness error.
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ code: string; message: string }}
 */
function failure(code, message) {
  return { code, message }
}

/**
 * Normalize any thrown value into a routable failure code.
 *
 * @param {unknown} error
 * @returns {{ code: string; message: string }}
 */
function failureOf(error) {
  if (error instanceof KiloCloudError) return failure(error.kind, error.message)
  if (error instanceof Error) return failure('internal_error', error.message)
  return failure('internal_error', String(error))
}

/** Error branch shared by every Kilo tool output. */
const ERROR_BRANCH = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['code', 'message'],
}

/**
 * Build a `{ oneOf: [SUCCESS, ERROR] }` output schema plus a compact renderer.
 *
 * @param {Record<string, any>} success
 * @param {(value: any) => string} [summarize]
 */
function toolOutput(success, summarize) {
  return {
    schema: { oneOf: [success, ERROR_BRANCH] },
    render: (_args, value) => [
      { type: 'text', text: summarize !== undefined ? summarize(value) : JSON.stringify(value) },
    ],
  }
}

/**
 * Register every Kilo tool. Returns one disposer that unregisters all of them.
 *
 * @param {any} ctx
 * @param {{ apiKeyEnv?: string }} [options]
 * @returns {() => void}
 */
export function registerKiloTools(ctx, options = {}) {
  const tools = ctx.get?.('tools')
  if (tools === undefined || typeof tools.register !== 'function') return () => undefined

  /** @param {any} toolCtx */
  const authOf = (toolCtx) =>
    resolveAuth(toolCtx, { ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}) })

  /** @type {(() => void)[]} */
  const disposers = []
  const register = (definition) => {
    const dispose = tools.register(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // ------------------------------------------------------------------ account

  register({
    name: 'kilo_account',
    description:
      'Read the signed-in Kilo Gateway account: profile, selected organization, Kilo Pass credit state, coding-plan subscriptions, and bring-your-own-key entries. Use this to check quota before a long run or to see which plan is active.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeQuota: {
          type: 'boolean',
          description: 'Also fetch per-subscription quota windows. Costs one extra request per subscription.',
        },
      },
    },
    output: toolOutput({
      type: 'object',
      additionalProperties: false,
      properties: {
        signedIn: { type: 'boolean' },
        accountEmail: { type: 'string' },
        selectedOrganizationId: { type: 'string' },
        organizationCount: { type: 'integer' },
        kiloPass: {
          type: 'object',
          additionalProperties: false,
          properties: {
            active: { type: 'boolean' },
            currentPeriodBaseCreditsUsd: { type: 'number' },
            currentPeriodUsageUsd: { type: 'number' },
            currentPeriodBonusCreditsUsd: { type: 'number' },
            nextBillingAt: { type: 'string' },
          },
          required: [
            'active',
            'currentPeriodBaseCreditsUsd',
            'currentPeriodUsageUsd',
            'currentPeriodBonusCreditsUsd',
            'nextBillingAt',
          ],
        },
        subscriptions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              planName: { type: 'string' },
              providerName: { type: 'string' },
              status: { type: 'string' },
              canQueryUsage: { type: 'boolean' },
              cancelAtPeriodEnd: { type: 'boolean' },
              windows: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    remainingPercent: { type: 'number' },
                    resetsAt: { type: 'string' },
                  },
                  required: ['id', 'remainingPercent', 'resetsAt'],
                },
              },
            },
            required: ['id', 'planName', 'providerName', 'status', 'canQueryUsage', 'cancelAtPeriodEnd', 'windows'],
          },
        },
        byok: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              providerId: { type: 'string' },
              managementSource: { type: 'string' },
              isEnabled: { type: 'boolean' },
            },
            required: ['id', 'providerId', 'managementSource', 'isEnabled'],
          },
        },
      },
      required: ['signedIn', 'accountEmail', 'selectedOrganizationId', 'organizationCount', 'kiloPass', 'subscriptions', 'byok'],
    }),
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const auth = await authOf(ctx)
      if (auth.token === undefined) {
        return failure(
          'not_signed_in',
          'No Kilo credential is configured. Type an API key into the Kilo Gateway entry on the Models settings page, or export KILO_API_KEY.',
        )
      }
      try {
        const token = auth.token
        const profile = await fetchProfile(token)
        const pass = await fetchKiloPassState(token)
        const subscriptions = await fetchCodingPlanSubscriptions(token).catch(() => [])

        // Quota windows cost one request per subscription, so they stay opt-in.
        const resolved =
          args?.includeQuota === true
            ? await Promise.all(
                subscriptions
                  .filter((subscription) => subscription.canQueryUsage)
                  .map(async (subscription) => {
                    const usage = await fetchCodingPlanUsage(token, subscription.id).catch(() => undefined)
                    return {
                      ...subscription,
                      windows:
                        usage?.windows.map((window) => ({
                          id: window.id,
                          remainingPercent: window.remainingPercent,
                          resetsAt: window.resetsAt,
                        })) ?? [],
                    }
                  }),
              )
            : subscriptions.map((subscription) => ({ ...subscription, windows: [] }))

        return {
          signedIn: true,
          accountEmail: profile.email ?? '',
          selectedOrganizationId: auth.organizationId ?? profile.selectedOrganizationId ?? '',
          organizationCount: profile.organizations?.length ?? 0,
          kiloPass:
            pass === null
              ? {
                  active: false,
                  currentPeriodBaseCreditsUsd: 0,
                  currentPeriodUsageUsd: 0,
                  currentPeriodBonusCreditsUsd: 0,
                  nextBillingAt: '',
                }
              : {
                  active: true,
                  currentPeriodBaseCreditsUsd: pass.currentPeriodBaseCreditsUsd,
                  currentPeriodUsageUsd: pass.currentPeriodUsageUsd,
                  currentPeriodBonusCreditsUsd: pass.currentPeriodBonusCreditsUsd,
                  nextBillingAt: pass.nextBillingAt ?? '',
                },
          subscriptions: resolved.map((entry) => ({
            id: entry.id,
            planName: entry.planName,
            providerName: entry.providerName,
            status: entry.status,
            canQueryUsage: entry.canQueryUsage,
            cancelAtPeriodEnd: entry.cancelAtPeriodEnd,
            windows: entry.windows,
          })),
          byok: await fetchByokEntries(token).catch(() => []),
        }
      } catch (error) {
        return failureOf(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read Kilo account', kind: 'read' }),
  })

  // ------------------------------------------------------------- autocomplete

  register({
    name: 'kilo_complete',
    description:
      'Get a Kilo Gateway code completion for the code you are writing. Sends the text before the cursor as `prompt` and, for FIM models, the text after the cursor as `suffix`. Use for line or function-body completion; use chat for anything needing reasoning or tool calls.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'The code immediately before the cursor.',
        },
        suffix: {
          type: 'string',
          description: 'The code immediately after the cursor. Enables mid-file FIM completion.',
        },
        modelId: {
          type: 'string',
          description:
            'Autocomplete model id. Omit to use the Kilo default Next Edit model. Pass a kilo/ id to route through the gateway.',
          enum: AUTOCOMPLETE_MODELS.filter((model) => model.providerID === 'kilo').map((model) => model.id),
        },
        maxTokens: { type: 'integer', description: 'Maximum tokens to generate.' },
      },
      required: ['prompt'],
    },
    output: toolOutput(
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          completion: { type: 'string' },
          model: { type: 'string' },
          kind: { type: 'string' },
        },
        required: ['completion', 'model', 'kind'],
      },
      (value) => (typeof value?.completion === 'string' ? value.completion : JSON.stringify(value)),
    ),
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const { token, organizationId } = await authOf(ctx)
        const definition =
          args?.modelId === undefined ? getAutocompleteModel('kilo', undefined) : getAutocompleteModelById(args.modelId)

        // The direct BYOK models need the caller's own provider key, which this bundle does not hold.
        if (definition.providerID !== 'kilo') {
          return failure(
            'provider_not_supported',
            `${definition.provider} autocomplete needs its own provider key and is not reachable through the Kilo Gateway.`,
          )
        }

        const result = await requestCompletion({
          prompt: args.prompt,
          ...(args.suffix === undefined ? {} : { suffix: args.suffix }),
          model: definition.modelID,
          ...(definition.kind === 'edit' ? { kind: 'edit' } : {}),
          ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
          ...(token ? { token } : {}),
          ...(organizationId ? { organizationId } : {}),
          signal: exec.signal,
          gatewayBase: resolveKiloAiGatewayBase(),
          headers: (requestToken, requestOrg) =>
            mergeHeaders(
              getDefaultHeaders(),
              buildKiloHeaders(undefined, { ...(requestOrg ? { kilocodeOrganizationId: requestOrg } : {}) }),
              { Authorization: `Bearer ${requestToken ?? 'anonymous'}` },
            ),
        })
        return { completion: result.completion, model: result.model, kind: result.kind }
      } catch (error) {
        return failureOf(error)
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Kilo code completion',
      kind: 'execute',
      rawInput: args?.prompt,
    }),
  })

  // --------------------------------------------------------------- embeddings

  register({
    name: 'kilo_embedding_models',
    description:
      'List the embedding models the Kilo Gateway advertises, with their vector dimensions and default similarity thresholds. Use to choose a model before indexing or searching code.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: toolOutput({
      type: 'object',
      additionalProperties: false,
      properties: {
        defaultModel: { type: 'string' },
        models: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              dimension: { type: 'integer' },
              scoreThreshold: { type: 'number' },
            },
            required: ['id', 'name', 'dimension', 'scoreThreshold'],
          },
        },
      },
      required: ['defaultModel', 'models'],
    }),
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const { token } = await authOf(ctx)
        const catalog = await fetchEmbeddingModelCatalog(token === undefined ? {} : { token })
        if (catalog.models.length === 0) {
          return failure('catalog_unavailable', 'Kilo returned no embedding models.')
        }
        return {
          defaultModel: catalog.defaultModel,
          models: catalog.models.map((model) => ({
            id: model.id,
            name: model.name,
            dimension: model.dimension,
            scoreThreshold: model.scoreThreshold,
          })),
        }
      } catch (error) {
        return failureOf(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List Kilo embedding models', kind: 'read' }),
  })

  // ------------------------------------------------------------ notifications

  register({
    name: 'kilo_notifications',
    description:
      'List notifications published for this Kilo account, such as plan changes, credit grants, or service incidents. Returns an empty list when nothing is pending.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: toolOutput({
      type: 'object',
      additionalProperties: false,
      properties: {
        notifications: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['id', 'title', 'message'],
          },
        },
      },
      required: ['notifications'],
    }),
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const { token, organizationId } = await authOf(ctx)
        const notifications = await fetchKilocodeNotifications({
          ...(token ? { kilocodeToken: token } : {}),
          ...(organizationId ? { kilocodeOrganizationId: organizationId } : {}),
        })
        return {
          notifications: notifications.map((notification) => ({
            id: notification.id,
            title: notification.title,
            message: notification.message,
          })),
        }
      } catch (error) {
        return failureOf(error)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read Kilo notifications', kind: 'read' }),
  })

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // A disposer that throws during teardown must not block the others.
      }
    }
  }
}
