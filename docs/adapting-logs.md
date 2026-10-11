# Adapting session logs

`scripts/research/` 里的两个脚本读的是**特定 JSONL 记录格式**的 Agent 会话日志。
本文件说明那个格式，以及怎么把你自己的日志转成它。

> **这是可选内容。** STRATA 的核心（面锚定、索引、判决层、κ/γ 测量）
> **完全不需要会话日志**。只有"陷阱复发观测"（研究用）需要。

---

## 1. 为什么需要会话日志

有一类问题用静态分析答不了：

> **一条已写入约定文件的规则，Agent 到底有没有遵守？违反了多频繁？**

答案只在**开发过程记录**里。git 历史不记"Agent 当时看到了什么规则"，
所以会话日志是唯一的原始证据来源。

但请注意：**这是观察性数据，不能确立因果。**
因果只能由对照实验给出 —— 见 [quickstart](quickstart.md) §7。

---

## 2. 需要的记录格式

脚本读 **JSONL**：每行一个 JSON 对象。需要的记录类型：

| `type` | 必须字段 | 含义 |
|---|---|---|
`session` | `id`, `cwd`, `createdAt` | 会话头，出现一次 |
`turn/start` | `data.turn` | 一轮对话开始 |
`step/start` | `data.turn`, `data.step` | 一个步骤开始 |
`tool/call` | `data.name`, `data.arguments`(JSON 字符串), `data.turn`, `data.step` | **工具调用** |
`tool/result` | `data.message.content[0].isError` | 工具结果 |
`turn/end` | `data.reason.kind` | 轮次结束原因 |
`compaction/start` | — | 上下文压缩（可选）|

**`tool/call` 是最重要的** —— 陷阱检测全靠它。`data.arguments` 是 **JSON 字符串**
（不是对象），因为不同工具的入参结构不同。

**token 用量**：脚本递归查找任何含 `usage.totalTokens` 的对象，字段名为
`inputTokens` / `outputTokens` / `cacheReadTokens` / `reasoningTokens` / `totalTokens`。
所以你的记录里 `usage` 放在哪一层都可以。

**顶层的 `seq` 与 `time`**：`seq` 用于排序，`time` 是毫秒时间戳。

---

## 3. 文件格式：zstd 多帧（**关键坑**）

日志文件是 **多个 zstd 帧顺序拼接**，不是单个压缩流。

```js
import { zstdDecompressSync } from 'node:zlib'

let offset = 0
while (offset < buffer.length) {
  const frame = zstdDecompressSync(buffer.subarray(offset), { info: true })
  offset += frame.engine.bytesWritten   // ← 关键：拿本帧消耗的字节数
  // frame.buffer 是本帧解出的内容
}
```

**三个必须知道的点**：

| 坑 | 说明 |
|---|---|
`zstdDecompressSync(buf)` 默认**只解第一帧** | 静默丢弃其余 —— 你会只拿到会话头，还以为日志是空的 |
必须用 `{ info: true }` | 才能从 `engine.bytesWritten` 拿到**本帧压缩侧长度**，用它推进偏移 |
流式解压会失败 | `createZstdDecompress()` 对多帧拼接报 `ZSTD_error_prefix_unknown` |

这个格式没有文档，是靠试错确定的。若你的日志是单帧或纯 JSONL，
`decodeSession()` 的循环同样能工作（单帧时循环一次就结束）。

---

## 4. 会话快照去重（**另一个必踩的坑**）

同一会话可能留下多份**快照**：`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`。

实测中低版本内容是**高版本的字节前缀**，因此**逐个文件统计会把同一事件重复计入**。

脚本的 `findSessionFiles()` 按**会话目录**去重，只保留版本号最高的那一份：

```js
const v = /\.v(\d+)$/.exec(name)
const version = v ? Number(v[1]) : 0
if (!prev || version > prev.version) keep(this)
```

