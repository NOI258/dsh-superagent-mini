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
```

## License

MIT。部分代码来自 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，版权归 DeepSeek Harness Team，同样 MIT。完整声明见 LICENSE。
