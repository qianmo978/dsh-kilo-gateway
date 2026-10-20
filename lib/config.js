/**
 * Kilo Gateway plugin configuration surface.
 *
 * The Harness renders provider configuration from a plugin's `Config` schema, and a field marked
 * `role('credential-ref')` becomes a secret input bound to the credentials service rather than a
 * plain string in the patch file. That is the supported way for a user to type an API key into the
 * product: the value lands in `$DSH_HOME/.credentials.yaml`, never in plugin config.
 *
 * The schema must be a real schemastery instance because the Loader validates each row's `config`
 * through `Config.validate(...)`; a plain object fails activation with
 * `Cannot read properties of undefined (reading 'validate')`.
 */

import z from '@deepseek-ai/schemastery'

/** Default reference the key is stored behind. */
export const DEFAULT_API_KEY_REF = 'KILO_API_KEY'

/**
 * The plugin's configuration schema.
 *
 * `apiKeyEnv` is what carries the key: the settings renderer treats a `credential-ref` field as a
 * secret input and writes the typed value through the credentials service under that name, so
 * pointing it at a name you already use elsewhere reuses the stored secret instead of copying it.
 *
 * Every field is `volatile()`, so a change is picked up by a live reload rather than being frozen
 * into the patch on first write.
 */
export const Config = z.object({
  apiKeyEnv: z
    .string()
    .role('credential-ref')
    .default(DEFAULT_API_KEY_REF)
    .volatile()
    .description(
      'Credential reference holding the Kilo Gateway API key. Set it to the name you already store the key under to reuse it; the plugin never copies the secret.',
    ),
  baseURL: z
    .string()
    .volatile()
    .description('Override the gateway base URL; defaults to https://ai-gateway.kilo.ai/api/v1.'),
  organizationId: z
    .string()
    .volatile()
    .description('Organization id sent as X-KiloCode-OrganizationId for org-scoped requests. Overrides the environment.'),
  repairBudget: z
    .number()
    .default(2)
    .volatile()
    .description(
      'How many repair-and-replay rounds one request may spend before giving up. Each round costs a full upstream request, so keep it small; 0 disables self-healing entirely.',
    ),
  streamIdleTimeoutMs: z
    .number()
    .default(90_000)
    .volatile()
    .description(
      'How long a stream may deliver nothing before it is treated as stalled and retried. Bounds how long a wedged connection can look like a freeze.',
    ),
})