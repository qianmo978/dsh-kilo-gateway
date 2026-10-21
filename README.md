# Kilo Gateway

A DeepSeek Harness plugin that turns the **Kilo Code Gateway** into a first-party model
provider, ported from [`@kilocode/kilo-gateway`](https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-gateway)
(MIT).

## Authentication

Three sources, in precedence order:

| Order | Source | Notes |
|---|---|---|
| 1 | Credential store | Written by this bundle's own settings page, or by `kilo_login`. The normal path. |
| 2 | `KILO_API_KEY` | Ambient environment, for a shell or CI. |
| 3 | `KILOCODE_TOKEN` | Older device/session token. |
| 4 | Anonymous | Nothing configured. `Bearer anonymous`, **free models only**, 200 requests/hour per IP. |

`KILOCODE_ORGANIZATIONID` sets `X-KiloCode-OrganizationId` for organization-scoped requests.

### Entering the key

The key is entered on this bundle's own page in the Settings panel — **Settings → Kilo Gateway** —
which the browser half of this bundle contributes. The page writes the secret through the generated
`remote.credentials` namespace (the same surface the built-in Models page uses) under the
`KILO_API_KEY` reference, so the value lands in the credential store and never in a patch file.

Why a page of its own, instead of the Models settings card: the Models page is not a generic schema
renderer. Its editor picks one of exactly two curated layouts from the **settings namespace**, and
renders nothing but a hint for any other:

```js
function layoutOf(ns) {
  if (ns === 'llm-deepseek') return 'deepseek'
  if (ns === 'llm-pi-ai')   return 'pi-ai'
  return 'unknown'   // <- "Other fields live in cordis.patch.yml" and no inputs at all
}
```

A private namespace can therefore never show an API-key input there, whatever a plugin's own
`Config` schema marks as `role('credential-ref')`. That marker only tells a renderer how to treat a
field it is already being asked to render; it does not enroll a namespace into the curated families.
So this bundle does not declare itself into the Models directory at all: it serves the `kilo` route
with its own adapter (below) and puts the key form where a form is actually renderable.

### Three ways to supply the key

1. **Settings page** — open Settings, pick **Kilo Gateway**, and paste the key into the secret
   field. This is the intended path. The secret is stored under the `KILO_API_KEY` reference.
2. **Reuse an existing reference** — set `apiKeyEnv` to a name you already store the key under, and
   the plugin reads it in place. **No copy is made.**
3. **Environment** — `KILO_API_KEY` or `KILOCODE_TOKEN`, layered under the store, for a shell or CI.

A configured reference that is blank, unknown, or not a legal reference name is skipped rather than
raising, so a typo degrades to the next source instead of breaking dispatch.

### The browser half's contract

The client loader is strict, and a violation of any of these rules fails the **whole** client boot
(`web boot: 1 entry did not activate`), which takes the entire web shell down — not just this
plugin's page. The rules, each taken from the built-in Models page (`dsh-client-ui-settings-models`),
which registers into the same slot and works:

| Rule | Consequence of getting it wrong |
|---|---|
| The plugin's `inject` names **full service keys** (`remote.credentials`, not just `remote`). | An undeclared service throws inside `apply()`, and the fiber ends in state `failed`. |
| A namespace is read through the **declared property**, never through `ctx.get`. | The client context exposes a service only when the plugin declared it, and the remote namespaces are Typert remotes rather than cordis Services — `ctx.get('remote')` finds nothing, and the page silently shows "credential store unavailable". |
| The manifest's `dsh.client.inject` names the **packages that provide** those services (`@deepseek-ai/dsh-api-remotes`, `@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-ui-renderer`). | The bundle is composed before its providers exist, and the services never arrive. |
| The manifest's `dsh.client` carries `platform` and `inject`, and **no `immediately`**. | `immediately: true` is legal, but it makes the entry's activation part of the boot's critical path. |
| `ctx.locale.register(ns, { zh, en })` takes **one dictionary per language** in a single call. | The three-argument `register(ns, locale, dict)` form is a different overload with different rules. |
| Every contribution is guarded at **both** boundaries: the eager `ctx.slots.inject(...)` call, and the deferred callback the slot runtime invokes later. | A throw in the deferred callback happens long after `apply()` returned, where no enclosing `try/catch` can catch it. |
| The slot registration options are `{ name, id, order, label }`, and `label` is a thunk. | A shape break here throws synchronously inside `slots.inject`. |

The `slots` service notes one more trap, quoted from a sibling plugin:

> Callback effects are synchronous disposers; iterable effects install transactionally and dispose in
> reverse order.

