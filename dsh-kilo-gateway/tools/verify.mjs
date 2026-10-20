/**
 * Offline verification of the streaming contract and the failure classifier.
 *
 * Runs the real adapter against a stubbed `fetch`, so it exercises the actual SSE reader, the
 * block tracker, the chunk ordering, and the self-healing loop without touching the network or
 * needing a credential. Run with: node tools/verify.mjs
 */

import assert from 'node:assert/strict'

import { KiloGatewayAdapter } from '../lib/adapter.js'
import {
  applyRepair,
  classifyEmptyStream,
  classifyHttp,
  classifyTransportError,
  planRecovery,
  repairBudget,
} from '../lib/resilience.js'

let passed = 0
/** @type {{ name: string; fn: () => void }[]} */
const queue = []

/**
 * Queue one check. The body may be sync or async; it is awaited by {@link runAll} below, so a
 * synchronous wrapper can never print PASS for a body that has not actually run.
 *
 * @param {string} name
 * @param {() => unknown} fn
 */
function check(name, fn) {
  queue.push({ name, fn })
}

/** Run every queued check in order, reporting truthfully. */
async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn()
      passed += 1
      console.log(`  PASS  ${name}`)
    } catch (error) {
      console.log(`  FAIL  ${name}`)
      console.log(`        ${error instanceof Error ? error.message : error}`)
      process.exitCode = 1
    }
  }
  return passed
}

/** Build an SSE body from raw frame strings, using CRLF like Kilo's gateway does. */
function sse(frames, terminator = '\r\n\r\n') {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(`data: ${frame}${terminator}`))
      }
      controller.close()
    },
  })
}

/**
 * Stub `fetch` and record only the chat-completion requests.
 *
 * Resolving model limits fetches the catalogue first, so a naive call counter also sees `/models`
 * traffic; scoping to the chat route keeps each assertion about the dispatch under test.
 *
 * @param {(attempt: number, body: any) => Response | Promise<Response>} handler
 * @returns {{ chats: () => any[]; calls: () => number }}
 */
function stubChat(handler) {
  const original = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('/chat/completions')) {
      bodies.push(JSON.parse(init.body))
      return handler(bodies.length - 1, bodies.at(-1))
    }
    // The catalogue is irrelevant here; answer with an empty one.
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  return {
    chats: () => bodies,
    calls: () => bodies.length,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const okChunk = { choices: [{ index: 0, delta: { content: 'ok' } }] }
const finishChunk = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
const usageChunk = { usage: { prompt_tokens: 11, completion_tokens: 3 } }

/** Collect every chunk an adapter dispatch emits. */
async function collect(adapter, options, model = 'kilo-auto/free') {
  const chunks = []
  for await (const chunk of adapter.streamCall(options, model)) chunks.push(chunk)
  return chunks
}

/** One user turn, which is all the streaming tests need. */
const oneTurn = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

/** A context whose credentials service resolves nothing, so the route runs anonymous. */
const anonymousCtx = {
  logger: { warn() {}, error() {} },
  get: () => undefined,
}

console.log('\n[streaming contract]')

check('a complete stream emits block-end for its text block', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(sse([JSON.stringify(okChunk), JSON.stringify(usageChunk), JSON.stringify(finishChunk)]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const end = chunks.find((c) => c.type === 'block-end')
    assert.ok(end, 'no block-end was emitted')
    assert.equal(end.block.type, 'text')
    assert.equal(end.block.text, 'ok')
    assert.equal(end.index, 1000)
  } finally {
    globalThis.fetch = original
  }
})

check('usage is its own chunk, not attached to finish', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(sse([JSON.stringify(okChunk), JSON.stringify(usageChunk), JSON.stringify(finishChunk)]), {
      status: 200,
    })
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage, 'no usage chunk')
    assert.equal(usage.usage.inputTokens, 11)
    assert.equal(usage.usage.outputTokens, 3)
    assert.equal(usage.usage.totalTokens, 14)
    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish, 'no finish chunk')
    assert.equal(finish.usage, undefined, 'finish must not carry usage')
  } finally {
    globalThis.fetch = original
  }
})

check('chunk order is start, delta, end, usage, finish', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(sse([JSON.stringify(okChunk), JSON.stringify(usageChunk), JSON.stringify(finishChunk)]), { status: 200 })
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const order = chunks.map((c) => c.type).join(',')
    assert.equal(order, 'block-start,text-delta,block-end,usage,finish')
  } finally {
    globalThis.fetch = original
  }
})

check('a tool call block ends with a valid tool-call block', async () => {
  const original = globalThis.fetch
  const toolFrame = {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'kilo_account', arguments: '{"includeQuota":true}' } }] },
      },
    ],
  }
  globalThis.fetch = async () =>
    new Response(sse([JSON.stringify(toolFrame), JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })]), { status: 200 })
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const end = chunks.find((c) => c.type === 'block-end')
    assert.ok(end, 'no block-end for the tool call')
    assert.equal(end.block.type, 'tool-call')
    assert.equal(end.block.name, 'kilo_account')
    assert.equal(JSON.parse(end.block.arguments).includeQuota, true)
  } finally {
    globalThis.fetch = original
  }
})

