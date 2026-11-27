/**
 * dsh-superagent-mini — a minimal super-agent loop for DSH.
 *
 * Follows the domain model of deepseek-ai/dsh-superagent-prototype (MIT):
 *   Source -> Trigger -> Thread -> Eval -> Ticket -> Assignment -> Executor
 *
 * Stage 1 (this file): a tool acts as the Source. It receives a request, applies the
 * admission matrix, deduplicates the Trigger, and persists a Ticket.
 * Stage 2: an accepted Ticket is handed to an Executor — a child DSH session.
 * Stage 3: later messages on the same Thread are fanned out to the live Ticket.
 *
 * Design rules taken from the upstream prototype:
 *  - A Trigger is immutable and idempotent: accepting it twice creates one Ticket.
 *  - A Ticket defines its own state; it does not mirror the Executor Session.
 *  - A Mandate is immutable. Widening the scope needs a new Ticket.
 *  - Admission is a matrix over (sender listed?, message addressed?), not a boolean.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-superagent-mini'
export const inject = ['tools']

const STORE_DIR = process.env.DSH_SUPERAGENT_MINI_DIR
  ?? join(process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh'), 'superagent-mini')
const STORE_FILE = join(STORE_DIR, 'tickets.json')
// Long-term memory is a separate file on purpose: a Ticket's journal dies with the task,
// while a lesson worth keeping must outlive every Ticket that produced it.
const MEMORY_FILE = join(STORE_DIR, 'memory.json')

// Bounds that keep a long-running store from growing without limit.
const MAX_JOURNAL_ENTRIES = 200
const MAX_TRIGGERS = 5_000
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60_000
const DEFAULT_MAX_RETRIES = 1

/**
 * Process-wide mutex for read-modify-write cycles on the store.
 *
 * `writeStore` already uses temp+rename, so a crash mid-write cannot corrupt the file. That
 * does not stop two concurrent tool calls from reading the same snapshot and silently losing
 * each other's edits. Every mutation below runs inside this queue; reads stay concurrent.
 */
function createMutex() {
  let tail = Promise.resolve()
  return function withLock(fn) {
    const run = tail.then(fn, fn)
    tail = run.then(() => {}, () => {})
    return run
  }
}

/** The admission matrix from `src/admission.ts` upstream. Only authored cells are legal. */
const ADMISSION_DEFAULTS = {
  listedUnaddressed: 'inferred',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
}

function admissionCell({ listed, addressed }) {
  if (listed && addressed) return undefined // a listed sender who addresses the agent is always explicit
  if (listed) return 'listedUnaddressed'
  return addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}

/** Deterministic Trigger identity: the same event delivered twice must not fan out twice. */
function triggerKey(source, thread, sender, text) {
  return createHash('sha256')
    .update([source, thread, sender, text].join('\u0000'))
    .digest('hex')
    .slice(0, 32)
}