so the `slots.inject` callback must return the disposer `slots.register` hands back — never
`undefined`.

### What this plugin depends on

Only services the Harness itself ships. `@deepseek-ai/dsh-api-remotes` is a **protected core
module**: it is a dependency of the app itself, and the plugin hub refuses to let anyone toggle it
off, so every host that has a settings panel also has the credential remote. There is no
dependency on a plugin that can be uninstalled, and nothing in this bundle reads or writes any file
outside the profile's own credential store.

## The host half's contract

The adapter is handed a `GenerateOptions` object by the Harness. Its shape is fixed by the
shipped `@deepseek-ai/dsh-llm`, and one field in it is easy to get wrong:

```ts
interface GenerateOptions {
  provider: string
  model: string
  messages: RequestMessage[]
  system?: string
  tools?: ToolSchema[]
  toolHistory?: ToolHistory      // an OBJECT, not an array
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  purpose?: 'compaction' | 'session-title'
}

interface ToolHistory {
  readonly tools: readonly ToolSchema[]
  readonly updates: readonly { readonly messageId: MessageId; readonly additions: readonly ToolSchema[] }[]
}
```

`toolHistory` is that **object**. Reading it as an array of updates throws
`toolHistory is not iterable` on every dispatch that carries a tool history — and a
`toolHistory.length === 0` guard does not catch the mistake, because the length of an object is
`undefined`, so the comparison is false and the loop runs anyway.

The host reports that failure as `LlmError: toolHistory is not iterable` with code `UNKNOWN`,
thrown from `ReactLoopAgent.step`. That stack is where the host **re-throws** an adapter failure,
not where the failure originated: the host wraps a non-`LlmError` as
`{ message: errorChain(error), code: 'UNKNOWN' }`. A bare `TypeError` message with code `UNKNOWN`
therefore points at the adapter, and the real throw site is wherever the plugin read the option.

Two more traps in the same interface:

- `streamCall(options, model)` receives the model as a **string id**, not a model object. A model
  object stringifies to `[object Object]` in every message that mentions the model.
- `ToolSchema` carries a `deferLoading` flag that is a Harness loading strategy, not provider
  wire content. It must not be forwarded to the provider.

### Keeping a long-lived install working

A credential that worked once can stop working: a key gets rotated, a device grant expires, or a
token is revoked out of band. Failing identically on every later turn would make the provider
unusable until the process restarted, so a rejected credential is demoted rather than re-tried
forever:

- A token that comes back `401`/`403` is remembered as bad for ten minutes and skipped on later
  dispatches, so a stale `KILO_API_KEY` in the environment stops shadowing a valid stored grant.
- A successful sign-in or key write clears that memory immediately.
- The model catalogue is cached for fifteen minutes rather than per request, and a failed refresh
  keeps the previous catalogue, so a transient outage degrades to slightly stale metadata instead of
  an empty model list.

### Anonymous vs. keyed

Anonymous access is genuinely usable: the plugin filters the catalog down to models it can
actually reach, so `kilo-auto/free` and the `:free` ids are selectable without any credential.
Selecting a paid model while anonymous fails immediately with a clear `AUTH` error naming the
fix, instead of a bare 401 from the gateway.

Note Kilo's own warning about `kilo-auto/free`: it may route to providers that log prompts and
use them for training. Do not send confidential data through the free tier.

## Credential records

The record half of the credentials seam is a **discriminated union**, not a free-form bag:

```ts
type CredentialRecord = ApiKeyRecord | GrantRecord
interface ApiKeyRecord { kind: 'api-key'; key?: string; env?: Record<string,string> }
interface GrantRecord  { kind: 'grant';   payload: unknown }
```

Two consequences the plugin is careful about:

- A record written without a `kind` **passes the write guard** (`assertStorableApiKey` only inspects
  `key`/`env`) and then **throws at the next boot** (`record "..." has no kind`), failing the
  credentials plugin's activation for the whole profile. `describeRecord` still reports
  `configured: true` in the meantime, so the mistake is silent until restart.
- Readers must check `kind === 'api-key'`; a `grant` record is valid and configured but carries no
  readable secret.

Tokens are therefore written as `{ kind: 'api-key', key: token }` and read with a `kind` check.


## Per-model context windows

Every Kilo model declares its own `context_length` and `top_provider.max_completion_tokens`, and
they differ by orders of magnitude — a 1M-token router sits next to a 256K one. Getting these into
the harness correctly is what stops the gateway rejecting a request with an opaque 400.

`resolveModel` reports each model's real capacity in the exact shape the runtime validates:

