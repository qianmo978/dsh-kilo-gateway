// Contract check for the Kilo settings page's browser half.
//
// Runs the real client.js factory against a stub React and a ctx shaped like the live client's,
// asserting the plugin shape matches the built-in Models page's contract (see the README's
// "The browser half's contract" table):
//   - `inject` names full service keys, including `remote.credentials`
//   - `apply` registers copy and the settings section, and never throws
//   - every degradation branch renders without throwing
//
// No browser and no network required:  node tools/verify-client.mjs

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

globalThis.window = { __ModuleLoader__: { load: (definition) => { globalThis.__captured = definition } } }
await import(`file:///${clientPath.replace(/\\/g, '/')}`)

const definition = globalThis.__captured
if (definition.id !== '@local/dsh-kilo-gateway') throw new Error(`id mismatch: ${definition.id}`)

let effects = []
const stubReact = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { effects.push(fn) },
  useCallback: (fn) => fn,
}

const fakeRequire = (name) => {
  if (name === 'react') return stubReact
  throw new Error(`unexpected require: ${name}`)
}

/** The credential namespace, shaped like the live `ctx.remote.credentials`. */
const okCredentials = {
  describe: async () => ({ ok: true, value: { KILO_API_KEY: { configured: true, writable: true } } }),
  set: async () => ({ ok: true }),
  unset: async () => ({ ok: true }),
}

/**
 * A ctx shaped like the live client: locale service, remote namespaces, slots registry.
 *
 * The remote namespaces are exposed as the `remote` property, because that is the only way the
 * client context hands them over: a service is readable only when the plugin declared it, and
 * `ctx.get('remote')` finds nothing — the remote namespaces are Typert remotes, not cordis
 * Services.
 */
const makeCtx = ({ credentials = okCredentials, withLocale = true, withRemote = true } = {}) => ({
  get: () => undefined,
  effect: (fn) => { fn(); return () => {} },
  locale: withLocale
    ? {
        register: (ns, dicts) => {
          if (ns !== 'kilo-gateway') throw new Error(`bad namespace: ${ns}`)
          if (dicts === undefined || typeof dicts !== 'object') {
            throw new Error('register(ns, {zh, en}) expected an object of dictionaries')
          }
          for (const [locale, dict] of Object.entries(dicts)) {
            if (!/^[a-z][a-z-]*$/.test(locale)) throw new Error(`bad locale id: ${locale}`)
            if (typeof dict !== 'object' || dict === null) throw new Error(`bad dict for ${locale}`)
          }
          return () => {}
        },
        bind: (ns) => {
          if (ns !== 'kilo-gateway') throw new Error(`bad namespace: ${ns}`)
          return (text) => text
        },
      }
    : undefined,
  remote: withRemote ? { credentials } : undefined,
  slots: {
    inject: (key, cb) => { globalThis.__slot = { key }; cb(); return () => {} },
    register: (opts, comp) => { globalThis.__reg = { opts, comp }; return () => {} },
  },
})

const cases = []
const check = (name, fn) => { fn(); cases.push(name) }

// --- the healthy shape ------------------------------------------------------------
let plugin = definition.factory(fakeRequire)
check('factory returns a plugin with inject and apply', () => {
  if (plugin === null || typeof plugin !== 'object') throw new Error('plugin is not an object')
  if (!Array.isArray(plugin.inject)) throw new Error('inject is not an array')
  if (typeof plugin.apply !== 'function') throw new Error('apply is not a function')
})

check('inject declares the credential namespace by its full key', () => {
  // The client context exposes a service only when the plugin declared it, and the remote
  // namespaces are Typert remotes rather than cordis Services — `ctx.get('remote')` finds
  // nothing, so `ctx.remote` must be a declared dependency.
  for (const required of ['slots', 'locale', 'remote', 'remote.credentials']) {
    if (!plugin.inject.includes(required)) throw new Error(`inject is missing "${required}"`)
  }
})

