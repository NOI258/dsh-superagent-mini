// Smoke test for dsh-superagent-mini. Runs without a real DSH runtime:
// a mock ctx records registered tools and fakes the subagent/agent services.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'sa-mini-'))
process.env.DSH_SUPERAGENT_MINI_DIR = dir

// Seed a store that a previous process left behind: one running, one pending.
await writeFile(join(dir, 'tickets.json'), JSON.stringify({
  tickets: [
    { id: 't-running', status: 'open', title: 'running one', text: 'x', sender: 'u', source: 'tool', thread: 'default', trigger: 'k1', assignment: { executor: 'child-1', status: 'running' }, journal: [], created_at: '2026-11-20T00:00:00.000Z' },
    { id: 't-pending', status: 'open', title: 'pending one', text: 'y', sender: 'u', source: 'tool', thread: 'default', trigger: 'k2', assignment: { executor: null, status: 'pending' }, journal: [], created_at: '2026-11-20T00:00:01.000Z' },
  ],
  triggers: { k1: 't-running', k2: 't-pending' },
}, null, 2))

const { apply } = await import('../index.js')

const tools = new Map()
const dispatched = []
const subagents = {
  list: () => ['mock-provider'],
  startActivation: async (opts) => {
    dispatched.push(opts.label)
    return { childId: `child-${dispatched.length}`, result: Promise.resolve({ output: [{ type: 'text', text: `done: ${opts.label}` }], stopReason: 'done' }) }
  },
  interrupt: () => {},
}
const agents = { currentInitiator: () => ({ id: 'parent' }) }
const logs = []
const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  get: (key) => (key === 'subagents' ? subagents : key === 'agents' ? agents : undefined),
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
}

apply(ctx, { autoDispatch: true, maxConcurrent: 2, executorTimeoutMs: 5_000, startupDelayMs: 0 })
await new Promise(resolve => setTimeout(resolve, 800))

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

check('registers 4 tools', tools.size === 4, `got ${tools.size}`)

// Startup recovery: both seeded Tickets must have been dispatched again.
check('recovery dispatched running ticket', dispatched.includes('running one'))
check('recovery dispatched pending ticket', dispatched.includes('pending one'))

const store = JSON.parse(await readFile(join(dir, 'tickets.json'), 'utf8'))
const running = store.tickets.find(t => t.id === 't-running')
check('running ticket is not left as running', running.assignment.status !== 'running', running.assignment.status)
check('running ticket got an interrupted journal entry', (running.journal ?? []).some(e => e.stop_reason === 'interrupted'))
check('both tickets ended after dispatch', store.tickets.every(t => t.status === 'ended'))

// Idempotence of the admission layer.
const request = tools.get('superagent_request')
const first = await request.execute({ text: 'same request', sender: 'u' })
const second = await request.execute({ text: 'same request', sender: 'u' })
check('first request accepted', first.decision === 'accept', first.decision)
check('second request deduplicated', second.decision === 'duplicate', second.decision)

// Concurrency: many requests at once must not lose writes.
await Promise.all(Array.from({ length: 8 }, (_, i) =>
  request.execute({ text: `burst ${i}`, sender: 'u', title: `burst ${i}` })))
await new Promise(resolve => setTimeout(resolve, 800))
const afterBurst = JSON.parse(await readFile(join(dir, 'tickets.json'), 'utf8'))
check('burst writes all persisted', afterBurst.tickets.length === 11, `got ${afterBurst.tickets.length}`)

// Health snapshot reflects runtime state.
const health = await tools.get('superagent_health').execute({})
check('health reports store dir', health.store.dir === dir)
check('health reports store config', health.config.autoDispatch === true)
console.log('health:', JSON.stringify({ concurrency: health.concurrency, store: health.store }))

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
await rm(dir, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