async function readStore() {
  try {
    return JSON.parse(await readFile(STORE_FILE, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { tickets: [], triggers: {} }
    throw error
  }
}

async function writeStore(store) {
  await mkdir(STORE_DIR, { recursive: true })
  const temp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(store, null, 2))
  await rename(temp, STORE_FILE)
}

function summarize(ticket) {
  return {
    ticket_id: ticket.id,
    status: ticket.status,
    title: ticket.title,
    sender: ticket.sender,
    source: ticket.source,
    thread: ticket.thread,
    assignment: ticket.assignment ? { executor: ticket.assignment.executor, status: ticket.assignment.status } : null,
    created_at: ticket.created_at,
  }
}

export function apply(ctx, config = {}) {
  const allowedSenders = new Set(config.allowedSenders ?? [])
  const autoDispatch = config.autoDispatch ?? true
  const admission = { ...ADMISSION_DEFAULTS, ...(config.admission ?? {}) }
  const storeLock = createMutex()
  // memory.json is a second file with its own read-modify-write cycle. It gets a separate
  // lock: memory tools should not queue behind Ticket bookkeeping, but two concurrent
  // writers must still not read the same snapshot and drop each other's rows.
  const memoryLock = createMutex()
  const executorTimeoutMs = Math.max(1_000, Number(config.executorTimeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS))
  const maxRetries = Math.max(0, Number(config.maxRetries ?? DEFAULT_MAX_RETRIES))
  // Recovery runs during `apply`, which is before every other plugin has finished registering
  // the services `dispatchTicket` needs. Give the tree a moment before pumping the queue.
  const startupDelayMs = Math.max(0, Number(config.startupDelayMs ?? 1_500))
  const startedAt = Date.now()

  // Team state: several people may ask at once, so Requests queue instead of all starting.
  // `live` maps a running Ticket to the Executor that owns it, which is what lets a person stop it.
  const live = new Map()
  const pending = []
  // Ticket ids that are either waiting in `pending` or being handed to an Executor. An id is
  // added once and removed only when that dispatch settles, so one Ticket cannot be given two
  // Executors at once — not even when a reply re-queues a Ticket that was already queued, or a
  // retry fires while the previous attempt is still winding down.
  const inFlight = new Set()
  const maxConcurrent = Math.max(1, Number(config.maxConcurrent ?? 2))
  let runningCount = 0

  /** Adds a Ticket to the queue unless that Ticket is already queued or being dispatched. */
  function queueTicket(ticket) {
    if (inFlight.has(ticket.id)) return false
    inFlight.add(ticket.id)
    pending.push(ticket)
    return true
  }

  /** Runs queued Tickets up to the concurrency limit; the whole team shares one budget of parallelism. */
  function pump() {
    while (runningCount < maxConcurrent && pending.length > 0) {
      const next = pending.shift()
      runningCount++
      void dispatchTicket(next)
        // The failure path itself reads the store. If that read fails too, nothing can be
        // recorded anymore, but the rejection must still be contained: an unhandled rejection
        // would terminate the host process instead of failing one Ticket.
        .catch((error) => {
          ctx.logger?.warn?.('dsh-superagent-mini: dispatch %s failed: %s', next.id, String(error?.message ?? error))
        })
        .finally(() => {
          inFlight.delete(next.id)
          runningCount--
          pump()
        })
    }
  }

  /** Accepts a Ticket into the execution queue and returns without waiting for the Executor. */
  function enqueue(ticket) {
    queueTicket(ticket)
    pump()
  }

  /**
   * Renders a Ticket's own history as prompt text.
   *
   * This is the memory mechanism: the record lives in the store, not in any Session's context.
   * A fresh Executor is told what earlier Executors did, so work survives the Session that
   * started it. Only a bounded tail is rendered — an unbounded journal would recreate the
   * "1k turns" failure it exists to avoid.
   */
  function renderMemory(ticket, limit = 6) {
    const entries = (ticket.journal ?? []).slice(-limit)
    if (entries.length === 0) return ''
    const lines = entries.map(entry => {
      if (entry.kind === 'report') {
        const body = String(entry.output ?? '').replace(/\s+/g, ' ').trim()
        return `- ${entry.at} 执行结束（${entry.stop_reason}）：${body || '（无输出）'}`
      }
      if (entry.kind === 'reply') return `- ${entry.at} 追加要求：${entry.text}`
      if (entry.kind === 'cancel') return `- ${entry.at} 曾被取消：${entry.reason ?? '未说明'}`
      return ''
    }).filter(Boolean)
    return [
      '## 这个 Ticket 之前的记录',
      ...lines,
      '（以上是历史，不是新的要求；当前要求写在下面。）',
      '',
    ].join('\n')
  }

  /** Appends one entry to a Ticket's journal and returns the updated Ticket. */
  async function appendJournal(id, entry) {
    return storeLock(async () => {
      const store = await readStore()
      const row = store.tickets.find(t => t.id === id)
      if (!row) return undefined
      row.journal ??= []
      row.journal.push({ at: new Date().toISOString(), ...entry })
      // The journal is the memory the next Executor reads. An unbounded one would rebuild the
      // "context grows forever" failure this file exists to avoid, so keep only a tail.
      if (row.journal.length > MAX_JOURNAL_ENTRIES) row.journal = row.journal.slice(-MAX_JOURNAL_ENTRIES)
      await writeStore(store)
      return row
    })
  }

  /** Long-term memory: lessons that outlive the Ticket that produced them. */
  async function readMemories() {
    try {
      const parsed = JSON.parse(await readFile(MEMORY_FILE, 'utf8'))
      return { memories: Array.isArray(parsed.memories) ? parsed.memories : [] }
    } catch (error) {
      if (error?.code === 'ENOENT') return { memories: [] }
      throw error
    }
  }

  async function writeMemories(state) {
    await mkdir(STORE_DIR, { recursive: true })
    const temp = `${MEMORY_FILE}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(state, null, 2))
    await rename(temp, MEMORY_FILE)
  }

  /**
   * Picks the long-term memories a given Ticket should see.
   *
   * Selection is deliberately dumb: scope match beats everything, then tag overlap with the
   * Ticket text, then recency. No embeddings — a wrong-but-confident retrieval would be worse
   * than an empty one, and this record is small enough that "show the most used few" works.
   */
  function selectMemories(memories, ticket, limit = 5) {
    const text = `${ticket.title ?? ''} ${ticket.text ?? ''}`.toLowerCase()
    const scored = memories.map(memory => {
      let score = 0
      if (memory.scope && memory.scope === ticket.thread) score += 10
      if (!memory.scope || memory.scope === 'global') score += 3
      for (const tag of memory.tags ?? []) {
        if (tag && text.includes(String(tag).toLowerCase())) score += 4
      }
      score += Math.min(Number(memory.used ?? 0), 5) * 0.1
      return { memory, score }
    }).filter(row => row.score > 0)
    scored.sort((a, b) => b.score - a.score
      || String(b.memory.created_at ?? '').localeCompare(String(a.memory.created_at ?? '')))
    return scored.slice(0, limit).map(row => row.memory)
  }

  /** Renders selected long-term memories as prompt text. */
  function renderMemories(memories, ticket) {
    const picked = selectMemories(memories, ticket)
    if (picked.length === 0) return ''
    return [
      '## 长期记忆（跨任务沉淀的结论）',
      ...picked.map(m => `- [${m.scope ?? 'global'}] ${m.text}`),
      '（这些来自更早的任务，可能已经过时；与当前证据冲突时以当前证据为准。）',
      '',
    ].join('\n')
  }

  /**
   * Hands an accepted Ticket to an Executor — a child DSH session — and records the outcome
   * on the Ticket. The Ticket keeps its own state; only this report may end it.
   */
  async function dispatchTicket(ticket) {
    /**
     * Writes fields only if the stored Ticket is still live, all inside one lock.
     *
     * The failure path must not trust the in-memory `ticket`: a person can cancel while the
     * Executor runs, and the cancel handler writes `status: 'ended'` / `assignment.status:
     * 'cancelled'`. Re-reading and writing under the same lock is what keeps that decision
     * from being overwritten by a retry that was decided a moment earlier.
     *
     * Returns false when the Ticket has already been ended or its Assignment cancelled.
     */
    async function patchIfLive(fields) {
      return storeLock(async () => {
        const store = await readStore()
        const row = store.tickets.find(t => t.id === ticket.id)
        if (!row) return false
        if (row.status !== 'open') return false
        if (row.assignment?.status === 'cancelled') return false
        Object.assign(row, fields)
        await writeStore(store)
        return true
      })
    }
    try {
      const subagents = ctx.get('subagents')
      const agents = ctx.get('agents')
      if (!subagents || !agents) throw new Error('subagents or agents service unavailable')
      const parent = agents.currentInitiator()
      if (!parent) throw new Error('no initiator agent to own the Executor')
      const provider = subagents.list()[0]
      if (!provider) throw new Error('no subagent provider registered')

      // Read the stored Ticket instead of trusting the in-memory copy: a reply may have added
      // journal entries after this Ticket was queued, and a person may have cancelled it. The
      // Executor prompt and the dispatch decision must both be based on what the store says now.
      const queued = await storeLock(async () => {
        const store = await readStore()
        const row = store.tickets.find(t => t.id === ticket.id)
        if (!row) return null
        if (row.status !== 'open' || row.assignment?.status === 'cancelled') return null
        return { text: row.text, title: row.title, thread: row.thread, journal: row.journal ?? [] }
      })
      if (!queued) return

      // Two kinds of memory reach the Executor: lessons kept across Tickets, and this
      // Ticket's own journal. Neither lives in a Session, so a fresh Executor still has them.
      const longTerm = (await readMemories()).memories
      const prompt = [renderMemories(longTerm, queued), renderMemory(queued), queued.text]
        .filter(Boolean).join('\n')
      const activation = await subagents.startActivation({
        provider,
        label: ticket.title,
        request: { prompt: [{ type: 'text', text: prompt }], parent, cwd: process.cwd() },
        signal: new AbortController().signal,
        delivery: 'parent',
      })

      // The Executor may reject before Promise.race below attaches a handler: the store patch
      // in between is an await. Mark the rejection handled now so a fast failure cannot escape
      // as an unhandled rejection and kill the process.
      activation.result?.catch?.(() => {})

      const childId = String(activation.childId)
      live.set(ticket.id, { parent, childId })
      // The cancel path needs a child id to interrupt, so a cancel that lands while the provider
      // is still starting the Executor can only be observed here. Check and claim the Assignment
      // in one lock: if the Ticket was withdrawn in the meantime, leave its ended/cancelled
      // state alone and stop the child that the dispatch already started.
      const started = await storeLock(async () => {
        const store = await readStore()
        const row = store.tickets.find(t => t.id === ticket.id)
        if (!row) return false
        if (row.status !== 'open' || row.assignment?.status === 'cancelled') return false
        row.assignment = { executor: childId, status: 'running', started_at: new Date().toISOString() }
        await writeStore(store)
        return true
      })
      if (!started) {
        try { subagents.interrupt(childId, { kind: 'ancestor', agent: parent }) } catch {}
        return
      }

      // A stuck Executor would hold its concurrency slot forever. Time it out, interrupt the
      // child, and let the retry/failure path below decide what the Ticket becomes.
      let timer
      const result = await Promise.race([
        activation.result,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { subagents.interrupt(String(activation.childId), { kind: 'ancestor', agent: parent }) } catch {}
            reject(Object.assign(new Error(`executor timed out after ${executorTimeoutMs}ms`), { code: 'EXECUTOR_TIMEOUT' }))
          }, executorTimeoutMs)
        }),
      ]).finally(() => clearTimeout(timer))

      const output = (result.output ?? [])
        .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('\n')
        .slice(0, 8000)

      // A person may have cancelled this Ticket while the Executor ran: its state wins.
      // The Executor's report must not overwrite a withdrawn Mandate.
      await storeLock(async () => {
        const snapshot = await readStore()
        const current = snapshot.tickets.find(t => t.id === ticket.id)
        if (current?.assignment?.status !== 'running') return
        current.status = 'ended'
        current.assignment = { ...(current.assignment ?? {}), executor: String(activation.childId), status: 'ended', ended_at: new Date().toISOString() }
        current.report = { stop_reason: result.stopReason, output, diagnostic: result.diagnostic ?? null }
        // The journal is the memory the next Executor reads; keep it short and factual.
        current.journal ??= []
        current.journal.push({
          at: new Date().toISOString(),
          kind: 'report',
          stop_reason: result.stopReason,
          output: output.slice(0, 1000),
          executor: String(activation.childId),
        })
        if (current.journal.length > MAX_JOURNAL_ENTRIES) current.journal = current.journal.slice(-MAX_JOURNAL_ENTRIES)
        await writeStore(snapshot)
      })
    } catch (error) {
      const reason = String(error?.message ?? error)

      // The Executor can fail because a person interrupted it. Before deciding to retry, read
      // the stored Ticket under the lock: if it is already ended or cancelled, that decision
      // wins and this failure is just the interrupt landing. Nothing may be written here.
      const live = await storeLock(async () => {
        const snapshot = await readStore()
        const current = snapshot.tickets.find(t => t.id === ticket.id)
        return Boolean(current) && current.status === 'open' && current.assignment?.status !== 'cancelled'
      })
      if (!live) return

      const attempts = (ticket._attempts ?? 0) + 1
      // The retry writes the counter to the stored row; keep this in-memory copy in step or the
      // next attempt would restart the counter and retry forever.
      ticket._attempts = attempts
      if (attempts <= maxRetries) {
        // Keep the same Ticket and Mandate; only the Assignment is retried.
        const backoff = Math.min(30_000, 1_000 * 2 ** (attempts - 1))
        const retryAt = new Date(Date.now() + backoff).toISOString()
        // Check and write in one lock: a cancel can land between the read above and this
        // patch, and it must not be overwritten by a retry that was already decided.
        const scheduled = await patchIfLive({
          _attempts: attempts,
          assignment: { ...(ticket.assignment ?? {}), executor: null, status: 'pending', error: reason, retry_at: retryAt },
        }).catch(() => false)
        if (!scheduled) return
        const retry = setTimeout(() => {
          // Re-read before requeueing. A person may have cancelled the Ticket during the
          // backoff, or resumed it by hand: either decision outranks this pending retry.
          void storeLock(async () => {
            const snapshot = await readStore()
            const current = snapshot.tickets.find(t => t.id === ticket.id)
            if (!current || current.status !== 'open') return
            if (current.assignment?.status !== 'pending' || current.assignment?.retry_at !== retryAt) return
            current.assignment = { ...current.assignment, executor: null, retry_at: null }
            await writeStore(snapshot)
            enqueue(current)
          }).catch(() => {})
        }, backoff)
        retry.unref?.()
        return
      }
      // Terminal failure: the Ticket and its Assignment end together, so a list that filters
      // on either one sees the same thing.
      const failed = await patchIfLive({
        status: 'ended',
        assignment: { ...(ticket.assignment ?? {}), status: 'failed', error: reason, ended_at: new Date().toISOString() },
      }).catch(() => false)
      if (failed) ticket.status = 'ended'
    } finally {
      live.delete(ticket.id)
    }
  }

  /** Records a Trigger and, when the admission layer accepts it, creates one Ticket. */
  async function accept(args) {
    // Serialized: the idempotence check (trigger key) and the write that claims it must not
    // interleave, or two identical deliveries would both create a Ticket.
    return storeLock(() => acceptUnlocked(args))
  }

  async function acceptUnlocked({ text, sender, source = 'tool', thread = 'default', title }) {
    const listed = allowedSenders.has(sender)
    const addressed = true // a tool call is by definition addressed to the agent
    const cell = admissionCell({ listed, addressed })
    // An empty allowed list means the Policy has not been populated, so the tool boundary
    // itself is the authorization: a direct call is an explicit request. Once a list exists,
    // the matrix decides, and an unlisted sender is no longer explicit.
    const verdict = allowedSenders.size === 0
      ? 'explicit'
      : cell === undefined ? 'explicit' : admission[cell]

    const key = triggerKey(source, thread, sender, text)
    const store = await readStore()
    store.triggers ??= {}

    // Idempotence: one Trigger is accepted once, however many times it is delivered.
    // A rejection is recorded as a key with no Ticket id. Presence, not truthiness, is the
    // test — a `null` value is still a decision that this Trigger was already handled.
    if (Object.hasOwn(store.triggers, key)) {
      const ticketId = store.triggers[key]
      return {
        decision: 'duplicate',
        trigger: key,
        ticket: ticketId ? summarize(store.tickets.find(t => t.id === ticketId)) : null,
        previous: ticketId ? 'accepted' : 'rejected',
      }
    }
    store.triggers[key] = null

    if (verdict === 'ignore') {
      await writeStore(store)
      return { decision: 'ignore', trigger: key, reason: `admission:${cell ?? 'listed-addressed'}` }
    }
    if (verdict === 'inferred') {
      await writeStore(store)
      return { decision: 'pending-assessment', trigger: key, reason: `admission:${cell}` }
    }

    const id = `t-${key.slice(0, 12)}`
    const ticket = {
      id,
      status: 'open',
      title: title?.trim() || text.slice(0, 80),
      text,
      sender,
      source,
      thread,
      trigger: key,
      mandate: { policy_version: 'v1', scope: 'single-repository', strength: 'explicit' },
      assignment: null,
      report: null,
      // The Ticket's own memory: what earlier Executors did, read back on the next dispatch.
      journal: [],
      created_at: new Date().toISOString(),
    }
    store.tickets.push(ticket)
    store.triggers[key] = id
    await writeStore(store)

    if (autoDispatch) {
      ticket.assignment = { executor: null, status: 'pending', started_at: new Date().toISOString() }
      await writeStore(store)
      // The Ticket enters the team queue; the tool call returns without waiting for the Executor.
      enqueue(ticket)
    }

    return { decision: 'accept', trigger: key, ticket: summarize(ticket) }
  }

  ctx.tools.register({
    name: 'superagent_request',
    description: [
      'Submit a work request to the super-agent. Creates one Ticket per distinct request and returns its id.',
      'The Ticket is the unit of authorized work; it carries a Mandate recording why the work may be done.',
      'Repeating the identical request is idempotent and returns the existing Ticket.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'What is being asked for, in the requester\'s own words.' },
        sender: { type: 'string', minLength: 1, description: 'Who is asking. Must be in the configured allowed list to be accepted.' },
        source: { type: 'string', description: 'Where the request came from. Defaults to "tool".' },
        thread: { type: 'string', description: 'The conversation this belongs to. Triggers on one Thread are assessed in order.' },
        title: { type: 'string', description: 'Optional short label; defaults to the first 80 characters of the text.' },
      },
      required: ['text', 'sender'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => accept(args),
  })

  // Four tools, not eleven. Tool schemas are prompt cost on every turn, so verbs that
  // share one store collapse into an `action` enum instead of separate registrations.
  ctx.tools.register({
    name: 'superagent_ticket',
    description: [
      'Read or move Tickets. action=list (newest first; status/thread filters), show (one Ticket in full),',
      'journal (its journal: what earlier Executors did, what people added, whether it was cancelled —',
      'the record a fresh Executor receives as its memory), reply (add a message; an ended Ticket reopens',
      'under the same Mandate and is dispatched again), cancel (stop it; the only way to withdraw a Mandate —',
      'a Policy change is delivered, it does not revoke work), team (the board: Threads, askers, running Executors).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'journal', 'reply', 'cancel', 'team'], description: 'What to do. The fields below apply per action.' },
        ticket_id: { type: 'string', minLength: 1, description: 'show, journal, reply, cancel.' },
        text: { type: 'string', minLength: 1, description: 'reply: the message to add. Written into the journal, not into a Session.' },
        reason: { type: 'string', description: 'cancel: why the work stopped, at most 500 characters.' },
        status: { type: 'string', enum: ['open', 'ended'], description: 'list: optional status filter.' },
        thread: { type: 'string', description: 'list, team: limit to one Thread.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'list, journal: how many rows.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args = {}) => {
      switch (args.action) {
        case 'list': {
          const store = await readStore()
          const rows = store.tickets
            .filter(t => !args.status || t.status === args.status)
            .filter(t => !args.thread || t.thread === args.thread)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, args.limit ?? 20)
          return { total: store.tickets.length, tickets: rows.map(summarize) }
        }

        case 'show': {
          const store = await readStore()
          const ticket = store.tickets.find(t => t.id === args.ticket_id)
          if (!ticket) return { error: 'not_found', ticket_id: args.ticket_id }
          return ticket
        }

        case 'journal': {
          const store = await readStore()
          const ticket = store.tickets.find(t => t.id === args.ticket_id)
          if (!ticket) return { error: 'not_found', ticket_id: args.ticket_id }
          const all = ticket.journal ?? []
          return {
            ticket_id: ticket.id,
            status: ticket.status,
            entries: all.length,
            journal: all.slice(-(args.limit ?? 20)),
            prompt_preview: renderMemory(ticket),
          }
        }

        case 'reply': {
          return storeLock(async () => {
            const store = await readStore()
            const ticket = store.tickets.find(t => t.id === args.ticket_id)
            if (!ticket) return { error: 'not_found', ticket_id: args.ticket_id }

            ticket.journal ??= []
            ticket.journal.push({ at: new Date().toISOString(), kind: 'reply', text: args.text })
            if (ticket.journal.length > MAX_JOURNAL_ENTRIES) ticket.journal = ticket.journal.slice(-MAX_JOURNAL_ENTRIES)

            const running = ticket.assignment?.status === 'running'
            if (running) {
              // A live Executor keeps its own turn; the message joins the record for the next dispatch.
              await writeStore(store)
              return { ticket_id: ticket.id, outcome: 'recorded', note: 'a live Executor is running; this applies on its next dispatch' }
            }

            // Reopen under the same Mandate: a person's message resumes the Ticket, it does not
            // create a new authorization. Only a person's stop withdraws a Mandate.
            ticket.status = 'open'
            ticket.assignment = { executor: null, status: 'pending', started_at: new Date().toISOString() }
            await writeStore(store)
            enqueue(ticket)
            return { ticket_id: ticket.id, outcome: 'redispatched', journal_entries: ticket.journal.length }
          })
        }

        case 'cancel': {
          return storeLock(async () => {
            const store = await readStore()
            const ticket = store.tickets.find(t => t.id === args.ticket_id)
            if (!ticket) return { error: 'not_found', ticket_id: args.ticket_id }

            // Nothing is left to withdraw: the Ticket already ended with a terminal Assignment.
            // Cancelling it now would replace the Executor's report (the record of work that
            // actually happened) with a cancel marker, so leave the finished Ticket untouched.
            const alreadyEnded = ticket.status === 'ended'
              && (!ticket.assignment || ['ended', 'failed', 'cancelled'].includes(ticket.assignment.status))
            if (alreadyEnded) {
              return { ticket_id: ticket.id, status: 'ended', was_queued: false, interrupted: false, already_ended: true }
            }

            // Drop it from the queue first: a queued Ticket has no Executor to interrupt.
            // Match by id, not identity: the store object and the queued object are different
            // copies, so indexOf(ticket) would never find a queued row.
            const queued = pending.findIndex(t => t.id === ticket.id)
            const wasQueued = queued >= 0
            if (wasQueued) {
              pending.splice(queued, 1)
              inFlight.delete(ticket.id)
            }

            const entry = live.get(ticket.id)
            let interrupted = false
            if (entry) {
              const subagents = ctx.get('subagents')
              if (subagents) {
                try {
                  subagents.interrupt(entry.childId, { kind: 'ancestor', agent: entry.parent })
                  interrupted = true
                } catch (error) {
                  ticket.cancel_error = String(error?.message ?? error)
                }
              }
            }

            ticket.status = 'ended'
            ticket.assignment = { ...(ticket.assignment ?? {}), status: 'cancelled', ended_at: new Date().toISOString() }
            ticket.report = { stop_reason: 'cancelled', output: '', reason: args.reason ?? null, interrupted }
            await writeStore(store)
            return { ticket_id: ticket.id, status: 'ended', was_queued: wasQueued, interrupted }
          })
        }

        case 'team': {
          const store = await readStore()
          const rows = store.tickets.filter(t => !args.thread || t.thread === args.thread)
          const byThread = new Map()
          for (const ticket of rows) {
            const list = byThread.get(ticket.thread) ?? []
            list.push({
              ticket_id: ticket.id,
              title: ticket.title,
              sender: ticket.sender,
              status: ticket.status,
              assignment: ticket.assignment?.status ?? 'none',
              executor: ticket.assignment?.executor ?? null,
            })
            byThread.set(ticket.thread, list)
          }
          return {
            concurrency: { running: runningCount, queued: pending.length, limit: maxConcurrent },
            threads: [...byThread.entries()].map(([thread, tickets]) => ({
              thread,
              open: tickets.filter(t => t.status === 'open').length,
              tickets,
            })),
          }
        }

        default:
          return { error: 'bad_action', action: args.action ?? null, allowed: ['list', 'show', 'journal', 'reply', 'cancel', 'team'] }
      }
    },
  })

  ctx.tools.register({
    name: 'superagent_memory',
    description: [
      'Long-term memory that outlives any Ticket and reaches later Executors. action=remember (keep one',
      'durable lesson — a convention, a preference, a pitfall already hit; same text updates the same entry),',
      'recall (scope plus tag/text overlap, newest first, no embeddings; an empty answer is a real answer —',
      'this store only holds what someone chose to write down), forget (delete by id; a stale memory nobody',
      'deletes is worse than no memory).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remember', 'recall', 'forget'], description: 'What to do. The fields below apply per action.' },
        text: { type: 'string', minLength: 1, description: 'remember: one self-contained sentence or short paragraph.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'remember: words that should make this relevant again.' },
        scope: { type: 'string', description: 'remember, recall: a Thread name, or omit for global.' },
        query: { type: 'string', description: 'recall: words to match against memory text and tags.' },
        id: { type: 'string', minLength: 1, description: 'forget: memory id.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'recall: how many to return.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args = {}) => {
      switch (args.action) {
        case 'remember': {
          return memoryLock(async () => {
            const state = await readMemories()
            const id = `m-${createHash('sha256').update(args.text).digest('hex').slice(0, 10)}`
            // Same text means the same lesson: update it instead of keeping two copies.
            const existing = state.memories.findIndex(m => m.id === id)
            const record = {
              id,
              text: args.text,
              tags: args.tags ?? [],
              scope: args.scope ?? 'global',
              created_at: new Date().toISOString(),
              used: existing >= 0 ? state.memories[existing].used ?? 0 : 0,
            }
            if (existing >= 0) state.memories[existing] = record
            else state.memories.push(record)
            await writeMemories(state)
            return { id, updated: existing >= 0, total: state.memories.length }
          })
        }

        case 'recall': {
          const state = await readMemories()
          const needle = String(args.query ?? '').toLowerCase()
          const rows = state.memories.filter(memory => {
            if (args.scope && memory.scope !== args.scope) return false
            if (!needle) return true
            const haystack = `${memory.text} ${(memory.tags ?? []).join(' ')}`.toLowerCase()
            return haystack.includes(needle)
          }).sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
          return { total: state.memories.length, matched: rows.length, memories: rows.slice(0, args.limit ?? 20) }
        }

        case 'forget': {
          return memoryLock(async () => {
            const state = await readMemories()
            const before = state.memories.length
            state.memories = state.memories.filter(m => m.id !== args.id)
            if (state.memories.length === before) return { error: 'not_found', id: args.id }
            await writeMemories(state)
            return { id: args.id, deleted: true, remaining: state.memories.length }
          })
        }

        default:
          return { error: 'bad_action', action: args.action ?? null, allowed: ['remember', 'recall', 'forget'] }
      }
    },
  })

  ctx.tools.register({
    name: 'superagent_health',
    description: 'Snapshot of the super-agent loop and store: concurrency, open Tickets, store size, config. Check this to confirm the loop is still alive.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => {
      const store = await readStore()
      const memories = await readMemories()
      const byStatus = {}
      for (const ticket of store.tickets) byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1
      return {
        uptime_ms: Date.now() - startedAt,
        concurrency: { running: runningCount, queued: pending.length, limit: maxConcurrent, live: live.size },
        store: {
          dir: STORE_DIR,
          tickets: store.tickets.length,
          by_status: byStatus,
          triggers: Object.keys(store.triggers ?? {}).length,
          memories: memories.memories.length,
        },
        open: store.tickets.filter(t => t.status === 'open').map(summarize),
        config: { autoDispatch, executorTimeoutMs, maxRetries, maxConcurrent },
      }
    },
  })

  /**
   * Startup recovery: the queue and the `live` map are in-memory, so a restart loses them.
   * Without this, a `pending` Ticket would never run again and a `running` one would look
   * alive forever. Both are reconciled here before anyone asks for a list.
   */
  async function recoverOnStartup() {
    const summary = await storeLock(async () => {
      const store = await readStore()
      const now = new Date().toISOString()
      let requeued = 0
      let orphaned = 0
      for (const ticket of store.tickets) {
        if (ticket.status !== 'open') continue
        const state = ticket.assignment?.status
        if (state === 'running') {
          // The Executor died with the previous process; no one will ever report on it.
          ticket.journal ??= []
          ticket.journal.push({ at: now, kind: 'report', stop_reason: 'interrupted', output: '进程重启，执行器中断，已重新入队。' })
          if (ticket.journal.length > MAX_JOURNAL_ENTRIES) ticket.journal = ticket.journal.slice(-MAX_JOURNAL_ENTRIES)
          orphaned++
        }
        if (!state || state === 'pending' || state === 'running' || state === 'interrupted') {
          ticket.assignment = { ...(ticket.assignment ?? {}), executor: null, status: 'pending', started_at: now }
          queueTicket(ticket)
          requeued++
        }
      }
      const keys = Object.keys(store.triggers ?? {})
      if (keys.length > MAX_TRIGGERS) {
        store.triggers = Object.fromEntries(keys.slice(-MAX_TRIGGERS).map(key => [key, store.triggers[key]]))
      }
      await writeStore(store)
      return { requeued, orphaned }
    })
    if (summary.requeued > 0 || summary.orphaned > 0) {
      ctx.logger?.info?.('dsh-superagent-mini: recovered %d queued / %d interrupted Tickets', summary.requeued, summary.orphaned)
    }
    if (startupDelayMs === 0) {
      pump()
    } else {
      const kick = setTimeout(pump, startupDelayMs)
      kick.unref?.()
    }
  }

  if (autoDispatch) {
    void recoverOnStartup().catch((error) => {
      ctx.logger?.warn?.('dsh-superagent-mini: startup recovery failed: %s', String(error?.message ?? error))
    })
  }

  ctx.logger?.info?.('dsh-superagent-mini: 11 tools registered; store at %s (maxConcurrent=%d)', STORE_FILE, maxConcurrent)
}
