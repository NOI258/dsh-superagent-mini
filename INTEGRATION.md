# 集成说明（给 DSH agent 读）

人看的介绍在 [`README.md`](./README.md)。这份只讲**怎么挂进来、挂上之后怎么用、哪些坑会坑到你**。

---

## 0. 它是什么

一个 Cordis 插件。挂进 DSH 后提供 **4 个 `superagent_*` 工具**，做的是：丢一个请求进来，它开一张票，派一个子会话去干，干完回来说一声。

和 DSH 自带的 `subagent` 的关键差别：**`subagent` 是一次性的，回来就结束；这个能对同一件事接着聊**（`superagent_ticket { action: "reply" }` 追加要求，下次 dispatch 带上）。

`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`，DSH 靠它把插件插进 composition。

---

## 1. 挂载

```bash
dsh plugin --profile web add github:NOI258/dsh-superagent-mini
```

没有发布 npm，`npm i` 装不到。`cordis.patch.yml` 内容是往 composition 插一个 id 为 `dsh-superagent-mini` 的条目，不需要手改。

### 验证（三步，一步都不能跳）

**第一步：包被识别。** 用 `plugin_manager` 的 `list_plugins`，应出现条目 `dsh-superagent-mini`，且：
- `enabled: true`
- `fiberPhase: "active"`

`fiberPhase` 不是 `active` 就是没真正挂上，别往下走。

**第二步：工具注册了。** 调 `superagent_health`，返回里应有：
- `store.dir` —— 实际用的 store 目录，**记下来**，后面排查全靠它
- `config` —— `autoDispatch` / `maxConcurrent` / `executorTimeoutMs` / `maxRetries`
- `concurrency` —— `running` / `queued` / `limit`

**第三步：跑一张真的票。**

```
superagent_request { text: "只回复 ok，不要做其他事", sender: "<你的身份>" }
→ 记下 ticket_id
superagent_ticket { action: "show", ticket_id }
→ 状态应从 open 走到 ended
```

**三步都过才算装好。** 包在列表里 ≠ 工具注册成功 ≠ 能真的执行，这是三个不同的成功条件，别拿前一个当后一个的证据。

---

## 2. 四个工具怎么用

| 工具 | 用途 |
|---|---|
| `superagent_request` | 开票：提交一件被授权的工作 |
| `superagent_ticket` | `action` = `list` / `show` / `journal` / `reply` / `cancel` / `team` |
| `superagent_memory` | `action` = `remember` / `recall` / `forget`（长期记忆，活得比票久） |
| `superagent_health` | 循环与存储快照 |

工具 schema 每轮都进 prompt，所以同存储的动词合进一个 `action` 枚举，不拆成独立工具。11 个工具的 `description + parameters` 共 5974 字节，合并后 4347 字节。

### 最容易搞错的一件事

**`superagent_request` 不返回执行结果。** 它只负责开票和派活，立刻返回 `ticket_id` 和 `decision`（`accept` / `duplicate` / 等）。

要看结果得用 `superagent_ticket { action: "show" }`，要改要求用 `{ action: "reply" }`。**别指望一次调用拿到产出。**

### 状态机

- `open` —— 还活着，可能 queued、running 或等重试
- `ended` —— 正常结束，`assignment.report` 里有产出
- `failed` —— 失败，重试预算耗尽

**票和执行器是两回事。** 执行器崩了票还在；重试是票的事，不是会话的事。所以 `superagent_ticket { action: "show" }` 看到 `open` 不等于它还活着。

---

## 3. 数据在哪

```
$DSH_SUPERAGENT_MINI_DIR          显式指定优先
$DSH_PROFILE_DIR/superagent-mini  否则跟着 profile
~/.dsh/superagent-mini            兜底
```

```
tickets.json   票 + journal
memory.json    长期记忆
```

**分开是有意的，清理时也别一起删。** `tickets.json` 随任务结束就没用了；`memory.json` 里的教训要活过每一张产生它的票，删了就没了。