```js
{
  provider, id, name,
  inputModalities: ['text', 'image'],
  context: { contextWindow: 1_000_000 },   // nested — a top-level contextWindow is ignored
  defaultMaxTokens: 65_536,                // not `maxTokens`
}
```

`@deepseek-ai/dsh-compaction-basic` then compacts proactively: on every step it reads
`context.contextWindow`, budgets `contextWindow − reservedCompletionTokens − 65536 headroom`, and
summarizes once measured history passes `min(window × 0.8, that budget)`.

Two consequences drive `lib/limits.js`:

1. **A window too small to absorb the harness's 64K headroom would make compaction throw.** The
   error is caught and logged, and the turn continues with the request **untruncated** until the
   provider rejects it. So `limitsOf` never reports a window below `MINIMUM_REPORTABLE_CONTEXT_WINDOW`
   (98 304), and caps the output reservation to leave both the headroom *and* a 32 768-token pressure
   floor. `declaredContextWindow` keeps the true catalog figure alongside.
2. **The output cap is derived, not squeezed per-call.** The harness already reserved output while
   compacting, so `max_tokens` is the model's own cap, trimmed only if the assembled request would
   otherwise overflow.

The pressure floor matters for a specific real case: `mistralai/devstral-2512` declares a
209 715-token completion cap against a 262 144-token window. Clamping output to `window − headroom`
alone lands the reservation at exactly 65 536, leaving `pressureBudget = 0` and making compaction
throw — the very failure the accounting exists to prevent. Reserving 32 768 on top keeps it positive.

`compactionBudget(limits)` mirrors the harness arithmetic, so you can check whether a given model
will actually compact rather than discovering it from a failed turn.

`listModels` deliberately carries **no** capacity fields: the runtime validates that projection as
`{ provider, id, name, description?, inputModalities? }` and silently drops anything else.

### Streaming and reasoning

The SSE reader is line-based, not blank-line-split: SSE permits `\n`, `\r\n`, or `\r` terminators,
and Kilo's gateway streams **CRLF**. A naive `indexOf('\n\n')` finds no boundary in that stream and
silently yields nothing, which reads downstream as an empty response. Frames are terminated by an
empty line, consecutive `data:` lines are joined with `\n` per spec, and a stream that ends without
its terminating blank line is flushed.

Kilo sends reasoning twice — a plain `delta.reasoning` string and a structured
`reasoning_details` array mixing readable `reasoning.text` entries with encrypted
`reasoning.encrypted` ones. The adapter prefers the string and falls back to the readable entries.

An answer-less response is therefore not automatically a failure, and is classified by what
actually arrived:

| Outcome | Reported as |
|---|---|
| Reasoning arrived, answer did not | `finish` with kind `max-tokens` |
| Provider billed output but streamed nothing readable | `MALFORMED_RESPONSE` |
| Entirely empty stream | `EMPTY_RESPONSE` (retried) |

Token estimation is deliberately pessimistic (3 characters per token); over-estimating only costs
margin, under-estimating causes the failure this exists to prevent.

### Block lifecycle and usage

Every opened block is closed with `block-end` carrying the finished `ContentBlock`, and token usage
is emitted as its own `usage` chunk rather than attached to `finish`. Both matter:

- `block-end` is the only way a block's content reaches the session log. A stream that never closes
  its blocks streams text the user can see but that never becomes history, so the agent loop loses
  the reply.
- Usage arrives **after** the terminal `finish_reason` on OpenRouter-compatible streams. The adapter
  therefore records the reason and keeps reading until the stream actually ends, then emits blocks,
  usage, and `finish` in that order — otherwise every such response reports zero tokens.

## Failure handling

`lib/resilience.js` splits failures into two families, because they need opposite treatment.

**Parameter faults are deterministic.** The same body is rejected the same way every time, so
replaying it verbatim only wastes money. Each carries an exact repair:

| Fault | Repair |
|---|---|
| Context length exceeded | Trim the oldest half of the history, keeping the system message |
| Tool definitions rejected | Drop the tool declarations |
| Images rejected by a text-only model | Strip image parts, keep every message |
| A named invalid field | Drop that field |
| Any other validator rejection | Trim history |

Repairs only ever *remove* something, which is what makes replaying one safe: removal cannot
introduce a rejection the original body did not already have. The budget is two rounds by default
(`repairBudget`), because a request needing three different repairs is one the agent should see
rather than keep paying for.

**Stream faults are stochastic.** A reset socket, a truncated body, a 5xx, or a stalled connection
is retried. Retries are silent: nothing is printed, nothing reaches the agent, and no error is
logged unless every attempt fails.

