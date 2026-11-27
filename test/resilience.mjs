// Resilience tests: timeout, retry, and retry exhaustion.
//
// The store directory is resolved at module load time, so every scenario runs in its own
// child process with its own temp store. The parent just spawns and reports.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const scenario = process.argv[2]

if (scenario) {
  await runScenario(scenario)
} else {
  let failed = 0
  for (const name of ['timeout-no-retry', 'timeout-retry-exhausted', 'error-retry-then-success', 'retry-is-bounded']) {
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

  const dir = await mkdtemp(join(tmpdir(), `sa-res-${name}-`))
  process.env.DSH_SUPERAGENT_MINI_DIR = dir
  const { apply } = await import('../index.js')

  const failures = []
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${name}] ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(label)
  }

  const tools = new Map()
  const interrupted = []
  let activations = 0
  const hang = () => new Promise(() => {}) // never settles: models a stuck Executor

  const failLater = (message) => new Promise((_, reject) => {
    // Reject on a later tick: dispatchTicket awaits a store patch before it can attach a
    // handler to result, and an already-rejected promise would surface as unhandled.
    setTimeout(() => reject(new Error(message)), 0)
  })
  const subagents = {
    list: () => ['mock-provider'],
    startActivation: async (opts) => {
      activations++
      const childId = `child-${activations}`
      let result
      if (name === 'timeout-no-retry' || name === 'timeout-retry-exhausted') {
        result = hang()
      } else if (name === 'error-retry-then-success') {
        result = activations === 1
          ? failLater('boom: provider crashed')
          : Promise.resolve({ output: [{ type: 'text', text: 'recovered' }], stopReason: 'done' })
      } else {
        result = failLater(`boom #${activations}`)
      }
      return { childId, result }
    },
    interrupt: (childId) => { interrupted.push(childId) },
  }
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (key) => (key === 'subagents' ? subagents : key === 'agents' ? { currentInitiator: () => ({ id: 'parent' }) } : undefined),
    logger: { info: () => {}, warn: () => {} },
  }

  const config = {
    autoDispatch: true,
    maxConcurrent: 1,
    startupDelayMs: 0,
    executorTimeoutMs: 1_000,
    maxRetries: name === 'timeout-no-retry' ? 0 : 1,
  }
  apply(ctx, config)

  const request = tools.get('superagent_request')
  const accepted = await request.execute({ text: `scenario ${name}`, sender: 'u', title: name })
  // accept() returns { decision, trigger, ticket }; the id is nested as ticket.ticket_id.
  const ticketId = accepted.ticket?.ticket_id
  check('request accepted', accepted.decision === 'accept', accepted.decision)

  const readTicket = async () => {
    const store = JSON.parse(await readFile(join(dir, 'tickets.json'), 'utf8'))
    return store.tickets.find(t => t.id === ticketId)
  }
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await readTicket()
      if (last && predicate(last)) return last
      await new Promise(r => setTimeout(r, 50))
    }
    return last
  }

  const terminal = t => t && ['failed', 'ended'].includes(t.assignment?.status)

  if (name === 'timeout-no-retry') {
    const t = await waitFor(terminal, 4_000)
    check('ticket reached failed', t.assignment?.status === 'failed', t.assignment?.status)
    check('error names the timeout', /timed out/i.test(t.assignment?.error ?? ''), t.assignment?.error)
    check('executor was interrupted', interrupted.length === 1, `interrupt calls: ${interrupted.length}`)
    check('did not retry', activations === 1, `activations: ${activations}`)
  }

  if (name === 'timeout-retry-exhausted') {
    const t = await waitFor(terminal, 8_000)
    check('ticket reached failed after retries', t.assignment?.status === 'failed', t.assignment?.status)
    check('ran exactly two attempts', activations === 2, `activations: ${activations}`)
    check('both attempts interrupted their executor', interrupted.length === 2, `interrupt calls: ${interrupted.length}`)
  }

  if (name === 'error-retry-then-success') {
    const t = await waitFor(terminal, 8_000)
    check('ticket ended after retry', t.assignment?.status === 'ended', t.assignment?.status)
    check('report came from the second attempt', /recovered/.test(t.report?.output ?? ''), t.report?.output)
    check('_attempts persisted', t._attempts === 1, String(t._attempts))
  }

  if (name === 'retry-is-bounded') {
    // The fake executor fails on every attempt. With maxRetries=1 the Ticket must give up
    // after two attempts; an attempts counter that never advances would retry forever.
    const t = await waitFor(terminal, 10_000)
    check('ticket reached failed (not stuck retrying)', t.assignment?.status === 'failed', t.assignment?.status)
    check('stops at two attempts', activations === 2, `activations: ${activations}`)
    const stale = await readTicket()
    check('failure carries the last error', /boom/.test(stale.assignment?.error ?? ''), stale.assignment?.error)
  }

  await rm(dir, { recursive: true, force: true })
  if (failures.length > 0) {
    console.log(`\n${name}: FAILED → ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log(`${name}: ok\n`)
}
