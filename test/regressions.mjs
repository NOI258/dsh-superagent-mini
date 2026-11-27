// Regression tests for defects found in index.js. Each scenario runs in its own child
// process with its own temp store, because the store path is resolved at module load.
//
//   cancel-during-dispatch-startup   — a cancel that lands while startActivation() is still
//                                      pending must not be overwritten when the child comes up
//   reply-while-queued               — a reply to a Ticket that is still waiting in the queue
//                                      must not create a second Executor, and must reach the
//                                      Executor that is about to start
//   recall-newest-first              — superagent_recall documents "newest first"
//   memory-selection-recency         — selectMemories documents "scope, then tags, then recency"
//   store-read-failure-is-not-unhandled — a rejected dispatch must not kill the process
//   cancel-keeps-finished-report     — cancelling an already finished Ticket must not erase its report
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const scenario = process.argv[2]

const SCENARIOS = [
  'cancel-during-dispatch-startup',
  'reply-while-queued',
  'recall-newest-first',
  'memory-selection-recency',
  'store-read-failure-is-not-unhandled',
  'cancel-keeps-finished-report',
]

if (scenario) {
  await runScenario(scenario)
} else {
  let failed = 0
  for (const name of SCENARIOS) {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [self, name], { stdio: 'inherit' })
      child.on('exit', resolve)
    })
    if (code !== 0) failed++
  }
  console.log(failed === 0 ? '\nALL PASS' : `\nFAILED scenarios: ${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}

async function runScenario(name) {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), `sa-reg-${name}-`))
  process.env.DSH_SUPERAGENT_MINI_DIR = dir
  const { apply } = await import('../index.js')

  const failures = []
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${name}] ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(label)
  }

  const tools = new Map()
  const logs = []
  const ctxFor = (subagents) => ({
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (key) => (key === 'subagents' ? subagents : key === 'agents' ? { currentInitiator: () => ({ id: 'parent' }) } : undefined),
    logger: {
      info: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push(a.map(String).join(' ')),
    },
  })

  const readStore = async () => JSON.parse(await readFile(join(dir, 'tickets.json'), 'utf8'))
  const readMemories = async () => JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8'))
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await sleep(25)
    }
    return false
  }
  const findTicket = async (ticketId) => (await readStore()).tickets.find(t => t.id === ticketId)
  // A dispatch may still be writing its report while the checks are done; a plain rm can then
  // hit ENOTEMPTY as the file reappears. Retry the teardown instead of failing the scenario.
  const cleanup = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        return
      } catch {
        await sleep(100)
      }
    }
  }

  if (name === 'cancel-during-dispatch-startup') {
    // startActivation() is awaited: a person can cancel while the provider is still starting
    // the child. The cancel lands before `live` has the child id, so the dispatch path itself
    // has to notice the withdrawn Ticket and stop the child it just created.
    let activations = 0
    let openGate
    const interrupted = []
    const subagents = {
      list: () => ['mock-provider'],
      startActivation: async () => {
        activations++
        await new Promise((resolve) => { openGate = resolve })
        return {
          childId: 'child-1',
          result: Promise.resolve({ output: [{ type: 'text', text: 'stale executor output' }], stopReason: 'done' }),
        }
      },
      interrupt: (childId) => interrupted.push(childId),
    }
    apply(ctxFor(subagents), {
      autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, executorTimeoutMs: 60_000, maxRetries: 0,
    })
    const request = tools.get('superagent_request')
    const cancel = tools.get('superagent_ticket')
    const accepted = await request.execute({ text: 'cancel me while starting', sender: 'u', title: 'starting' })
    const ticketId = accepted.ticket?.ticket_id
    const started = await waitFor(async () => activations === 1, 2_000)
    check('executor start was requested', started, `activations: ${activations}`)

    const cancelled = await cancel.execute({ action: 'cancel', ticket_id: ticketId, reason: 'withdraw during startup' })
    check('cancel accepted', cancelled.status === 'ended', cancelled.status)

    openGate?.()
    await sleep(400)
    const ticket = await findTicket(ticketId)
    check('cancelled assignment state survives the child starting', ticket.assignment?.status === 'cancelled', String(ticket.assignment?.status))
    check('cancel report survives the child starting', ticket.report?.stop_reason === 'cancelled', String(ticket.report?.stop_reason))
    check('the started child was interrupted', interrupted.length === 1 && interrupted[0] === 'child-1', JSON.stringify(interrupted))
    check('the cancelled ticket was not retried', activations === 1, `activations: ${activations}`)
  }

  if (name === 'reply-while-queued') {
    // Two Executors occupy both slots, so the third Ticket waits in `pending`. A reply written
    // while it waits must be part of the prompt its Executor receives, and must not queue the
    // Ticket a second time (two copies would start two Executors once slots free up).
    let activations = 0
    const prompts = []
    const releases = new Map()
    const subagents = {
      list: () => ['mock-provider'],
      startActivation: async (opts) => {
        activations++
        const childId = `child-${activations}`
        const label = opts.label
        prompts.push({ label, text: opts.request.prompt?.[0]?.text ?? '' })
        // Only the two blockers hang; the third Ticket's Executor finishes on its own.
        const result = label.startsWith('blocker')
          ? new Promise((resolve) => {
              releases.set(label, () => resolve({ output: [{ type: 'text', text: `${label} done` }], stopReason: 'done' }))
            })
          : Promise.resolve({ output: [{ type: 'text', text: `${label} done` }], stopReason: 'done' })
        return { childId, result }
      },
      interrupt: () => {},
    }
    apply(ctxFor(subagents), {
      autoDispatch: true, maxConcurrent: 2, startupDelayMs: 0, executorTimeoutMs: 60_000, maxRetries: 0,
    })
    const request = tools.get('superagent_request')
    const reply = tools.get('superagent_ticket')
    await request.execute({ text: 'blocker one', sender: 'u', title: 'blocker one' })
    await request.execute({ text: 'blocker two', sender: 'u', title: 'blocker two' })
    const bothStarted = await waitFor(async () => activations === 2, 2_000)
    check('both blocking executors started', bothStarted, `activations: ${activations}`)

    const third = await request.execute({ text: 'third request', sender: 'u', title: 'third' })
    const thirdId = third.ticket?.ticket_id
    const replied = await reply.execute({ action: 'reply', ticket_id: thirdId, text: 'also translate the LICENSE' })
    check('reply recorded', replied.ticket_id === thirdId, replied.outcome)

    releases.get('blocker one')?.()
    releases.get('blocker two')?.()
    const thirdDone = await waitFor(async () => {
      const ticket = await findTicket(thirdId)
      return ticket?.status === 'ended'
    }, 4_000)
    check('queued ticket finished', thirdDone)
    await sleep(300)

    const thirdPrompts = prompts.filter(p => p.label === 'third')
    check('queued ticket got exactly one executor', thirdPrompts.length === 1, `executors: ${thirdPrompts.length}`)
    check('executor sees the reply written while queued', (thirdPrompts[0]?.text ?? '').includes('also translate the LICENSE'))
    const ticket = await findTicket(thirdId)
    check('queued ticket ended cleanly', ticket.status === 'ended', ticket.status)
  }

  if (name === 'recall-newest-first') {
    // superagent_recall says "newest first". Two lessons written in order must come back with
    // the later one first; insertion order answers oldest first.
    apply(ctxFor({ list: () => [], startActivation: async () => ({ childId: 'x', result: Promise.resolve({ output: [] }) }), interrupt: () => {} }), { autoDispatch: false })
    const remember = tools.get('superagent_memory')
    const recall = tools.get('superagent_memory')
    await remember.execute({ action: 'remember', text: 'older lesson' })
    await sleep(10)
    await remember.execute({ action: 'remember', text: 'newer lesson' })
    const result = await recall.execute({ action: 'recall' })
    check('recall returns the newest memory first', result.memories?.[0]?.text === 'newer lesson', result.memories?.map(m => m.text).join(' | '))
  }

  if (name === 'memory-selection-recency') {
    // Selection is capped at five. With six equally scored global memories, "then recency"
    // means the oldest one must be the one left out; without a recency term the newest lesson
    // never reaches any Executor.
    await writeFile(join(dir, 'memory.json'), JSON.stringify({
      memories: Array.from({ length: 6 }, (_, i) => ({
        id: `m-${i + 1}`,
        text: `lesson ${i + 1}`,
        tags: [],
        scope: 'global',
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        used: 0,
      })),
    }, null, 2))
    const prompts = []
    const subagents = {
      list: () => ['mock-provider'],
      startActivation: async (opts) => {
        prompts.push(opts.request.prompt?.[0]?.text ?? '')
        return { childId: 'child-1', result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'done' }) }
      },
      interrupt: () => {},
    }
    apply(ctxFor(subagents), { autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, executorTimeoutMs: 60_000 })
    const request = tools.get('superagent_request')
    const accepted = await request.execute({ text: 'do some work', sender: 'u', title: 'work' })
    const prompted = await waitFor(async () => prompts.length > 0, 2_000)
    check('executor received a prompt', prompted)
    check('newest memory is selected', (prompts[0] ?? '').includes('lesson 6'))
    check('oldest memory is the one dropped', !(prompts[0] ?? '').includes('lesson 1'))
    const state = await readMemories()
    check('seeded memories were not rewritten', state.memories.length === 6, `memories: ${state.memories.length}`)
    // Let the dispatch record its report before the store is torn down.
    await waitFor(async () => (await findTicket(accepted.ticket?.ticket_id))?.status === 'ended', 2_000)
  }

  if (name === 'store-read-failure-is-not-unhandled') {
    // A failed dispatch (here caused by an unreadable store) must be logged, not surface as an
    // unhandled rejection: an unhandled rejection terminates the whole host process.
    const unhandled = []
    process.on('unhandledRejection', (error) => unhandled.push(error))
    let rejectResult
    const subagents = {
      list: () => ['mock-provider'],
      startActivation: async () => {
        return {
          childId: 'child-1',
          result: new Promise((_, reject) => { rejectResult = reject }),
        }
      },
      interrupt: () => {},
    }
    apply(ctxFor(subagents), {
      autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, executorTimeoutMs: 60_000, maxRetries: 0,
    })
    const request = tools.get('superagent_request')
    const accepted = await request.execute({ text: 'break the store', sender: 'u', title: 'break' })
    const ticketId = accepted.ticket?.ticket_id
    const running = await waitFor(async () => (await findTicket(ticketId))?.assignment?.status === 'running', 2_000)
    check('executor is running', running)

    await writeFile(join(dir, 'tickets.json'), '{ this is not valid json')
    rejectResult?.(new Error('executor crashed'))
    await sleep(500)
    check('no unhandled rejection escaped', unhandled.length === 0, unhandled.map(e => String(e?.message ?? e)).join(' | '))
    check('the failed dispatch was logged', logs.some(line => /dispatch/i.test(line)), logs.join(' | '))

    // Leave a readable store behind so cleanup does not warn.
    await writeFile(join(dir, 'tickets.json'), JSON.stringify({ tickets: [], triggers: {} }))
  }

  if (name === 'cancel-keeps-finished-report') {
    // The Ticket already ended with an Executor report. Cancelling it afterwards must not
    // rewrite that report: the report is the record of work that actually happened.
    const subagents = {
      list: () => ['mock-provider'],
      startActivation: async () => ({
        childId: 'child-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'real finished output' }], stopReason: 'done' }),
      }),
      interrupt: () => {},
    }
    apply(ctxFor(subagents), { autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, executorTimeoutMs: 60_000, maxRetries: 0 })
    const request = tools.get('superagent_request')
    const cancel = tools.get('superagent_ticket')
    const accepted = await request.execute({ text: 'finish before cancel', sender: 'u', title: 'finished' })
    const ticketId = accepted.ticket?.ticket_id
    const ended = await waitFor(async () => (await findTicket(ticketId))?.status === 'ended', 2_000)
    check('ticket finished before the cancel', ended)

    await cancel.execute({ action: 'cancel', ticket_id: ticketId, reason: 'too late' })
    const ticket = await findTicket(ticketId)
    check('finished report is preserved', ticket.report?.stop_reason === 'done', String(ticket.report?.stop_reason))
    check('finished output is preserved', String(ticket.report?.output ?? '').includes('real finished output'))
    check('assignment is still ended', ticket.assignment?.status === 'ended', String(ticket.assignment?.status))
  }

  await sleep(50)
  await cleanup()
  if (failures.length > 0) {
    console.log(`\n${name}: FAILED → ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log(`${name}: ok\n`)
}
