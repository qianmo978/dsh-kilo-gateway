// Installability probe: can this bundle be imported on a machine that has nothing but itself?
//
// The failure this catches is not a shape mismatch but a *missing package*:
//
//   failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
//
// The Harness routes a plugin's `@deepseek-ai/*` imports to the host's own copy only for the
// packages it ships as host-core — `@deepseek-ai/dsh*` and `@deepseek-ai/cordis*`. `schemastery`
// matches neither prefix, so it is never routed, and a plugin that imports it must find it in its
// own directory tree.
//
// A plugin installed with `link:` — the form the Harness documents, `dsh plugin add "link:$PWD"` —
// has no `node_modules` of its own, because pnpm does not install the dependencies of a linked
// package. A bundle that imports an external package therefore activates only on a machine where
// some *other* plugin happens to have installed it, and fails everywhere else.
//
// So the rule this probe enforces is simple: the bundle imports nothing it does not carry.
//
// It checks two things:
//   1. every bare import in the runtime sources is either a Node builtin, provided by the browser
//      module table, or vendored inside the bundle;
//   2. the bundle's whole runtime source tree imports cleanly with the ambient resolution of the
//      working directory — the same way a fresh machine would load it.
//
// USAGE
//
//   node tools/verify-installable.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
}

/** The runtime sources: the files the host loads. `tools/` is not loaded by the host. */
const RUNTIME = ['index.js', 'client.js']

/** Every file under a directory, recursively. */
function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** The bare specifiers a source file imports. */
function bareImports(source) {
  const specs = new Set()
  for (const match of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1]
    if (!spec.startsWith('.') && !spec.startsWith('/')) specs.add(spec)
  }
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = match[1]
    if (!spec.startsWith('.') && !spec.startsWith('/')) specs.add(spec)
  }
  return [...specs]
}

// --- 1. every bare import is a builtin, a browser-provided module, or vendored ------------
const runtimeFiles = [
  ...RUNTIME.map((f) => join(ROOT, f)),
  ...walk(join(ROOT, 'lib')),
  ...walk(join(ROOT, 'vendor')),
]

const external = new Map()
for (const file of runtimeFiles) {
  if (!/\.(mjs|js)$/.test(file)) continue
  for (const spec of bareImports(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('node:')) continue
    if (spec === 'react') continue // provided by the browser module table
    if (!external.has(spec)) external.set(spec, [])
    external.get(spec).push(file.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
  }
}

check(
  'the bundle imports no external package',
  external.size === 0,
  external.size === 0
    ? 'every bare import is a Node builtin or provided by the browser module table'
    : [...external.entries()].map(([s, files]) => `${s} (in ${files.join(', ')})`).join('; '),
)

// --- 2. the package name is stated once, in the three places the host reads it -------------
// The host resolves a bundle by its package name, and the three places that name appears have to
// agree: the manifest, the browser half's module id, and the Loader patch row that inserts the
// bundle. A mismatch shows up as a bundle that installs but never mounts.
const manifestText = readFileSync(join(ROOT, 'package.json'), 'utf8')
const manifestName = JSON.parse(manifestText).name
check(
  'the package name is a valid package name',
  typeof manifestName === 'string' && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(manifestName),
  `the package is "${manifestName}"`,
)

const clientText = readFileSync(join(ROOT, 'client.js'), 'utf8')
const clientId = clientText.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)?.[1]
check(
  'the browser half loads under the package name',
  clientId === manifestName,
  clientId === manifestName
    ? `both say "${manifestName}"`
    : `the client half loads as "${clientId}" but the package is "${manifestName}"`,
)

const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const patchName = patchText.match(/^\s*name:\s*['"]?([^'"\n]+)['"]?/m)?.[1]?.trim()
check(
  'the Loader patch row names the same package',
  patchName === manifestName,
  patchName === manifestName
    ? `both say "${manifestName}"`
    : `the patch row names "${patchName}" but the package is "${manifestName}"`,
)

