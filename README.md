# dsh-superagent-mini

给 DSH 用的一套极简 super-agent 循环：**提交一个请求 → 变成 ticket → 派子会话去执行**。

不是一个 agent，是一个让 agent 排队干活的骨架。

领域模型抄的是 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）：

```
Source → Trigger → Thread → Eval → Ticket → Assignment → Executor
```

---

## 三阶段

1. **工具当 Source**。收到请求，过准入矩阵，Trigger 去重，落一张 Ticket
2. **接受的 Ticket 交给 Executor** —— 一个子 DSH 会话
3. **同 Thread 的后续消息**分发到还活着的 Ticket

## 十一个工具

| 工具 | 干什么 |
|---|---|
| `superagent_request` | 提交请求，建 ticket |
| `superagent_list` | 列 ticket |
| `superagent_show` | 看单张，含 journal |
| `superagent_cancel` | 取消，ticket 结束 |
| `superagent_team` | 看板：每个 Thread 下有哪些开着的票 |
| `superagent_reply` | 往已有 ticket 追加消息 |
| `superagent_memory` | 读某个 ticket 的 journal |
| `superagent_remember` | 写一条长期记忆 |
| `superagent_recall` | 按关键词搜记忆 |
| `superagent_forget` | 删一条记忆 |
| `superagent_health` | 看循环状态：并发、积压、存储大小 |

## 数据存哪

```
$DSH_SUPERAGENT_MINI_DIR          # 显式指定优先
$DSH_PROFILE_DIR/superagent-mini  # 否则跟着 profile
~/.dsh/superagent-mini            # 最后兜底
```

两个文件：

- `tickets.json` — ticket 和它们的 journal
- `memory.json` — 长期记忆

**故意分开的。** ticket 的 journal 随任务结束而死，值得留下的教训要活过每一张产生它的 ticket。

## 装

```bash
dsh plugin --profile web add github:NOI258/dsh-superagent-mini
```

装完重启 DSH，十一个 `superagent_*` 工具出现在模型可用的列表里。

## 四个设计上的取舍

**Trigger 不可变且幂等。** 同一个请求提两次，只产生一张 ticket。

**Ticket 定义自己的状态。** 它不镜像 executor session 的状态——执行器崩了不代表票没了。

**Mandate 不可变。** 想扩大范围就开新票，不能在旧的上面改。

**准入是个矩阵，不是布尔值。**

```
listedUnaddressed:  'inferred'   名单内、没点名 → 推断要不要接
unlistedAddressed:  'ignore'     名单外、点了名 → 忽略
unlistedUnaddressed:'ignore'     都没有 → 忽略
```

## 一些边界

- journal 最多 200 条，trigger 最多 5000 个
- executor 默认超时 30 分钟，失败重试 1 次
- 写盘走 temp + rename，进程崩在写入中途不会坏文件
- read-modify-write 走进程内互斥锁，防两个并发调用互相覆盖

## mini 在哪

上游 prototype 有完整的 Source / Eval / Assignment 分层。这个版本把它们压平了：只有一道工具入口、一个准入矩阵、一个子会话执行器。

够用，但不是生产级。适合想在 DSH 上试这套模型的人。

## 测试

```bash
node test/smoke.mjs
node test/resilience.mjs
```

## License

MIT（沿用上游）
