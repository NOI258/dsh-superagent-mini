# dsh-superagent-mini

想要的效果：丢一个请求进来，agent 自己开个子会话去干，干完回来说一声。DSH 自带的 `subagent` 是一次性的，回来就结束，没法「同一件事接着聊」。所以写了这个。

设计上参考了 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）的分层模型——Trigger / Ticket / Mandate 那套术语，和几条不可变规则。

代码是自己写的，压成了一个文件，另外加了长期记忆和落盘并发锁。借鉴过来的代码片段在 LICENSE 里注明了。

---

## 用起来是这样

```
superagent_request "把这个仓库的 README 翻译成英文"
→ t-3f2a91c  开了一张票，派了执行器

superagent_show  t-3f2a91c
→ 看它做到哪一步了

superagent_reply t-3f2a91c "顺便把 LICENSE 也翻了"
→ 消息进同一张票，执行器下次醒来会看到

superagent_cancel t-3f2a91c
→ 不做了
```

票和执行器是两回事。执行器崩了，票还在；重试是票的事，不是会话的事。

## 十一个工具

提交和查看：`superagent_request`、`superagent_list`、`superagent_show`、`superagent_team`、`superagent_health`

控制：`superagent_cancel`、`superagent_reply`

记忆：`superagent_memory`（读某张票的 journal）、`superagent_remember`、`superagent_recall`、`superagent_forget`

## 数据在哪

```
$DSH_SUPERAGENT_MINI_DIR          显式指定优先
$DSH_PROFILE_DIR/superagent-mini  否则跟着 profile
~/.dsh/superagent-mini            兜底
```

`tickets.json` 存票和 journal，`memory.json` 存长期记忆。

**分开是有意的。** 票的 journal 随任务结束就没人看了，值得留下的教训要活过每一张产生它的票。

## 四个照抄来的规则

`Trigger` 幂等——同一个请求提两次，只产生一张票。

`Ticket` 的状态自己定义，不镜像执行器的会话状态。

`Mandate` 不可变——想扩大范围就开新票，不在旧的上面改。

准入是矩阵不是布尔值：

```
名单内、没点名   → inferred  推断要不要接
名单外、点了名   → ignore    忽略
都没有           → ignore    忽略
```

## 边界

- journal 最多 200 条，trigger 最多 5000 个
- 执行器默认 30 分钟超时，失败重试 1 次
- 写盘 temp + rename，进程崩在写入中途不会坏文件
- read-modify-write 走进程内互斥锁，防两个调用互相覆盖

## 和上游比，少了什么

上游有独立的 Source / Eval / Assignment 分层，支持多种来源和更细的准入策略。这里全压平了：一个工具入口、一个矩阵、一个子会话执行器。

也**没有实测过大量并发**。写的时候考虑到了，但没压测过。

这是能用的实验品，不是生产级组件。

## 装

```bash
dsh plugin --profile web add github:NOI258/dsh-superagent-mini
```

装完重启，十一个 `superagent_*` 工具出现在工具列表里。

## 测试

```bash
node test/smoke.mjs
node test/resilience.mjs
node test/consistency.mjs
node test/regressions.mjs
```

四个都是独立进程、临时 store，不碰真实数据。`resilience` 跑超时和重试，`consistency` 跑 Trigger 幂等、Memory 并发写、取消打断重试，`regressions` 是每次修完 bug 往里加的防回归用例（取消落在启动窗口、同票双 Executor、排队时 reply 丢失、取消毁掉完成报告等）。

新写用例时注意：断言要能描述「修好之后应该成立」的那一侧，然后拿旧代码跑一遍确认它会 FAIL。只验证「全绿」等于没验证——2026-11-27 那轮 7 处修复，旧代码下正好 7 个断言失败，恢复后全绿，这才说明测试真的在测东西。

## 运行环境

宿主是一台 Android 15 手机（骁龙 4 Gen 2，12 GB 内存 / 256 GB 存储），没有电脑。DeepSeek Harness 跑在 Termux + proot 的 Ubuntu 24.04 LTS（aarch64）容器里，本插件以 `web` profile 加载。

容器内能查到的（实测）：

- Ubuntu 24.04.5 LTS，aarch64，内核 5.10-gki
- 8 个核；`/proc/self/status` 的 `TracerPid` 非 0，proot 在跟踪
- 可见内存 11.1 GiB，根分区 224 GiB（已用 90%）
- Node v24.22.1、npm 11.19.1

Android 版本、SoC 型号、整机容量在容器里查不到（没有 `getprop`），这部分按机主说明。

三个测试文件只依赖 Node 标准库（`node:zlib`、`node:child_process`），每个场景跑在独立子进程和临时 store 里，不碰真实数据。同样，只有这套环境是实测过的。

## License

MIT。部分代码来自 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，版权归 DeepSeek Harness Team，同样 MIT。完整声明见 LICENSE。