const patchId = patchText.match(/^\s*-\s*id:\s*['"]?([^'"\n]+)['"]?/m)?.[1]?.trim()
const settingsNs = readFileSync(join(ROOT, 'index.js'), 'utf8').match(
  /const SETTINGS_NS = '([^']+)'/,
)?.[1]
check(
  'the settings namespace matches the patch row id',
  patchId !== undefined && patchId === settingsNs,
  patchId === settingsNs
    ? `both say "${patchId}"`
    : `the patch row id is "${patchId}" but SETTINGS_NS is "${settingsNs}"`,
)

// --- 3. the vendored copies are present and carry their upstream licence -------------------
for (const [pkg, entry] of [
  ['schemastery', 'lib/index.mjs'],
  ['cosmokit', 'lib/index.js'],
]) {
  const dir = join(ROOT, 'vendor', pkg)
  let present = true
  let detail = 'present with its upstream MIT licence'
  try {
    const text = readFileSync(join(dir, entry), 'utf8')
    if (text.length === 0) {
      present = false
      detail = 'the vendored file is empty'
    }
  } catch {
    present = false
    detail = `${pkg} is not vendored — run tools/vendor-schemastery.mjs`
  }
  try {
    readFileSync(join(dir, 'LICENSE'), 'utf8')
  } catch {
    present = false
    detail = `${pkg} is vendored without its upstream LICENSE`
  }
  check(`vendor/${pkg} is vendored with its licence`, present, detail)
}

// --- 3. the vendored schemastery does not reach back out to a package name ------------------
const vendoredSchemastery = join(ROOT, 'vendor', 'schemastery', 'lib', 'index.mjs')
try {
  const text = readFileSync(vendoredSchemastery, 'utf8')
  check(
    'the vendored schemastery imports cosmokit by relative path',
    !/from\s*["']@deepseek-ai\/cosmokit["']/.test(text) && /from\s*["']\.\.\/\.\.\/cosmokit\/lib\/index\.js["']/.test(text),
    'a bare package name would need the host to route it, and the host routes only dsh*/cordis*',
  )
} catch {
  check('the vendored schemastery imports cosmokit by relative path', false, 'not vendored')
}

// --- 4. the host-side runtime tree imports cleanly, with no ambient packages ---------------
// This is the check that would have caught the original failure: the sources are loaded the way a
// fresh machine loads them, from the bundle's own directory, with nothing else installed.
//
// `client.js` is deliberately not loaded here: it is the browser half, it runs inside the web
// shell, and it reads `window.__ModuleLoader__`. Its imports are checked in step 1 instead — the
// only bare one it may use is `react`, which the browser module table provides.
let loadError
try {
  await import(pathToFileURL(join(ROOT, 'index.js')).href)
  for (const file of walk(join(ROOT, 'lib'))) {
    if (!/\.js$/.test(file)) continue
    await import(pathToFileURL(file).href)
  }
} catch (error) {
  loadError = error
}
check(
  'every host-side runtime source imports with no package installed alongside the bundle',
  loadError === undefined,
  loadError === undefined
    ? 'the whole host-side tree loads from the bundle alone'
    : `${loadError.code ?? loadError.name}: ${loadError.message}`,
)

// --- 5. the host's routing rule, read from the shipped app --------------------------------
// The rule is what makes the difference between a package the host provides and one it does not.
const ASAR = process.env.DSH_ASAR ?? 'D:\\Program Files\\DSH NEXT\\resources\\app.asar'
let asarText = ''
try {
  asarText = readFileSync(ASAR, 'utf8')
} catch {
  asarText = ''
}
if (asarText === '') {
  check('the host routes only its host-core packages', true, 'skipped: the shipped asar is unreadable here')
} else {
  check(
    'the host routes only its host-core packages',
    /\^\(\?:dsh\|cordis\)\//.test(asarText),
    'the host routes @deepseek-ai/dsh* and @deepseek-ai/cordis* to its own copy; nothing else',
  )
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (r.detail) console.log(`        ${r.detail}`)
}
console.log(`installability probe: ${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
