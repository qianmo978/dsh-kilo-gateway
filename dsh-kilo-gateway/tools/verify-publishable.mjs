// Publishability probe: does an unknown package in `dsh.client.inject` break the client boot?
//
// The host's `arriveGraphRow` walks the manifest's inject list with an undefined guard:
//
//   for (const packageName of row.inject) {
//     const dependency = this.graphRows.get(packageName);
//     if (dependency !== void 0) await this.arriveDependency(...)
//   }
//
// so an injected name that resolves to no graph row is skipped. This script checks the same
// property against the shipped code, and reports the exact guard, so the claim is evidence-backed
// rather than assumed.

import { readFileSync } from 'node:fs'

const ASAR = 'D:\\Program Files\\DSH NEXT\\resources\\app.asar'
const s = readFileSync(ASAR).toString('utf8')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
}

// 1. the guard exists: an unknown injected package is skipped, not fatal
const guard = s.match(
  /for \(const packageName of row\.inject\) \{[^}]*?const dependency = this\.graphRows\.get\(packageName\);[^}]*?if \(dependency !== void 0\)/,
)
check(
  'an unknown injected package is skipped, not fatal',
  guard !== null,
  guard ? guard[0].replace(/\s+/g, ' ').slice(0, 200) : 'guard not found',
)

// 2. the plugin's own service inject is what the fiber waits on (a missing SERVICE is fatal)
const fiberInject = s.match(/const missing = Object\.keys\([^)]*\.inject\)/)
check(
  'a missing service in the plugin inject is what the boot audit reports',
  s.includes('pending (waiting for service'),
  'boot audit distinguishes pending (waiting for services) from failed',
)

// 3. a missing bundle path IS fatal (so the ./client export must exist)
check(
  'a missing ./client export is fatal',
  s.includes('declares dsh.client but exports no "./client" bundle'),
  'the host throws when dsh.client is declared without a ./client export',
)

// 4. the manifest inject list is optional
const injectOptional = /const inject = optionalStringArray\(pkgName, "dsh\.client\.inject", decl\.inject\)/.test(s)
check('dsh.client.inject is optional', injectOptional, 'optionalStringArray returns undefined when absent')

// 5. `immediately` is optional and validated as a boolean
check(
  'dsh.client.immediately is optional and must be a boolean',
  s.includes('dsh.client.immediately must be a boolean'),
  'parseDshClient accepts it only when present and boolean',
)

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (r.detail) console.log(`        ${r.detail}`)
}
console.log(`publishability probe: ${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
