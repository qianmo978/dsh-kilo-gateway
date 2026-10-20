/**
 * Kilo device-authorization login flow.
 *
 * Registers one flow on the `authorization` seam keyed by the credential record it writes,
 * so the Harness surfaces (web Models page, CLI) render it alongside every other provider
 * sign-in. Ported from `packages/kilo-gateway/src/auth/device-auth.ts`.
 *
 * Both seams are resolved with `ctx.get(...)`: a bundle's own peer copies of the Harness
 * packages are not the same object identities the Loader holds.
 */

import { runDeviceAuthFlow, fetchProfile, defaultOrganizationId } from './api.js'
import { storeGrantToken, storeOrganizationId, KILO_TOKEN_KEY } from './token-store.js'

/**
 * Register the Kilo sign-in flow when the authorization seam is present.
 *
 * @param {any} ctx
 * @returns {() => void} disposer
 */
export function registerKiloAuth(ctx) {
  const authorization = ctx.get?.('authorization')
  if (authorization === undefined) return () => undefined

  return authorization.registerFlow({
    key: KILO_TOKEN_KEY,
    label: 'Kilo Gateway',
    methods: [{ id: 'device-code', label: 'Sign in with a Kilo Code account' }],

    /**
     * Drive device authorization, then commit the credential record through the seam's own
     * `commit`, which is the only write the attempt observes.
     *
     * @param {{ signal: AbortSignal; notify: (notice: unknown) => void; commit: (record: unknown) => Promise<void> }} session
     */
    async run(session) {
      const { token, userEmail } = await runDeviceAuthFlow({
        signal: session.signal,
        onPrompt: (info) =>
          session.notify({
            kind: 'url',
            message: `Open the Kilo verification page and enter this code to finish signing in. Code: ${info.code}`,
            url: info.verificationUrl,
          }),
      })

      // Resolve the organization once at login time, not on every request.
      let organizationId
      try {
        organizationId = defaultOrganizationId(await fetchProfile(token))
      } catch (error) {
        ctx.logger?.warn?.('kilo-gateway: profile fetch after login failed', error)
      }

      // `commit` takes a tagged `CredentialRecord`, not a bare value: the record half of the
      // credentials seam is a discriminated union, and an untagged entry is rejected at the next
      // boot rather than merely failing to read back.
      await session.commit({ kind: 'api-key', key: token })

      if (organizationId !== undefined) {
        try {
          await storeOrganizationId(ctx, organizationId)
        } catch (error) {
          ctx.logger?.warn?.('kilo-gateway: could not store the selected organization', error)
        }
      }

      if (userEmail) {
        session.notify({ kind: 'text', message: `Signed in to Kilo as ${userEmail}.` })
      }
    },
  })
}
