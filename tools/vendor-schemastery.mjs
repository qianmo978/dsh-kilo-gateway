// Vendor `@deepseek-ai/schemastery` and its dependency `@deepseek-ai/cosmokit` into this bundle.
//
// WHY THIS EXISTS
//
// The Harness routes a plugin's `@deepseek-ai/*` imports to the host's own copy of a package — but
// only for the packages the host ships as host-core:
//
//   for (const entry of readdirSync(join(hostNodeModulesRoot(dir), '@deepseek-ai'))) {
//     if (/^(?:dsh|cordis)/.test(entry.name)) names.add(`@deepseek-ai/${entry.name}`)
//   }
//
// `schemastery` matches neither prefix, so the host never routes it. A plugin that imports it
// resolves it the way Node does: by walking up from the plugin's own directory. That works only if
// the package is physically installed next to the plugin.
//
// A plugin installed with `link:` — the form the Harness documents (`dsh plugin add "link:$PWD"`)
// — has no `node_modules` of its own: pnpm does not install the dependencies of a linked package.
// A bundle that imports `schemastery` therefore activates on a machine where some *other* plugin
// happens to have pulled it in, and fails with
//
//   failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
//
// on every machine that does not. Vendoring the two packages removes the difference between those
// machines: the bundle carries what it imports.
//
// The vendored copies keep their upstream MIT licence files and their upstream version, and this
// script is the record of where they came from.
//
// USAGE
//
//   node tools/vendor-schemastery.mjs            # re-vendor from the local npm cache
//   node tools/vendor-schemastery.mjs --check    # verify the vendored copies are current
//
// The source is read from the pnpm store / any local install of the two packages. The version is
// pinned below; bump it there and re-run.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const VENDOR = join(ROOT, 'vendor')

/** The upstream version this bundle vendors. */
const PINNED = {
  '@deepseek-ai/schemastery': '3.18.4',
  '@deepseek-ai/cosmokit': '1.8.5',
}

/** Where each package's runtime entry lives, relative to its package root. */
const ENTRIES = {
  '@deepseek-ai/schemastery': 'lib/index.mjs',
  '@deepseek-ai/cosmokit': 'lib/index.js',
}

/**
 * Find a locally installed copy of a package.
 *
 * @param {string} name
 * @returns {string | undefined} the package root
 */
function findLocal(name) {
  const roots = [
    join(ROOT, 'node_modules', name),
    join(ROOT, '..', '..', 'node_modules', name),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', name),
  ]
  for (const root of roots) {
    if (existsSync(join(root, 'package.json'))) return root
  }
  // Any pnpm store copy, by name.
  const store = join(process.env.LOCALAPPDATA ?? '', 'pnpm', 'store')
  if (existsSync(store)) {
    for (const version of readdirSync(store)) {
      const candidate = join(store, version, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return undefined
}

/**
 * Read the version of an installed package.
 *
 * @param {string} root
 * @returns {string}
 */
function versionOf(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const check = process.argv.includes('--check')
let drift = 0

for (const [name, version] of Object.entries(PINNED)) {
  const source = findLocal(name)
  if (source === undefined) {
    console.error(`  MISS  ${name}@${version} is not installed locally`)
    drift += 1
    continue
  }
  const found = versionOf(source)
  if (found !== version) {
    console.warn(`  note  ${name} is ${found} locally, ${version} is pinned`)
  }

  const entry = ENTRIES[name]
  const from = join(source, entry)
  const to = join(VENDOR, name.replace('@deepseek-ai/', ''), 'lib', entry.split('/').pop())

  if (check) {
    // The vendored copy differs from upstream by exactly one rewritten import, so the comparison
    // applies the same rewrite to the upstream text before diffing.
    let wanted = readFileSync(from, 'utf8')
    if (name === '@deepseek-ai/schemastery') {
      wanted = wanted.replace(/from\s*["']@deepseek-ai\/cosmokit["']/g, 'from "../../cosmokit/lib/index.js"')
    }
    const current = existsSync(to) ? readFileSync(to, 'utf8') : ''
    const same = current === wanted
    console.log(`  ${same ? 'OK  ' : 'DRIFT'}  ${name}@${version} -> vendor/${name.replace('@deepseek-ai/', '')}/lib/`)
    if (!same) drift += 1
    continue
  }

  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(from))
  const licence = join(source, 'LICENSE')
  if (existsSync(licence)) copyFileSync(licence, join(dirname(dirname(to)), 'LICENSE'))
  console.log(`  vendored  ${name}@${found} -> vendor/${name.replace('@deepseek-ai/', '')}/lib/`)
}

// The vendored schemastery imports cosmokit by its bare name. Rewrite that import to the relative
// path of the vendored copy, so the vendored tree resolves without any package resolution at all.
// The entry lives at `vendor/schemastery/lib/index.mjs`, so the sibling package is two levels up.
const schemasteryEntry = join(VENDOR, 'schemastery', 'lib', 'index.mjs')
if (existsSync(schemasteryEntry)) {
  let source = readFileSync(schemasteryEntry, 'utf8')
  const before = source
  source = source.replace(
    /from\s*["']@deepseek-ai\/cosmokit["']/g,
    'from "../../cosmokit/lib/index.js"',
  )
  if (source !== before) {
    writeFileSync(schemasteryEntry, source)
    console.log('  rewrote  schemastery -> cosmokit import to a relative path')
  }
}

if (check) {
  console.log(drift === 0 ? 'vendored copies are current' : `vendored copies are stale (${drift})`)
  process.exit(drift === 0 ? 0 : 1)
}
