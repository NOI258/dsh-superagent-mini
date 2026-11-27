// Consistency tests: trigger idempotence, memory write ordering, and cancel races.
//
// Each scenario needs its own store, and the store path is resolved at module load, so every
// case runs in a child process. The parent only spawns and reports.
//
// Two cancel scenarios are kept apart on purpose:
//   cancel-stops-pending-retry        — cancel lands while a retry is waiting in backoff
//   cancel-during-running-executor    — cancel lands while an Executor holds the Ticket,
//                                       and the Executor's failure arrives after the cancel
// They fail for different reasons and one cannot stand in for the other.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const scenario = process.argv[2]

const SCENARIOS = [
  'rejected-trigger-is-idempotent',
  'memory-writes-do-not-collide',
  'cancel-stops-pending-retry',
  'cancel-during-running-executor',
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
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), `sa-con-${name}-`))
  process.env.DSH_SUPERAGENT_MINI_DIR = dir
  const { apply } = await import('../index.js')

  const failures = []
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${name}] ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(label)
  }

  const tools = new Map()
  let activations = 0
  const interrupted = []
  // Rejects on a later tick: dispatchTicket awaits a store patch before it can attach a
  // handler to result, and an already-rejected promise would surface as unhandled.
  const failLater = (message) => new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), 0)
  })
  // Set only while a scenario wants a pending Executor it can interrupt from the outside.
  let rejectLive = null

  const subagents = {
    list: () => ['mock-provider'],
    startActivation: async () => {
      activations++
      const childId = `child-${activations}`
      if (name === 'cancel-during-running-executor') {
        // A real Executor runs until something stops it. The test stops it through interrupt.
        const result = new Promise((_, reject) => { rejectLive = reject })
        return { childId, result }
      }
      return { childId, result: failLater(`boom #${activations}`) }
    },
    interrupt: (childId) => {
      interrupted.push(childId)
      // Models subagents.interrupt: the Executor's result promise rejects after the cancel.
      rejectLive?.(new Error('executor interrupted by ancestor'))
    },
  }
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (key) => (key === 'subagents' ? subagents : key === 'agents' ? { currentInitiator: () => ({ id: 'parent' }) } : undefined),
    logger: { info: () => {}, warn: () => {} },
  }

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

  if (name === 'rejected-trigger-is-idempotent') {
    // A listed sender addressing the agent is explicit; an unlisted one falls to the admission
    // matrix and is ignored. The rejection must still be recorded, or the next identical
    // delivery looks new and gets a second decision.
    apply(ctx, { autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, allowedSenders: ['u'] })
    const request = tools.get('superagent_request')
    const first = await request.execute({ text: 'drop this', sender: 'stranger' })
    const second = await request.execute({ text: 'drop this', sender: 'stranger' })
    check('first delivery is ignored', first.decision === 'ignore', first.decision)
    check('second delivery is a duplicate', second.decision === 'duplicate', second.decision)
    check('duplicate reports the earlier rejection', second.previous === 'rejected', second.previous)
    const store = await readStore()
    check('no Ticket was created', store.tickets.length === 0, `tickets: ${store.tickets.length}`)
    check('one trigger recorded', Object.keys(store.triggers).length === 1, `triggers: ${Object.keys(store.triggers).length}`)
  }

  if (name === 'memory-writes-do-not-collide') {
    // Ten concurrent writers on one file. Without a lock they all read the same snapshot and
    // the last rename wins, silently dropping the other nine lessons.
    apply(ctx, { autoDispatch: false })
    const remember = tools.get('superagent_remember')
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      remember.execute({ text: `lesson number ${i}`, tags: ['concurrency'], scope: 't' })))
    const state = await readMemories()
    check('all ten memories persisted', state.memories.length === 10, `stored: ${state.memories.length}`)
    const distinct = new Set(state.memories.map(m => m.text)).size
    check('no memory was lost or duplicated', distinct === 10, `distinct: ${distinct}`)
  }

  if (name === 'cancel-stops-pending-retry') {
    // One retry is scheduled after the first failure. Cancelling inside the backoff window
    // must win: the timer is not allowed to requeue a withdrawn Ticket.
    apply(ctx, { autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, executorTimeoutMs: 1_000, maxRetries: 1 })
    const request = tools.get('superagent_request')
    const accepted = await request.execute({ text: 'cancel me', sender: 'u', title: 'cancel me' })
    const ticketId = accepted.ticket?.ticket_id
    await sleep(200) // first attempt failed; retry is now pending
    const cancel = tools.get('superagent_cancel')
    const cancelled = await cancel.execute({ ticket_id: ticketId, reason: 'changed my mind' })
    check('cancel accepted', cancelled.status === 'ended', cancelled.status)
    await sleep(1_500) // past the 1s backoff
    check('retry never ran', activations === 1, `activations: ${activations}`)
    const store = await readStore()
    const ticket = store.tickets.find(t => t.id === ticketId)
    check('ticket stays ended', ticket.status === 'ended', ticket.status)
    check('assignment stays cancelled', ticket.assignment?.status === 'cancelled', ticket.assignment?.status)
  }

  if (name === 'cancel-during-running-executor') {
    // The Executor is mid-run. A cancel interrupts it, and its result promise rejects *after*
    // the cancel has already written ended/cancelled. The failure path must not treat that
    // rejection as a retryable error and overwrite the withdraw.
    apply(ctx, { autoDispatch: true, maxConcurrent: 1, startupDelayMs: 0, executorTimeoutMs: 60_000, maxRetries: 1 })
    const request = tools.get('superagent_request')
    const cancel = tools.get('superagent_cancel')
    const accepted = await request.execute({ text: 'cancel while running', sender: 'u', title: 'running' })
    const ticketId = accepted.ticket?.ticket_id
    // execute() returns as soon as the Ticket is queued; the pump starts the Executor on the
    // next turn, so wait for it instead of reading activations immediately.
    const started = await waitFor(async () => activations >= 1, 3_000)
    check('executor started', started, `activations: ${activations}`)

    const running = await waitFor(async () => {
      const store = await readStore()
      return store.tickets.find(t => t.id === ticketId)?.assignment?.status === 'running'
    }, 3_000)
    check('assignment reached running', running, running ? 'running' : 'never became running')

    const cancelled = await cancel.execute({ ticket_id: ticketId, reason: 'stop while running' })
    check('cancel accepted', cancelled.status === 'ended', cancelled.status)
    check('executor was interrupted', interrupted.length === 1, `interrupt calls: ${interrupted.length}`)

    // Past the retry backoff: a buggy failure path would schedule a second activation here.
    await sleep(1_500)
    check('executor never restarted', activations === 1, `activations: ${activations}`)
    const store = await readStore()
    const ticket = store.tickets.find(t => t.id === ticketId)
    check('ticket stays ended', ticket.status === 'ended', ticket.status)
    check('assignment stays cancelled', ticket.assignment?.status === 'cancelled', ticket.assignment?.status)
    check('cancel reason was kept', ticket.report?.reason === 'stop while running', String(ticket.report?.reason))
  }

  await rm(dir, { recursive: true, force: true })
  if (failures.length > 0) {
    console.log(`\n${name}: FAILED → ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log(`${name}: ok\n`)
}
