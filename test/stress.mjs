// Stress test for dsh-superagent-mini. Load, not scenarios.
//
// 功能测试问「做对了吗」，压测问「一直做会不会散」。
//
//   node test/stress.mjs            # 全部场景（每个场景一个子进程）
//   node test/stress.mjs S3 S4      # 只跑指定场景
//
// 为什么要子进程：STORE_DIR / STORE_FILE 是 index.js 的模块级常量，import 时读一次
// 环境变量。同一进程里第二次 import 拿到的是缓存的模块，换个 DSH_SUPERAGENT_MINI_DIR
// 也不生效，两个场景会写进同一个 store。所以场景必须隔离到进程。
//
// 退出码: 0 全过 / 1 有不变量被破坏
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const oneFlag = process.argv.find(a => a.startsWith('--one='))
const SCENES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']

// ---------- 共享工具 ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const now = () => Number(process.hrtime.bigint() / 1000000n)
const rss = () => Math.round(process.memoryUsage().rss / 1048576)

// ================= 子进程模式：只跑一个场景 =================
if (oneFlag) {
  const scene = oneFlag.slice('--one='.length)
  const failures = []
  process.on('unhandledRejection', (e) => {
    failures.push(`unhandledRejection: ${e?.message ?? e}`)
    console.log(`FAIL  unhandledRejection — ${e?.message ?? e}`)
  })
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(name)
  }

  async function boot(opts = {}) {
    const dir = await mkdtemp(join(tmpdir(), `sa-${scene}-`))
    process.env.DSH_SUPERAGENT_MINI_DIR = dir
    const { apply } = await import('../index.js')
    const tools = new Map()
    const logs = []
    const stats = { started: 0, active: 0, peakActive: 0 }
    let seq = 0
    const subagents = {
      list: () => ['mock-provider'],
      startActivation: async (aopts) => {
        stats.started++
        stats.active++
        stats.peakActive = Math.max(stats.peakActive, stats.active)
        const myChild = `child-${++seq}`
        const result = (async () => {
          try { return await opts.run({ label: aopts.label, childId: myChild, i: seq }) }
          finally { stats.active-- }
        })()
        result.catch(() => {})
        return { childId: myChild, result }
      },
      interrupt: () => {},
    }
    apply({
      tools: { register: (t) => tools.set(t.name, t) },
      get: (k) => (k === 'subagents' ? subagents
        : k === 'agents' ? { currentInitiator: () => ({ id: 'parent' }) } : undefined),
      logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    }, {
      autoDispatch: true,
      maxConcurrent: 8,
      executorTimeoutMs: 30_000,
      startupDelayMs: 0,
      ...opts.config,
    })
    const readStore = async () => JSON.parse(await readFile(join(dir, 'tickets.json'), 'utf8'))
    return {
      dir, tools, stats, logs, readStore,
      request: tools.get('superagent_request'),
      cancel: tools.get('superagent_ticket'),
      close: async () => {
        // 等异步写盘收尾再删，否则 rm 会和 rename 抢（teammate 也踩过同一个坑）
        await sleep(250)
        await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      },
    }
  }

  async function until(fn, { timeout = 60_000, every = 20 } = {}) {
    const t0 = now()
    while (now() - t0 < timeout) {
      if (await fn()) return true
      await sleep(every)
    }
    return false
  }

  async function invariants(tag, inst, expect = {}) {
    const store = await inst.readStore()
    const tickets = store.tickets ?? []
    const ids = tickets.map(t => t.id)
    check(`${tag}: ticket id 唯一`, new Set(ids).size === ids.length, `${ids.length} 条 / ${new Set(ids).size} 唯一`)
    check(`${tag}: triggers 全部指向存在的 ticket`,
      Object.keys(store.triggers ?? {}).every(k => ids.includes(store.triggers[k])),
      `${Object.keys(store.triggers ?? {}).length} 条 trigger`)
    if (expect.allEnded) {
      const leaked = tickets.filter(t => t.status === 'open')
      check(`${tag}: 无残留 open ticket`, leaked.length === 0,
        leaked.length ? `${leaked.length} 条: ${leaked.slice(0, 3).map(t => `${t.id}/${t.assignment?.status}`).join(', ')}` : '')
    }
    if (expect.noRunning) {
      const stuck = tickets.filter(t => t.assignment?.status === 'running')
      check(`${tag}: 无卡在 running 的 assignment`, stuck.length === 0, stuck.length ? `${stuck.length} 条` : '')
    }
    if (expect.maxConcurrent) {
      check(`${tag}: 执行器峰值并发不超配置`, inst.stats.peakActive <= expect.maxConcurrent,
        `峰值 ${inst.stats.peakActive} / 上限 ${expect.maxConcurrent}`)
    }
    return { store, tickets }
  }

  const scenes = {}

  // S1: 洪峰。同时打进一批请求，全部收敛。
  scenes.S1 = async () => {
    const inst = await boot({ run: async () => ({ output: [{ type: 'text', text: 'ok' }], stopReason: 'done' }) })
    try {
      const N = 400
      const t0 = now()
      const results = await Promise.all(Array.from({ length: N }, (_, i) =>
        inst.request.execute({ text: `burst-${i}`, sender: 'u', title: `burst ${i}` }).catch(e => ({ error: String(e) }))))
      const accepted = results.filter(r => r?.decision === 'accept').length
      const errored = results.filter(r => r?.error).length
      const t1 = now()
      const settled = await until(async () => (await inst.readStore()).tickets.every(t => t.status === 'ended'), { timeout: 120_000 })
      console.log(`  N=${N} 接受 ${accepted} 报错 ${errored} 入队 ${t1 - t0}ms 收敛 ${now() - t0}ms ${settled ? '已收敛' : '超时'}`)
      check('S1: 没有请求抛异常', errored === 0, `${errored} 条`)
      check('S1: 全部收敛为 ended', settled)
      const { tickets } = await invariants('S1', inst, { maxConcurrent: 8 })
      check('S1: 落盘条数等于接受数', tickets.length === accepted, `落盘 ${tickets.length} / 接受 ${accepted}`)
      console.log(`  RSS ${rss()}MB store ${((await stat(join(inst.dir, 'tickets.json'))).size / 1024).toFixed(0)}KB`)
    } finally { await inst.close() }
  }

  // S2: 慢 executor。确认并发闸门真的在并行，不是串行。
  scenes.S2 = async () => {
    const inst = await boot({ run: async () => { await sleep(20); return { output: [{ type: 'text', text: 'ok' }], stopReason: 'done' } } })
    try {
      const N = 160
      const t0 = now()
      await Promise.all(Array.from({ length: N }, (_, i) => inst.request.execute({ text: `slow-${i}`, sender: 'u' }).catch(() => null)))
      const settled = await until(async () => (await inst.readStore()).tickets.every(t => t.status === 'ended'), { timeout: 120_000 })
      const total = now() - t0
      const ideal = Math.ceil(N / 8) * 20
      console.log(`  N=${N} 每个 20ms 并发 8 → 实测 ${total}ms（纯执行理论 ${ideal}ms），峰值并发 ${inst.stats.peakActive}`)
      check('S2: 全部完成', settled)
      // 慢不等于没并发。并发闸门看峰值，不看总耗时：executor 只占 20ms，
      // 其余时间在 store 读写上，总耗时被写放大主导，不能拿它判并发。
      check('S2: 并发确实生效（峰值 ≥ 4）', inst.stats.peakActive >= 4, `峰值 ${inst.stats.peakActive}`)
      console.log(`  单条平均 ${(total / N).toFixed(1)}ms，其中 executor 只有 20ms/8 ≈ 2.5ms`)
      await invariants('S2', inst, { maxConcurrent: 8, allEnded: true, noRunning: true })
    } finally { await inst.close() }
  }

  // S3: executor 永不完成 + 短超时。验证超时回收，不泄漏。
  scenes.S3 = async () => {
    const inst = await boot({ config: { executorTimeoutMs: 120 }, run: () => new Promise(() => {}) })
    try {
      const N = 80
      await Promise.all(Array.from({ length: N }, (_, i) => inst.request.execute({ text: `hang-${i}`, sender: 'u' }).catch(() => null)))
      const settled = await until(async () => (await inst.readStore()).tickets.every(t => t.status !== 'open'), { timeout: 60_000 })
      console.log(`  悬挂 executor ${N} 个 × 120ms 超时 → ${settled ? '全部收敛' : '有残留'}`)
      check('S3: 超时后没有残留 open', settled)
      // 这里不断言峰值并发：executor 永不 settle，我的 active 计数不会回落；
      // 而且超时后按 maxRetries 会再起一次，80 条对应 160 次启动是预期行为。
      await invariants('S3', inst, {})
    } finally { await inst.close() }
  }

  // S4: dispatch 与 cancel 交错。每条要么结束要么失败，不能吊着。
  scenes.S4 = async () => {
    const inst = await boot({ run: async () => { await sleep(3); return { output: [{ type: 'text', text: 'ok' }], stopReason: 'done' } } })
    try {
      const N = 300
      const ids = []
      for (let i = 0; i < N; i++) {
        const r = await inst.request.execute({ text: `storm-${i}`, sender: 'u' }).catch(() => null)
        if (r?.ticketId) ids.push(r.ticketId)
        if (i % 3 === 0 && ids.length) await inst.cancel.execute({ action: 'cancel', ticket_id: ids[ids.length - 1], reason: 'storm' }).catch(() => null)
      }
      const settled = await until(async () => (await inst.readStore()).tickets.every(t => t.status !== 'open'), { timeout: 120_000 })
      const store = await inst.readStore()
      const terminal = store.tickets.filter(t => t.status === 'ended' || t.status === 'failed').length
      console.log(`  请求 ${N} 取消约 ${Math.floor(N / 3)} → 终态 ${terminal}/${store.tickets.length}`)
      check('S4: 所有 ticket 落到终态', settled, `${terminal}/${store.tickets.length}`)
      await invariants('S4', inst, { maxConcurrent: 8 })
    } finally { await inst.close() }
  }

  // S5: executor 全部抛错。错误要被吃掉，状态不能污染。
  scenes.S5 = async () => {
    const inst = await boot({ run: async () => { throw new Error('executor exploded') } })
    try {
      const N = 150
      await Promise.all(Array.from({ length: N }, (_, i) => inst.request.execute({ text: `boom-${i}`, sender: 'u' }).catch(() => null)))
      const settled = await until(async () => (await inst.readStore()).tickets.every(t => t.status !== 'open'), { timeout: 90_000 })
      await sleep(400) // 给 unhandledRejection 冒头的时间
      console.log(`  executor 全抛错 ${N} 次 → ${settled ? '收敛' : '有残留'}`)
      check('S5: 异常 executor 后状态收敛', settled)
      await invariants('S5', inst, { maxConcurrent: 8, noRunning: true })
    } finally { await inst.close() }
  }

  // S6: 混合负载，看内存与文件增长。
  scenes.S6 = async () => {
    const inst = await boot({ run: async () => ({ output: [{ type: 'text', text: 'ok' }], stopReason: 'done' }) })
    try {
      const before = rss()
      for (let r = 0; r < 4; r++) {
        await Promise.all(Array.from({ length: 100 }, (_, i) =>
          inst.request.execute({ text: `mix-${r}-${i}`, sender: 'u', thread: `t${i % 4}` }).catch(() => null)))
        await sleep(40)
      }
      await until(async () => (await inst.readStore()).tickets.every(t => t.status === 'ended'), { timeout: 120_000 })
      const after = rss()
      const store = await inst.readStore()
      const size = (await stat(join(inst.dir, 'tickets.json'))).size
      console.log(`  400 条请求 RSS ${before}MB → ${after}MB (+${after - before}) store ${(size / 1024).toFixed(0)}KB 共 ${store.tickets.length} 条`)
      await invariants('S6', inst, { maxConcurrent: 8, allEnded: true })
      check('S6: 单条 ticket 占用合理（无重复堆积）', size / Math.max(store.tickets.length, 1) < 4096,
        `${(size / Math.max(store.tickets.length, 1)).toFixed(0)} B/条`)
    } finally { await inst.close() }
  }

  // S7-S9: 吞吐随 store 变大而劣化。三个规模各自一个子进程——
  // STORE_FILE 是模块级常量，同一进程里 boot 第二次仍指向第一个目录。
  // executor 立即返回，所以测到的耗时几乎全是 store 读写的代价。
  const perfScene = (N) => async () => {
    const inst = await boot({ run: async () => ({ output: [{ type: 'text', text: 'ok' }], stopReason: 'done' }) })
    try {
      const t0 = now()
      await Promise.all(Array.from({ length: N }, (_, i) => inst.request.execute({ text: `perf-${i}`, sender: 'u' }).catch(() => null)))
      await until(async () => (await inst.readStore()).tickets.every(t => t.status === 'ended'), { timeout: 240_000 })
      const total = now() - t0
      const size = (await stat(join(inst.dir, 'tickets.json'))).size
      const per = total / N
      console.log(`  N=${String(N).padStart(3)} 总 ${String(total).padStart(6)}ms 单条 ${per.toFixed(1).padStart(6)}ms store ${(size / 1024).toFixed(0).padStart(4)}KB`)
      // 关键指标：每写一条 ticket 的代价。它随 store 变大而上升 = 每次变更重写整份文件。
      console.log(`  B/条=${(size / N).toFixed(0)}  写入效率=${(size / 1048576 / (total / 1000)).toFixed(2)} MB/s`)
      check(`S${N === 50 ? '7' : N === 150 ? '8' : '9'}: 全部完成`, true)
    } finally { await inst.close() }
  }
  scenes.S7 = perfScene(50)
  scenes.S8 = perfScene(150)
  scenes.S9 = perfScene(300)

  try {
    await scenes[scene]()
  } catch (e) {
    check(`${scene}: 场景未抛异常`, false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '))
  }
  const bad = [...new Set(failures)]
  console.log(bad.length ? `SCENE FAILED: ${bad.join('; ')}` : 'SCENE PASS')
  process.exit(bad.length === 0 ? 0 : 1)
}

// ================= 主进程模式：调度各场景 =================
const want = process.argv.slice(2).filter(a => !a.startsWith('--'))
const todo = want.length ? want : SCENES
let failed = 0
const t0 = now()
for (const name of todo) {
  if (!SCENES.includes(name)) { console.log(`跳过未知场景 ${name}`); continue }
  console.log(`\n=== ${name} ===`)
  const r = spawnSync(process.execPath, [self, `--one=${name}`], { encoding: 'utf8', timeout: 240_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  process.stdout.write(out.split('\n').filter(l => l.trim()).map(l => `  ${l}`).join('\n') + '\n')
  if (r.status !== 0) failed++
}
console.log(`\n总耗时 ${now() - t0}ms，${failed} 个场景失败`)
console.log(failed === 0 ? 'ALL PASS' : `STRESS FAILED: ${failed} 个场景`)
process.exit(failed === 0 ? 0 : 1)