check('a stream cut without a terminating blank line still flushes its frame', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(okChunk)}`))
          c.close()
        },
      }),
      { status: 200 },
    )
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok'), 'tail frame was lost')
  } finally {
    globalThis.fetch = original
  }
})

check('usage arriving after finish_reason is still reported', async () => {
  const original = globalThis.fetch
  // The ordering Kilo actually uses: terminal reason first, accounting second.
  globalThis.fetch = async () =>
    new Response(sse([JSON.stringify(okChunk), JSON.stringify(finishChunk), JSON.stringify(usageChunk)]), { status: 200 })
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    assert.ok(chunks.some((c) => c.type === 'usage'), 'usage after finish_reason was dropped')
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.find((c) => c.type === 'finish').reason.kind, 'stop')
  } finally {
    globalThis.fetch = original
  }
})

check('a truncated answer is reported as max-tokens, not a clean stop', async () => {
  const original = globalThis.fetch
  const reasoningFrame = { choices: [{ index: 0, delta: { reasoning: 'thinking...' } }] }
  globalThis.fetch = async () => new Response(sse([JSON.stringify(reasoningFrame)]), { status: 200 })
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const finish = chunks.find((c) => c.type === 'finish')
    assert.ok(finish, 'no finish chunk')
    assert.equal(finish.reason.kind, 'max-tokens')
    assert.ok(chunks.some((c) => c.type === 'block-end' && c.block.type === 'reasoning'))
  } finally {
    globalThis.fetch = original
  }
})

console.log('\n[self-healing]')

check('a 500 is retried silently and the retry succeeds', async () => {
  const stub = stubChat((attempt) =>
    attempt === 0
      ? new Response('upstream exploded', { status: 503 })
      : new Response(sse([JSON.stringify(okChunk), JSON.stringify(finishChunk)]), { status: 200 }),
  )
  try {
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), oneTurn)
    assert.equal(stub.calls(), 2, `expected one retry, saw ${stub.calls()} chat calls`)
    assert.equal(chunks.find((c) => c.type === 'text-delta').text, 'ok')
    assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1, 'the failed attempt must not leak a block-start')
  } finally {
    stub.restore()
  }
})

check('a repairable parameter fault replays with a repaired body', async () => {
  const stub = stubChat((attempt) =>
    attempt === 0
      ? new Response('tool definitions are not supported', { status: 400 })
      : new Response(sse([JSON.stringify(okChunk), JSON.stringify(finishChunk)]), { status: 200 }),
  )
  try {
    const tools = [{ type: 'function', function: { name: 'kilo_account', parameters: { type: 'object' } } }]
    const chunks = await collect(new KiloGatewayAdapter(anonymousCtx), { ...oneTurn, tools })
    assert.equal(stub.calls(), 2, `expected one repair round, saw ${stub.calls()}`)
    assert.ok(stub.chats()[0].tools !== undefined, 'the first attempt should have sent tools')
    assert.equal(stub.chats()[1].tools, undefined, 'the repaired attempt should have dropped them')
    assert.equal(chunks.find((c) => c.type === 'text-delta').text, 'ok')
  } finally {
    stub.restore()
  }
})

check('an unrepairable fault surfaces instead of looping', async () => {
  const stub = stubChat(() => new Response('no credential', { status: 401 }))
  try {
    await assert.rejects(
      () => collect(new KiloGatewayAdapter(anonymousCtx), oneTurn),
      (error) => {
        assert.equal(error.code, 'AUTH')
        return true
      },
    )
    assert.equal(stub.calls(), 1, 'an auth fault must not be retried')
  } finally {
    stub.restore()
  }
})

check('a caller abort is propagated, not retried', async () => {
  const controller = new AbortController()
  const stub = stubChat(() => {
    controller.abort(new Error('user cancelled'))
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  })
  try {
    await assert.rejects(
      () => collect(new KiloGatewayAdapter(anonymousCtx), { ...oneTurn, signal: controller.signal }),
      (error) => {
        // The caller's own error, not a mislabelled gateway failure.
        assert.equal(error.message, 'user cancelled')
        return true
      },
    )
    assert.equal(stub.calls(), 1, 'an abort must not be retried')
  } finally {
    stub.restore()
  }
})

console.log('\n[request fidelity]')

check('the system prompt reaches the wire', async () => {
  const stub = stubChat(() => new Response(sse([JSON.stringify(okChunk), JSON.stringify(finishChunk)]), { status: 200 }))
  try {
    await collect(new KiloGatewayAdapter(anonymousCtx), { ...oneTurn, system: 'be terse' })
    assert.equal(stub.chats()[0].messages[0].role, 'system')
    assert.equal(stub.chats()[0].messages[0].content, 'be terse')
  } finally {
    stub.restore()
  }
})

check('stop sequences reach the wire', async () => {
  const stub = stubChat(() => new Response(sse([JSON.stringify(okChunk), JSON.stringify(finishChunk)]), { status: 200 }))
  try {
    await collect(new KiloGatewayAdapter(anonymousCtx), { ...oneTurn, stop: ['END'] })
    assert.deepEqual(stub.chats()[0].stop, ['END'])
  } finally {
    stub.restore()
  }
})

check('tools added mid-session are sent, removed ones are not', async () => {
  const stub = stubChat(() => new Response(sse([JSON.stringify(okChunk), JSON.stringify(finishChunk)]), { status: 200 }))
  try {
    await collect(new KiloGatewayAdapter(anonymousCtx), {
      ...oneTurn,
      tools: [{ name: 'kilo_account', description: 'a', parameters: { type: 'object' } }],
      toolHistory: [
        { messageId: 'm1', additions: [{ name: 'kilo_login', description: 'b', parameters: { type: 'object' } }] },
        { messageId: 'm2', removals: [{ type: 'tool-removal', toolName: 'kilo_account' }] },
      ],
    })
    const names = stub.chats()[0].tools.map((t) => t.function.name)
    assert.deepEqual(names, ['kilo_login'])
  } finally {
    stub.restore()
  }
})

console.log('\n[failure classification]')

check('a context-length 400 is a parameter fault with a shrink repair', () => {
  const c = classifyHttp(400, 'context_length_exceeded: prompt is too long')
  assert.equal(c.kind, 'parameter')
  assert.equal(c.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(c.repair, 'shrink')
})

check('an invalid tool schema 400 is a parameter fault with a drop-tools repair', () => {
  const c = classifyHttp(400, 'invalid_request: tool definitions are not supported by this model')
  assert.equal(c.kind, 'parameter')
  assert.equal(c.repair, 'drop-tools')
})

check('a 401 is an auth fault, not a parameter fault', () => {
  assert.equal(classifyHttp(401, '').kind, 'auth')
  assert.equal(classifyHttp(403, '').kind, 'auth')
})

check('a 500 is a stream fault and retryable', () => {
  const c = classifyHttp(500, 'bad gateway')
  assert.equal(c.kind, 'stream')
  assert.equal(c.retryable, true)
})

check('a dead socket is a retryable stream fault', () => {
  assert.equal(classifyTransportError(new Error('terminated')).code, 'TRANSPORT')
  assert.equal(classifyTransportError(new Error('The operation was aborted due to timeout')).code, 'TIMEOUT')
})

check('a caller abort is never retried', () => {
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
  assert.equal(classifyTransportError(abort).retryable, false)
})

check('billed-but-empty output is reported, not replayed', () => {
  const c = classifyEmptyStream({ outputTokens: 42 })
  assert.equal(c.code, 'MALFORMED_RESPONSE')
  assert.equal(c.retryable, false)
})

console.log('\n[recovery policy]')

check('nothing visible yet -> silent retry', () => {
  const plan = planRecovery({ kind: 'stream', code: 'TRANSPORT', retryable: true }, { emitted: false, hasToolCall: false })
  assert.equal(plan.retry, true)
  assert.equal(plan.continueFromPrefix, false)
})

check('a tool call in flight -> never retried', () => {
  const plan = planRecovery({ kind: 'stream', code: 'TRANSPORT', retryable: true }, { emitted: true, hasToolCall: true })
  assert.equal(plan.retry, false)
})

check('a deterministic parameter fault is not retried verbatim', () => {
  const plan = planRecovery({ kind: 'parameter', code: 'INVALID_REQUEST', retryable: false }, { emitted: false, hasToolCall: false })
  assert.equal(plan.retry, false)
})

check('repairs only remove content', () => {
  const messages = [
    { role: 'system', content: 'stay concise' },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
  ]
  const trimmed = applyRepair({ messages }, 'drop-images').messages
  assert.ok(trimmed.length === messages.length, 'drop-images must keep every message')
  assert.deepEqual(trimmed[1].content, [{ type: 'text', text: 'a' }])
  const shrunk = applyRepair({ messages, tools: [{ name: 't' }] }, 'shrink')
  assert.ok(shrunk.messages.length < messages.length, 'shrink must shorten the history')
  assert.equal(shrunk.messages[0].role, 'system', 'shrink must keep the system message')
  assert.deepEqual(applyRepair({ messages, tools: [{ name: 't' }] }, 'drop-tools').tools, undefined)
})

check('the repair budget is small and bounded', () => {
  assert.equal(repairBudget(), 2)
  assert.equal(repairBudget({ repairBudget: 99 }), 3)
  assert.equal(repairBudget({ repairBudget: -5 }), 0)
})

const total = await runAll()
console.log(`\n${total} checks passed${process.exitCode ? ' (with failures above)' : ''}.\n`)