清之前先 `superagent_ticket { action: "list", status: "open" }` 确认没有活着的票。

---

## 4. 限制（会改变你的方案，不是"可能有问题"）

**吞吐约 11 条/秒，和执行器快慢无关。** 每条 Ticket 端到端 70–90 ms，因为每次状态变更都重写整份 `tickets.json`。实测：400 条要 27 秒；160 条只跑 20 ms 的任务、并发 8，也要 5.4 秒。

→ **一次灌几百条会明显排队。** 分批，每批几十条，用 `superagent_ticket { action: "team" }` 看板子。

**并发上限默认 2**（`maxConcurrent`）。改的是插件 config，不是运行时参数。峰值并发确实能到配置值，闸门没坏。

**锁只在进程内。** 两个进程指向同一个 store 目录会互相覆盖。别同时开两个 DSH 实例共用一个 `DSH_SUPERAGENT_MINI_DIR`。

**`STORE_FILE` 是模块级常量。** `import` 时读一次环境变量，之后换 `DSH_SUPERAGENT_MINI_DIR` 不生效。**写测试时每个 store 必须一个子进程**——同一进程里 boot 两次，第二次仍写进第一个目录。

**超时后会重试一次**（`maxRetries` 默认 1）。所以 80 个永不完成的执行器会产生 160 次启动记录，这是预期行为，不是"双执行器"bug。

**journal 上限 200 条，trigger 上限 5000 个。** 超了 FIFO 修剪；trigger 修剪不区分状态，可能剪掉仍 open 的票。

---

## 5. 常见误用

| 别这样 | 为什么 | 应该这样 |
|---|---|---|
| 等 `superagent_request` 的返回值当执行结果 | 它只开票派活 | `superagent_ticket { action: "show" }` 查状态 |
| 一次提交几百条 | 27 秒起步，且拿不到进度 | 分批 + `superagent_ticket { action: "team" }` |
| 对已 `ended` 的票再 `action: "cancel"` | 会抹掉完成报告，原输出永久丢失 | 先 `action: "show"` 看状态 |
| 想改一张票的范围 | Mandate 不可变 | 开新票 |
| 在测试里同进程起两个实例 | `STORE_FILE` 是模块级常量 | 每场景一个子进程 |
| 把 ticket 当 session 用 | 票不镜像执行器会话状态 | 票管业务状态，会话管执行 |

---

## 6. 验证与排障

```bash
cd /root/workspace/dsh-superagent-mini

node test/smoke.mjs          # 11 项：注册、恢复、幂等、并发写
node test/resilience.mjs     # 17 项：超时、重试、上限
node test/consistency.mjs    # 19 项：Trigger 幂等、取消打断重试
node test/regressions.mjs    # 24 项：每次修 bug 加的防回归
node test/stress.mjs         # 7 个负载场景，约 3 分钟
```

排障顺序：

1. `superagent_health` —— **先确认它在读你以为的那个 store**
2. `superagent_ticket { action: "list", status: "open" }` —— 有没有卡住的票
3. `node test/smoke.mjs` —— 能过说明插件本身没坏，问题在挂载或环境
4. 全量回归 —— 四个功能测试 + 压测

**别靠猜。** 先跑测试区分"代码坏了"和"环境没配对"，再看具体逻辑。

压测有个额外注意：每个场景必须单独子进程（见上面 `STORE_FILE` 那条）。清理临时 store 前要等一下，否则 `rm` 会和异步写盘的 `rename` 抢。

---

## 7. 别做的事

- 别 `npm i` 它（没发布 npm）
- 别手改 `cordis.patch.yml` 的 id（会和 composition 里的条目对不上）
- 别在没跑测试的情况下说"修好了"——改完先跑四个功能测试，再对每个修复做反向验证（把修复还原，确认对应断言会 FAIL）
- 别把它当生产级队列用：配置不校验（`maxConcurrent` 传非数字会变 `NaN`，队列永不出队）、跨进程不互斥