globalThis.__reg = null
globalThis.__slot = null
plugin.apply(makeCtx())

check('registers into settings.section', () => {
  if (globalThis.__slot.key !== 'settings.section') throw new Error(`wrong slot: ${globalThis.__slot.key}`)
  const reg = globalThis.__reg
  if (reg.opts.id !== 'kilo-gateway') throw new Error(`wrong id: ${reg.opts.id}`)
  if (reg.opts.name !== 'settings.section') throw new Error('wrong slot name')
  if (typeof reg.opts.label !== 'function') throw new Error('label must be callable')
  if (reg.opts.label() !== 'Kilo Gateway') throw new Error('unexpected label text')
})

effects = []
let tree = globalThis.__reg.comp()
check('renders a root div with a form', () => {
  if (!tree || tree.type !== 'div') throw new Error('render returned no root div')
  const form = tree.kids.find((k) => k && k.type === 'form')
  if (!form) throw new Error('no form rendered')
})
check('mounts exactly one effect (the credential read)', () => {
  if (effects.length !== 1) throw new Error(`expected 1 effect, got ${effects.length}`)
})

// --- the remote namespace is missing -----------------------------------------------
globalThis.__reg = null
globalThis.__slot = null
plugin = definition.factory(fakeRequire)
plugin.apply(makeCtx({ withRemote: false }))
check('apply does not throw when the remote namespace is missing', () => {
  if (globalThis.__reg === null) throw new Error('the section was not registered')
})
tree = globalThis.__reg.comp()
check('explains itself instead of offering a form that cannot work', () => {
  const form = tree.kids.find((k) => k && k.type === 'form')
  if (form !== undefined) throw new Error('a form was rendered without a credential store')
  const text = JSON.stringify(tree)
  if (!/unavailable|凭据存储不可用/i.test(text)) throw new Error('no explanation was rendered')
})

// --- the locale service is missing --------------------------------------------------
globalThis.__reg = null
globalThis.__slot = null
plugin = definition.factory(fakeRequire)
plugin.apply(makeCtx({ withLocale: false }))
check('apply does not throw when the locale service is missing', () => {
  if (globalThis.__reg === null) throw new Error('the section was not registered')
})
tree = globalThis.__reg.comp()
check('still renders with the source text', () => {
  const form = tree.kids.find((k) => k && k.type === 'form')
  if (!form) throw new Error('no form rendered')
})

// --- the slot service is missing ------------------------------------------------------
globalThis.__reg = null
globalThis.__slot = null
plugin = definition.factory(fakeRequire)
const ctxNoSlots = makeCtx()
ctxNoSlots.slots = { inject: () => { throw new Error('slot API shape break') } }
plugin.apply(ctxNoSlots)
check('a broken slot seam does not throw out of apply()', () => {
  if (globalThis.__reg !== null) throw new Error('unexpected registration')
})

// --- the namespace is reached through the declared property, not ctx.get ---------------
globalThis.__reg = null
globalThis.__slot = null
plugin = definition.factory(fakeRequire)
const ctxGetOnly = makeCtx()
// A ctx whose `remote` property is absent but whose `get('remote')` would answer: the real client
// hides the property from a plugin that did not declare it, and `get` never finds a Typert remote,
// so looking the namespace up through `get` silently yields nothing.
ctxGetOnly.get = (name) => (name === 'remote' ? { credentials: okCredentials } : undefined)
delete ctxGetOnly.remote
plugin.apply(ctxGetOnly)
check('the namespace is not looked up through ctx.get (it would find nothing)', () => {
  const tree = globalThis.__reg.comp()
  const form = tree.kids.find((k) => k && k.type === 'form')
  if (form !== undefined) {
    throw new Error('a form was rendered from a ctx.get lookup — that path never works')
  }
})

console.log(`client contract OK: ${cases.length} cases passed`)
for (const name of cases) console.log(`  PASS  ${name}`)
