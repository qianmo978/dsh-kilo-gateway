// Host-contract probe: does the adapter still match the shape the shipped Harness sends?
//
// The `toolHistory` field of `GenerateOptions` is an OBJECT (`{ tools, updates }`), not an array.
// Reading it as an array of updates throws `toolHistory is not iterable` on every dispatch that
// carries a tool history — and a `toolHistory.length === 0` guard does not catch it, because the
// length of an object is `undefined`.
//
// A stubbed fetch in the adapter suite cannot catch that class of mistake, because the stub feeds
// the adapter whatever shape the test author believed in. This script reads the real declaration
// out of the shipped `@deepseek-ai/dsh-llm` and asserts the adapter agrees with it, so a host
// upgrade that changes the shape is caught here rather than in a user's session.
//
// The asar path is overridable: DSH_ASAR=<path> node tools/verify-host-contract.mjs

import { readFileSync } from 'node:fs'

const ASAR = process.env.DSH_ASAR ?? 'D:\\Program Files\\DSH NEXT\\resources\\app.asar'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
}

let s = ''
try {
  s = readFileSync(ASAR).toString('utf8')
} catch (error) {
  console.log(`  SKIP  cannot read the shipped asar at ${ASAR}`)
  console.log('        the host contract could not be verified on this machine')
  process.exit(0)
}

// --- 1. GenerateOptions declares toolHistory as a ToolHistory, not as an array -------------
const generateOptions = s.match(/"name":\s*"GenerateOptions",\s*"declaration":\s*"(export interface GenerateOptions \{[^"]*)"/)
check(
  'GenerateOptions declares toolHistory',
  generateOptions !== null,
  generateOptions ? 'found' : 'the declaration was not found in the shipped asar',
)
if (generateOptions !== null) {
  const decl = generateOptions[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
  const field = decl.match(/toolHistory\??:\s*([^;\n]+)/)
  check(
    'toolHistory is typed as ToolHistory, not as an array',
    field !== null && /ToolHistory/.test(field[1]) && !/\[\]/.test(field[1]),
    field ? `toolHistory?: ${field[1].trim()}` : 'the field was not found',
  )
}

// --- 2. ToolHistory is an object with a tools list and an updates list --------------------
const toolHistory = s.match(/"name":\s*"ToolHistory",\s*"declaration":\s*"(export interface ToolHistory \{[^"]*)"/)
check(
  'ToolHistory is declared as an interface',
  toolHistory !== null,
  toolHistory ? 'found' : 'the declaration was not found in the shipped asar',
)
if (toolHistory !== null) {
  const decl = toolHistory[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
  check(
    'ToolHistory carries a tools list',
    /readonly\s+tools:\s*readonly/.test(decl),
    'the tools half is the list of every declared tool',
  )
  check(
    'ToolHistory carries an updates list',
    /readonly\s+updates:\s*readonly/.test(decl),
    'the updates half is the list of per-message additions',
  )
}

// --- 3. the adapter reads the object, and never iterates it as an array --------------------
const adapter = readFileSync(new URL('../lib/adapter.js', import.meta.url), 'utf8')
check(
  'the adapter never iterates toolHistory as an array',
  !/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+toolHistory\s*\)/.test(adapter),
  'a `for (const x of toolHistory)` is the exact statement that threw',
)
check(
  'the adapter reads the history through its two lists',
  /toolHistory\?\.tools/.test(adapter) && /toolHistory\?\.updates/.test(adapter),
  'the base set, the history tools, and the per-message additions are merged',
)
check(
  'the adapter guards the history with an array check, not a length check',
  /Array\.isArray\(toolHistory\?\.updates\)/.test(adapter) && !/toolHistory\.length\s*===\s*0/.test(adapter),
  "the length of an object is undefined, so a `length === 0` guard never fires",
)

// --- 4. the host re-throws an adapter failure, so a bare TypeError points at the adapter ---
check(
  'the host wraps a non-LlmError as code UNKNOWN',
  /error instanceof LlmError \? error\.failure : \{/.test(s) && /code:\s*"UNKNOWN"/.test(s),
  'a bare TypeError message with code UNKNOWN originates in the adapter, not in the host',
)

// --- 5. the tool-call-delta chunk requires a string id on EVERY delta ---------------------
// The host validates a delta as it arrives, before it can assemble the block:
//
//   if (typeof chunk.id !== "string") throw new TypeError("tool-call-delta id must be a string")
//
// An OpenAI-shaped stream sends the id only on the first chunk of a call and carries nothing but
// `arguments` on the rest, so a delta that omits the id is rejected.
check(
  'the host rejects a tool-call-delta without a string id',
  s.includes('tool-call-delta id must be a string'),
  'the validation runs on every delta, not only on the first',
)

const streamChunk = s.match(/"name":\s*"StreamChunk",\s*"declaration":\s*"(export type StreamChunk = [^"]*)"/)
check(
  'StreamChunk declares tool-call-delta with a required id',
  streamChunk !== null &&
    /'tool-call-delta';\s*index:\s*number;\s*id:\s*ToolCallId;\s*name\?:\s*string/.test(
      streamChunk[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
    ),
  streamChunk ? 'the id is required; only the name is optional' : 'the declaration was not found',
)

// The delta the adapter yields must carry the id unconditionally. The `tracker.append` call above
// it may omit an id — there, "no id yet" is meaningful — so only the yielded chunk is inspected.
const emittedDelta = adapter.match(/yield\s*\{\s*type:\s*'tool-call-delta',[\s\S]{0,220}?argumentsDelta,?\s*\}/)
check(
  'the adapter emits a string id on every tool-call-delta',
  emittedDelta !== null && /\bid,\s*\n/.test(emittedDelta[0]),
  emittedDelta
    ? 'the yielded chunk sets `id` unconditionally'
    : 'the tool-call-delta chunk was not found',
)
check(
  'the adapter derives an id for a stream that never sent one',
  /kilo-call-\$\{index\}/.test(adapter),
  'a provider that omits the id still yields a valid branded id',
)

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (r.detail) console.log(`        ${r.detail}`)
}
console.log(`host contract probe: ${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
