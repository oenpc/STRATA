# 怎么写判决层（`V`）

判决层是**唯一有实证线索指向"真正改变 Agent 行为"的一层**。
参照：[arXiv:2610.04779](https://arxiv.org/abs/2610.04779) 的论证 ——
*只有可执行检查器能确立所声称的性质*。

本文件给出一个最小、可用的判决层写法。

---

## 1. 契约（三条，必须严格遵守）

| 退出码 | 含义 | 要求 |
|---|---|---|
**0** | 通过 | 无输出或简短摘要 |
**1** | **失败** | **必须**输出：约束 id、文件、行号、为什么 |
**2** | **无法判定** | 明确说明哪条规则判不了、为什么 |

> **必须支持退出码 2。** 很多规则不可判定（"命名是否清晰"、"这个抽象是否合理"）。
> 强迫给出 pass/fail 只会产出**假信号** —— 而假信号比没有信号更糟，
> 因为它让 Agent 和人都以为检查过了。

**另一条硬要求**：失败输出必须**可操作**。
Agent 要能直接读出"哪个文件第几行违反了哪条规则、该怎么改"。
输出 `Error: check failed` 是没有用的。

---

## 2. 结构：约束按「面」声明

判决层的核心不是检查逻辑，而是**约束怎么声明适用范围**。

```yaml
# constraints.yml
constraints:
  - id: no-shell-exec
    scope:
      layers: [S]              # ← 面：脚本层
      domains: [CO, FS]
    why: 防止命令注入
    check: tools/checks/no-shell-exec.mjs

  - id: no-backtick-in-template-comment
    scope:
      layers: [L]              # ← 面：库层
      domains: [FS]
    why: 模板字面量内的注释含反引号会提前结束模板，报错位置远离真因
    check: tools/checks/no-backtick.mjs
```

**关键**：`scope` 写的是**坐标**，不是文件列表。

**自检**：新增一个 `L`/`FS` 面的文件，它会被自动纳入 `no-backtick` 的检查范围吗？
应当会 —— 这就是锚定生效的标志。

---

## 3. 三值检查器的骨架

```js
#!/usr/bin/env node
// tools/checks/no-backtick.mjs
// 契约：exit 0 = 通过 / 1 = 失败 / 2 = 无法判定

import { readFileSync, readdirSync } from 'node:fs'

const TARGET = process.argv[2] ?? 'src'
const BT = String.fromCharCode(96)   // 反引号

const violations = []
let unjudged = 0

for (const file of walk(TARGET)) {
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    unjudged += 1          // 读不了 → 不假装通过
    continue
  }

  const lines = src.split('\n')
  let inTemplate = false
  lines.forEach((line, i) => {
    const isComment = /^\s*(\*|\/\*|\/\/)/.test(line)
    const btCount = line.split(BT).length - 1
    if (inTemplate && isComment && btCount > 0) {
      violations.push({ file, line: i + 1, text: line.trim().slice(0, 80) })
    }
    if (btCount % 2 === 1) inTemplate = !inTemplate
  })
}

if (violations.length > 0) {
  console.error(`no-backtick-in-template-comment: ${violations.length} 处违规`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`)
  }
  console.error('')
  console.error('修法：模板字面量内的注释不要出现反引号，用「」或直接写类名。')
  process.exit(1)
}

if (unjudged > 0) {
  console.error(`有 ${unjudged} 个文件无法读取，判定不完整。`)
  process.exit(2)          // ← 诚实：不假装通过
}

console.log('no-backtick-in-template-comment: OK')
process.exit(0)
```

**注意三个细节**：

1. **读不了文件时 exit 2**，不是 exit 0 —— "没找到问题"和"没检查"是两件事
2. **失败输出给了修法** —— 这样 Agent 能直接照做
3. **检测用文本启发式**，有漏检/误检。**诚实的做法是在文件头注释里写明这一点**

---

## 4. 聚合入口

让 Agent **一条命令**能跑全部：

```json
// package.json
{
  "scripts": {
    "strata:check": "node tools/checks/run-all.mjs"
  }
}
```

`run-all.mjs` 按 `constraints.yml` 的 `scope` 决定每条约束检查哪些路径：

```js
// tools/checks/run-all.mjs（骨架）
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'          // 或自己用 JSON

const cfg = parse(readFileSync('constraints.yml', 'utf8'))
const index = readIndex('docs/strata-index.md')   // 路径 → ⟨层,域⟩

let failed = 0
let unknown = 0

for (const c of cfg.constraints) {
  const targets = [...index]
    .filter(([, f]) => c.scope.layers.includes(f.layer) && c.scope.domains.includes(f.domain))
    .map(([path]) => path)

  if (targets.length === 0) continue

  try {
    execFileSync('node', [c.check, ...targets], { stdio: 'inherit' })
  } catch (error) {
    if (error.status === 2) unknown += 1
    else failed += 1
  }
}

if (failed > 0) process.exit(1)
if (unknown > 0) process.exit(2)
process.exit(0)
```

---

## 5. 必须写进约定文件的几句话

判决层只有被**跑到**才有用。所以在你的 `AGENTS.md` / `CLAUDE.md` 里写：

```markdown
## 改代码前
- 读 `docs/strata-index.md` 里相关文件的条目
- 改完后**必须**跑 `npm run strata:check`

## 注意
- 退出码 0 = 通过，1 = 失败，2 = 无法判定
- 退出码 2 不等于通过 —— 请报告哪条规则判不了
```

**最后一句很重要**：否则 Agent 会把 `2` 当成成功。

---

## 6. 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
把判定脚本放进 Agent 的 prompt | 测的是"能不能猜中测试" | **判定脚本对 Agent 不可见** |
只支持 0/1 | 不可判定的规则产出假信号 | 支持 **2** |
失败输出只有 `Error` | Agent 无法照做 | 给**文件:行号 + 约束 id + 修法** |
`scope` 写成文件列表 | 退化为逐点，锚定收益归零 | `scope` 写**坐标** |
检查器太慢（>10s）| Agent 会跳过它 | 增量检查 / 只查改动文件 |
从不校验索引完整性 | 索引静默过期，**比没有更危险** | `strata:check` 里加"新增文件是否都有条目" |

---

## 7. 判断你有没有做对

一个简单的检验：

> **把 `strata:check` 交给一个从没见过你项目的 Agent，
> 它能只看它的输出就修好违规吗？**

- **能** → 判决层的输出是合格的
- **不能** → 输出不够可操作，Agent 会瞎猜

第二个检验：

> **新增一个同类文件后，`strata:check` 会自动覆盖它吗？**

不会的话，你的 `scope` 写成了文件列表，锚定没生效。

---

## 8. 这一层是**假设**，不是结论

必须说清：**"可执行约束比散文有效"这一点，目前只有 n=1 的观察性线索，
没有对照实验证据。**

它有独立于本框架的旁证（[arXiv:2610.04779](https://arxiv.org/abs/2610.04779)
论证了"只有可执行检查器能确立性质"），但那是在**并发 Agent 协调**的语境下，
不是"约束形式对复发率的影响"。

**所以你应当自己测**：见 [quickstart](../docs/quickstart.md) §7 的三条件对照。
如果你测出散文与可执行**没有差异**，那是个有价值的负结果 —— 请报告它。
