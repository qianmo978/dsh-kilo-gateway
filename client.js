/**
 * Browser half of the Kilo Gateway bundle.
 *
 * Contributes one page to the Settings panel — "Kilo Gateway" — that holds the API-key form. The
 * Host half serves the `kilo` provider route with its own adapter, and the Models settings page
 * cannot render a key field for a private namespace (its editor draws curated layouts for
 * `llm-deepseek` and `llm-pi-ai` only and shows a dead-end hint for everything else), so this page
 * is where the credential is actually entered.
 *
 * The page never touches the network. The typed secret crosses to the Host through the generated
 * `remote.credentials` namespace — the same surface the built-in Models page uses — which stores it
 * under the `KILO_API_KEY` reference in the credential store. It never lands in a patch file, and
 * it is never echoed back: reads return only `configured`/`source`/`writable`.
 *
 * Plain JavaScript on purpose: the browser artifact is a module-loader factory, not a bundled app.
 * React comes from the browser module table, styling uses only `--dsw-alias-*` theme tokens.
 *
 * The shape of this half follows the built-in Models settings page (`dsh-client-ui-settings-models`)
 * exactly, because the client loader is strict about it:
 *
 * - `inject` names the *services* the plugin needs, by their full service keys (`remote.credentials`,
 *   not just `remote`); a missing one leaves the fiber pending, and an undeclared one throws inside
 *   `apply()`.
 * - the manifest's `dsh.client.inject` names the *packages* that provide those services, so the
 *   bundle is composed after them.
 * - every contribution is guarded at both boundaries where it can throw: the eager
 *   `ctx.slots.inject(...)` call, and the deferred callback the slot runtime invokes later. A
 *   throw in either place would fail the whole plugin, so a broken seam degrades to a console
 *   message instead.
 */