What decides whether a retry is acceptable is whether the user is already looking at an answer:

| State | Action |
|---|---|
| Nothing emitted yet | Retry silently — the failure is invisible |
| Text already streamed | Never restart it; keep the partial answer |
| A tool call already emitted | Never retry — a second call could duplicate a side effect |

A caller cancel is never retried and is rethrown as the caller's own error, so the harness sees a
cancellation rather than a mislabelled gateway failure. A stream that delivers nothing for
`streamIdleTimeoutMs` is treated as stalled, so a wedged connection surfaces as a retry rather than a
long freeze.

`MALFORMED_RESPONSE` is deliberately excluded from `retryableCodes`: the provider billed output it
never sent, so replaying would spend the same money for the same empty result.

## What it does

- **Provider route `kilo`** — registered on `ctx.llm` with this bundle's own adapter, which speaks
  the OpenRouter-compatible wire protocol exposed at `https://ai-gateway.kilo.ai/api/openrouter`
  (chat completions, streaming SSE, tool calls, reasoning deltas, usage accounting, self-healing
  retries).
- **Dedicated settings page** — the browser half contributes a "Kilo Gateway" page in the Settings
  panel holding the API-key form, because the Models page cannot render one for a private namespace.
- **Device-authorization sign-in** — a flow on the `authorization` seam keyed to the credential
  record it writes, so the Kilo token lands in the Harness credential store and every surface
  that renders sign-in flows shows "Kilo Gateway" beside the others.
- **Agent tools** — account state, code completion, the embedding catalogue, and notifications. See
  below.
- **Anonymous fallback** — the route is registered before sign-in, so a session can select `kilo`
  immediately and run on Kilo's free tier.

## Agent tools

| Tool | Purpose |
|---|---|
| `kilo_account` | Profile, selected organization, Kilo Pass credits, coding-plan subscriptions and quotas, BYOK entries |
| `kilo_complete` | Code completion via Kilo FIM (`fim/completions`) or Next Edit (`edit`), with `prompt`/`suffix` |
| `kilo_embedding_models` | The embedding catalogue Kilo advertises, with dimensions and score thresholds |
| `kilo_notifications` | Account notifications: plan changes, credit grants, service incidents |
| `kilo_login` | Device-code sign-in when the agent needs to renew a token |

`kilo_complete` defaults to `inception/mercury-next-edit` and accepts
`kilo/mistralai/codestral-2508` and `kilo/inception/mercury-edit-2`. The direct-BYOK autocomplete
models (Mistral, Inception) are listed upstream but deliberately not routable here: they need the
caller's own provider key, not the Kilo Gateway credential, so the tool refuses them with
`provider_not_supported`.

### Sign-in

`kilo_login` needs an existing credential to authorize the device-code request, exactly like
`kilo_login` in the Harness's own OAuth tool: it **renews** a token that exists but was
rejected, and cannot create a first credential. For a first-time sign-in, use the Kilo Gateway
entry on the account page — the `authorization` flow is what writes the first token.

## Why it does not import `@deepseek-ai/dsh-*`

A bundle resolves its peer dependencies to its own copies under the profile's `node_modules`.
Importing `@deepseek-ai/dsh-llm` for `LlmAdapter`/`resolveRetryPolicy`, or `@deepseek-ai/dsh-tools`
for `defineTool`, would give this package a *different* `Service`/`Context` class identity than
the one the Loader is running, so `Context.is()` inside `TypertRemoteService` fails and
activation dies with `Cannot read properties of undefined (reading 'ctx')`.

The adapter therefore duck-types the `LlmAdapter` surface and reconstructs the two things it
needs structurally (`KiloLlmError` carrying a stable `code`, and `DEFAULT_RETRY_POLICY`). Tool
definitions are written as raw JSON Schema, which is what `ctx.tools.register` validates
directly. `ctx.llm`, `ctx.authorization`, `ctx.credentials`, and `ctx.tools` are reached through
the context, not through imports. This is the same shape the published
`@opencode2dsh/dsh-plugin` bundle uses.



## Layout