> **实测教训**：不做去重时，一个案例统计出 36 个会话、24 次复发；
> 去重后是 **31 个会话、21 次复发**。**多出来的是假的。**

---

## 5. 用法

```bash
# 会话指标（token / 轮次 / 工具分布）
node scripts/research/session-metrics.mjs --all \
  --sessions-dir ~/your-agent-logs \
  --filter 'myproject' \
  --json out/metrics.json

# 陷阱复发事件
node scripts/research/strata-events.mjs \
  --sessions-dir ~/your-agent-logs \
  --filter 'myproject' \
  --json out/events.json
```

`--sessions-dir` 默认 `~/.dsh/sessions`；`--filter` 是路径正则，只处理匹配的日志。

---

## 6. 你必须自己定义陷阱检测

`strata-events.mjs` 里的 `PITFALLS` 是**随包附带的示例**，
取自某个具体项目，**不通用**。

你要替换的是每个陷阱的 `detect(args, toolName)`：

```js
{
  id: 'no-backtick-in-template-comment',
  name: '模板字面量注释里的反引号',
  ruleForm: 'AGENTS.md 里写明的散文规则',
  checkForm: 'pnpm check:plugins',            // 有没有可执行形态
  detect(args, toolName) {
    if (toolName !== 'edit') return false
    const text = String(args.new_string ?? '')
    // ...返回 bool
  },
}
```

### 定义陷阱的三条纪律

| # | 纪律 | 为什么 |
|---|---|---|
**1** | **只定义能被机检的陷阱** | 像"需求理解偏差"这类主观问题无法在日志里可靠识别，硬检测会产出噪声 |
**2** | **记录它当时的规则形态**（散文？可执行？）| 这是 E3 对照的自变量 |
**3** | **在报告里写明检测是启发式的，且方向性未知** | 文本匹配既可能**漏检**（成对的反引号配平，看起来正确）又可能**误报** —— 见下 |

### ⚠️ 「模式匹配」≠「确认的违规」——一个实测到的陷阱

本工具的示例检测器匹配的是"模板字面量内的注释里出现反引号"这个**形态**。
但**反引号成对时并不构成语法错误** —— 解析器照样通过。

**实测证据**：把该形态注入一个真实文件，再让可执行检查器（Node 解析器）判定 ——
**检查器报告通过**（0 / 2 抓住），因为注入的反引号与文件里已有的反引号配平了。

**所以**：

| ❌ 不要写 | ✅ 应当写 |
|---|---|
"违规 21 次" | "**模式匹配 21 次**；真实违规数 ≤ 21，未测" |
"违反率 X%" | 除非你算过机会数，否则只能说"匹配到 N 次" |

> **这个错误教训值得单独记**：它是"手写词法扫描器不可靠"的又一例 ——
> 而可执行检查器的文件头里恰好写着这条警告。
> **写检测器的人最容易犯的错，就是以为"匹配到形态"等于"确认了问题"。**

### 一个必须记录的额外数字：机会数

模式匹配次数是**绝对计数**，不能跨仓库比较 —— 文件多的仓库机会多。

正确的分母是**机会数**：任务中允许犯该错的段落数。
`strata-events.mjs` **不算这个**，因为从日志无法可靠推断。

**你必须自己提供它**，否则报告里只能写"匹配到 N 次"，
不能写"违反率是 X%"，**更不能跨仓库比较**。

---

## 7. 报告时必须写的限制

| 限制 | 说明 |
|---|---|
**观察性，非因果** | 会话日志是过程记录，不是对照实验 |
**检测启发式** | 有漏检/误检；数字是近似 |
**未归一化** | 绝对计数不可跨仓库比较（除非你算了机会数）|
**时序窗口** | 若可执行检查器引入太晚，就没有可比的"之后"窗口 |
**快照去重** | 必须做，否则数字虚高 |
**Agent 版本** | 不同 Agent/模型的行为不可比 |

**工具会在输出末尾提醒前四条**，但**不能替你检查第 6 条**。