window.__ModuleLoader__.load({
  id: '@qianmo978/dsh-kilo-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The credential reference this page writes; matches DEFAULT_API_KEY_REF on the Host half. */
    const KEY_REF = 'KILO_API_KEY'

    /** Locale namespace for this page's strings. */
    const NS = 'kilo-gateway'

    /**
     * English copy is the source of truth for the key set; the Chinese dictionary below mirrors it.
     * Both are registered together so the active locale resolves whichever it needs.
     */
    const en = {
      'Kilo Gateway': 'Kilo Gateway',
      'Registers the Kilo Code Gateway as a model provider for this Harness.':
        'Registers the Kilo Code Gateway as a model provider for this Harness.',
      'API key': 'API key',
      'Paste your Kilo Gateway API key.': 'Paste your Kilo Gateway API key.',
      Save: 'Save',
      Remove: 'Remove',
      'Saved. The next request uses this key immediately.': 'Saved. The next request uses this key immediately.',
      'Removed. Requests fall back to the anonymous free tier.':
        'Removed. Requests fall back to the anonymous free tier.',
      'Paste a key first.': 'Paste a key first.',
      'Reading credential state…': 'Reading credential state…',
      Configured: 'Configured',
      'Not configured': 'Not configured',
      'The credential store is unavailable, so the key can be neither read nor written.':
        'The credential store is unavailable, so the key can be neither read nor written.',
      'The key is stored under the KILO_API_KEY reference in the credential store; it never lands in a patch file.':
        'The key is stored under the KILO_API_KEY reference in the credential store; it never lands in a patch file.',
      'Without a key, only free models are reachable (":free" ids and kilo-auto/free), at 200 requests/hour per IP.':
        'Without a key, only free models are reachable (":free" ids and kilo-auto/free), at 200 requests/hour per IP.',
      'Save failed.': 'Save failed.',
      'Remove failed.': 'Remove failed.',
    }

    /** Chinese copy, keyed by the English source text above. */
    const zh = {
      'Kilo Gateway': 'Kilo 网关',
      'Registers the Kilo Code Gateway as a model provider for this Harness.':
        '将 Kilo Code 网关接入为本 Harness 的模型提供方。',
      'API key': 'API 密钥',
      'Paste your Kilo Gateway API key.': '粘贴 Kilo Gateway 的 API 密钥。',
      Save: '保存',
      Remove: '清除',
      'Saved. The next request uses this key immediately.': '已保存。下一次请求立即使用该密钥。',
      'Removed. Requests fall back to the anonymous free tier.': '已清除。请求将回落到匿名免费额度。',
      'Paste a key first.': '请先粘贴密钥。',
      'Reading credential state…': '正在读取凭据状态…',
      Configured: '已配置',
      'Not configured': '未配置',
      'The credential store is unavailable, so the key can be neither read nor written.':
        '凭据存储不可用，密钥既无法读取也无法写入。',
      'The key is stored under the KILO_API_KEY reference in the credential store; it never lands in a patch file.':
        '密钥以 KILO_API_KEY 引用名保存在凭据存储中，不会写入任何补丁文件。',
      'Without a key, only free models are reachable (":free" ids and kilo-auto/free), at 200 requests/hour per IP.':
        '未配置密钥时仅可使用免费模型（“:free” 与 kilo-auto/free），限额 200 次/小时/IP。',
      'Save failed.': '保存失败。',
      'Remove failed.': '清除失败。',
    }

    /** Prefix every guarded contribution's degradation log with this. */
    const CONTRIBUTION_FAILED = '[dsh-kilo-gateway] client contribution failed to load:'

    /**
     * Run one browser-side contribution, degrading its failure to a `console.error` instead of
     * throwing into the client loader. A throw here would fail the whole plugin and take the web
     * boot down with it, so a broken seam must cost this page and nothing else.
     *
     * @param {string} label what the contribution does, for the log
     * @param {() => any} fn the contribution
     */
    function guard(label, fn) {
      try {
        return fn()
      } catch (error) {
        console.error(`${CONTRIBUTION_FAILED} ${label}`, error)
        return undefined
      }
    }

    /**
     * @param {unknown} error
     * @returns {string}
     */
    function errorText(error) {
      if (error instanceof Error) return error.message
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
        return error.message
      }
      return String(error)
    }

    /** Page styling: theme tokens only, so a renamed token degrades appearance but never breaks it. */
    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' },
      title: {
        margin: 0,
        fontSize: '16px',
        fontWeight: 600,
        lineHeight: '24px',
        color: 'var(--dsw-alias-label-primary)',
      },
      intro: {
        margin: 0,
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
      },
      statusRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      statusText: { fontSize: '13px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      fieldRow: { display: 'flex', gap: '8px', alignItems: 'stretch' },
      input: {
        flex: 1,
        minWidth: 0,
        height: '34px',
        padding: '0 10px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        outline: 'none',
        boxSizing: 'border-box',
      },
      buttonBase: {
        height: '34px',
        padding: '0 14px',
        fontSize: '13px',
        borderRadius: '8px',
        cursor: 'pointer',
        flexShrink: 0,
        fontFamily: 'inherit',
      },
      hint: {
        margin: 0,
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      ok: {
        margin: 0,
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      error: {
        margin: 0,
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-error-primary)',
      },
    }

    /**
     * The status dot: success when a key is stored, idle when it is not.
     *
     * @param {boolean} configured
     */
    function statusDot(configured) {
      return {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        flexShrink: 0,
        background: configured
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-state-idle-primary)',
      }
    }

    /**
     * Build the settings page component.
     *
     * @param {any} credentials the `ctx.remote.credentials` namespace, or undefined when this host
     *   ships no credential remote — the page then explains itself instead of failing to render
     * @param {(text: string) => string} t
     */
    function makePage(credentials, t) {
      function KiloSettingsPage() {
        const [phase, setPhase] = React.useState(credentials === undefined ? 'unavailable' : 'loading')
        const [configured, setConfigured] = React.useState(false)
        const [draft, setDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(undefined)

        const refresh = React.useCallback(async () => {
          if (credentials === undefined) {
            setPhase('unavailable')
            return
          }
          try {
            const response = await credentials.describe([KEY_REF])
            if (response !== null && typeof response === 'object' && response.ok) {
              const info = (response.value && response.value[KEY_REF]) || {}
              setConfigured(info.configured === true)
            } else if (
              response !== null &&
              typeof response === 'object' &&
              response.error &&
              typeof response.error.message === 'string'
            ) {
              setNotice({ kind: 'error', text: response.error.message })
            }
          } catch (error) {
            setNotice({ kind: 'error', text: errorText(error) })
          } finally {
            setPhase('ready')
          }
        }, [])

        React.useEffect(() => {
          void refresh()
        }, [refresh])

        const save = React.useCallback(
          async (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            const value = draft.trim()
            if (value.length === 0) {
              setNotice({ kind: 'error', text: t('Paste a key first.') })
              return
            }
            if (credentials === undefined) {
              setNotice({ kind: 'error', text: t('The credential store is unavailable, so the key can be neither read nor written.') })
              return
            }
            setBusy(true)
            setNotice(undefined)
            try {
              const response = await credentials.set(KEY_REF, value)
              if (response !== null && typeof response === 'object' && response.ok) {
                setDraft('')
                setNotice({ kind: 'ok', text: t('Saved. The next request uses this key immediately.') })
                await refresh()
              } else {
                const message =
                  response !== null && typeof response === 'object' && response.error &&
                  typeof response.error.message === 'string'
                    ? response.error.message
                    : t('Save failed.')
                setNotice({ kind: 'error', text: message })
              }
            } catch (error) {
              setNotice({ kind: 'error', text: errorText(error) })
            } finally {
              setBusy(false)
            }
          },
          [draft, refresh, t],
        )

        const clear = React.useCallback(async () => {
          if (credentials === undefined) return
          setBusy(true)
          setNotice(undefined)
          try {
            const response = await credentials.unset(KEY_REF)
            if (response !== null && typeof response === 'object' && response.ok) {
              setNotice({ kind: 'ok', text: t('Removed. Requests fall back to the anonymous free tier.') })
              await refresh()
            } else {
              const message =
                response !== null && typeof response === 'object' && response.error &&
                typeof response.error.message === 'string'
                  ? response.error.message
                  : t('Remove failed.')
              setNotice({ kind: 'error', text: message })
            }
          } catch (error) {
            setNotice({ kind: 'error', text: errorText(error) })
          } finally {
            setBusy(false)
          }
        }, [refresh, t])

        const header = [
          h('h2', { key: 'title', style: styles.title }, t('Kilo Gateway')),
          h(
            'p',
            { key: 'intro', style: styles.intro },
            t('Registers the Kilo Code Gateway as a model provider for this Harness.'),
          ),
        ]

        const canSave = !busy && draft.trim().length > 0
        const canClear = !busy && configured

        // Without the credential remote there is nothing this page can do, so it says so instead of
        // offering a form whose writes would fail.
        if (phase === 'unavailable') {
          return h(
            'div',
            { style: styles.page },
            ...header,
            h(
              'p',
              { style: styles.error },
              t('The credential store is unavailable, so the key can be neither read nor written.'),
            ),
          )
        }

        return h(
          'div',
          { style: styles.page },
          ...header,
          h(
            'form',
            { style: styles.card, onSubmit: save },
            h(
              'div',
              { style: styles.statusRow },
              h('span', { style: statusDot(configured) }),
              h(
                'span',
                { style: styles.statusText },
                phase === 'loading'
                  ? t('Reading credential state…')
                  : configured
                    ? t('Configured')
                    : t('Not configured'),
              ),
            ),
            h(
              'div',
              { style: styles.fieldRow },
              h('input', {
                type: 'password',
                style: styles.input,
                value: draft,
                placeholder: t('Paste your Kilo Gateway API key.'),
                'aria-label': t('API key'),
                autoComplete: 'new-password',
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setDraft(event.target.value),
              }),
              h(
                'button',
                {
                  type: 'submit',
                  disabled: !canSave,
                  style: {
                    ...styles.buttonBase,
                    border: 'none',
                    background: 'var(--dsw-alias-brand-primary)',
                    color: 'var(--dsw-alias-label-primary-foreground)',
                    ...(canSave ? {} : { opacity: 0.5, cursor: 'default' }),
                  },
                },
                t('Save'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: !canClear,
                  onClick: clear,
                  style: {
                    ...styles.buttonBase,
                    background: 'transparent',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    color: 'var(--dsw-alias-label-secondary)',
                    ...(canClear ? {} : { opacity: 0.5, cursor: 'default' }),
                  },
                },
                t('Remove'),
              ),
            ),
            notice !== undefined
              ? h('p', { style: notice.kind === 'ok' ? styles.ok : styles.error }, notice.text)
              : null,
            h(
              'p',
              { style: styles.hint },
              t('The key is stored under the KILO_API_KEY reference in the credential store; it never lands in a patch file.'),
            ),
            h(
              'p',
              { style: styles.hint },
              t('Without a key, only free models are reachable (":free" ids and kilo-auto/free), at 200 requests/hour per IP.'),
            ),
          ),
        )
      }

      return KiloSettingsPage
    }

    /**
     * Required services (cordis fiber inject).
     *
     * The names are full service keys: `remote` is the namespace owner and `remote.credentials`
     * the namespace this page calls. Both are declared, because the client context exposes a
     * service only when the plugin declared it — `ctx.remote` is unreadable otherwise, and
     * `ctx.get('remote')` finds nothing, because the remote namespaces are Typert remotes rather
     * than cordis Services.
     *
     * The dependency is safe to declare: `@deepseek-ai/dsh-api-remotes` is a **protected core
     * module** of the Harness (it ships with the app and the plugin hub refuses to toggle it), so
     * every host that has a settings panel also has the credential remote. The page still degrades
     * gracefully if the namespace is somehow absent.
     */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials']

    /**
     * @param {any} ctx
     */
    function apply(ctx) {
      // The copy is registered as one dictionary per language, the shape the locale service's
      // `register(ns, { zh, en })` overload takes.
      guard('copy dictionaries', () =>
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kilo-gateway: copy dictionaries'),
      )

      // Bind the namespace once; a missing locale service degrades to the source text.
      const translate = guard('locale binding', () => ctx.locale.bind(NS))
      const t = (text) => {
        if (translate === undefined) return text
        try {
          const resolved = translate(text)
          return typeof resolved === 'string' && resolved.length > 0 ? resolved : text
        } catch {
          return text
        }
      }

      // The credential namespace is a declared dependency, so it is present; the guard keeps a
      // namespace that failed to mount from throwing inside apply().
      const credentials = guard('credential namespace', () => {
        if (ctx.remote === undefined || ctx.remote === null || ctx.remote.credentials === undefined) {
          return undefined
        }
        return ctx.remote.credentials
      })

      const Page = makePage(credentials, t)

      // The target slot is declared by the settings shell, whose activation order relative to this
      // one is not constrained; registration therefore goes through `slots.inject()`. Both
      // boundaries are guarded: the eager call, and the deferred callback the slot runtime invokes
      // later — when the owner commits the slot's declaration — long after `apply()` returned.
      guard('settings section', () =>
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              guard('settings section registration', () =>
                ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: 'kilo-gateway',
                    order: 60,
                    label: () => t('Kilo Gateway'),
                  },
                  Page,
                ),
              ),
            ),
          'kilo-gateway: settings page',
        ),
      )
    }

    return {
      inject,
      apply,
    }
  },
})