| File | Role |
|---|---|
| `index.js` | Host half: registers the `kilo` adapter, the auth flow, and the tools |
| `client.js` | Browser half: the "Kilo Gateway" settings page holding the API-key form |
| `lib/constants.js` | Endpoints, headers, timeouts, defaults |
| `lib/url.js` | Gateway / OpenRouter / API base-URL resolution |
| `lib/headers.js` | `X-KILOCODE-*` attribution headers |
| `lib/token-store.js` | Token and organization id over the credentials seam |
| `lib/api.js` | Profile, balance, device authorization, embedding catalogue |
| `lib/models.js` | Chat model catalog |
| `lib/adapter.js` | The chat adapter: streaming, block lifecycle, usage, self-healing retries |
| `lib/resilience.js` | Failure classification, repairs, and the self-healing policy |
| `lib/authorization.js` | The device-code sign-in flow |
| `lib/account.js` | Kilo Pass, coding-plan quotas, BYOK, notifications |
| `lib/fim.js` | Autocomplete model catalogue and FIM / Next Edit requests |
| `lib/limits.js` | Per-model context windows, free-tier gating, request fitting |
| `lib/tools.js` | `kilo_account`, `kilo_complete`, `kilo_embedding_models`, `kilo_notifications` |
| `lib/login-tool.js` | `kilo_login` |
| `tools/verify.mjs` | Offline verification of the streaming and resilience contracts |

> An earlier revision of this bundle served chat through `@deepseek-ai/dsh-llm-pi-ai` and seeded a
> `kilo` profile into that plugin's settings document. That was wrong twice over — it wrote another
> plugin's namespace, and it made pi-ai claim the `kilo` route this bundle needs. `index.js` now
> removes exactly that seeded profile on activation (identified by the endpoint it wrote), so the
> leftover cannot cause `DUPLICATE_ADAPTER` on an upgraded install.

## Configuration

Environment variables, read at request time:

| Variable | Default | Meaning |
|---|---|---|
| `KILO_API_KEY` | — | Kilo Gateway API key. Normally entered on the bundle's own Settings page instead. |
| `KILOCODE_TOKEN` | — | Older device/session token, also honoured. |
| `KILOCODE_ORGANIZATIONID` | — | Organization scope, sent as `X-KiloCode-OrganizationId`. |
| `KILO_AI_GATEWAY_URL` | `https://ai-gateway.kilo.ai/api/v1` | Gateway traffic root. |
| `KILO_API_URL` | `https://api.kilo.ai` | Profile / balance / device-auth root. |
| `KILOCODE_EDITOR_NAME` | `DeepSeek Harness` | `X-KILOCODE-EDITORNAME` value. |
| `KILOCODE_FEATURE` | — | Opt-in `X-KILOCODE-FEATURE` attribution. |

| Config field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `KILO_API_KEY` | Credential reference holding the key. Resolution tries this first, then `KILO_API_KEY`. |
| `baseURL` | — | Override the gateway base URL. |
| `organizationId` | — | Organization scope, overriding the environment and the stored record. |
| `repairBudget` | `2` | Repair-and-replay rounds per request. `0` disables self-healing. |
| `streamIdleTimeoutMs` | `90000` | Silence after which a stream counts as stalled and is retried. |

All fields are `volatile()`, so editing one takes effect without rewriting the patch.

## Verify

```
node tools/verify.mjs
node tools/verify-client.mjs
node tools/verify-publishable.mjs
node tools/verify-host-contract.mjs
```

`tools/verify.mjs` runs the real adapter against a stubbed `fetch`: it asserts the chunk sequence and
ordering, the `block-end` and `usage` contracts, the classifier's parameter-versus-stream split, the
recovery policy, and that a retry is silent, a repair drops the right thing, and an abort is never
replayed.

`tools/verify-client.mjs` runs the real browser half against a stub React and a client-shaped
`ctx`: it asserts the plugin's service list, the slot registration, and that a missing remote
namespace, a missing locale service, or a broken slot seam each degrade to a message instead of
failing the client boot.

`tools/verify-publishable.mjs` checks the shipped Harness's own rules against this bundle's
declarations: that an unknown package in the manifest's inject list is skipped rather than fatal,
that a missing `./client` export *is* fatal, and that `dsh.client.inject` and `dsh.client.immediately`
are both optional.

`tools/verify-host-contract.mjs` reads the shipped `@deepseek-ai/dsh-llm` out of the app's `asar`
and asserts the adapter still agrees with it — in particular that `toolHistory` is the
`ToolHistory` object and is never iterated as an array. A stubbed `fetch` cannot catch that class
of mistake, because the stub feeds the adapter whatever shape the test author believed in; this
probe reads the shape the host actually sends.

Neither suite needs a network or a credential.

## Install

```
plugin_manager install_bundle <absolute path to this directory>
```

## Attribution

Kilo Code is developed by [Kilo-Org](https://github.com/Kilo-Org) and licensed MIT.
This plugin is an independent port of its gateway client and is not affiliated with
or endorsed by Kilo-Org.
