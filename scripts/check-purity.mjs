#!/usr/bin/env node
/**
 * 自检：STRATA 是**通用理论包**，不得混入任何具体项目的痕迹。
 *
 * 这是 STRATA **应用在它自己身上**的一条约束 —— 一个 dogfooding 的例子：
 *
 *   面（scope）：本仓库的 .md 与 .mjs 文件，**除研究材料与示例之外**
 *   约束（constraint）：不得出现项目专属标识符
 *   判决（verdict）：可执行，退出码 0 / 1 / 2
 *
 * 为什么需要它：理论包一旦混入某个项目的规则文本（如"公开路由必须带
 * PUBLIC_PATH 前缀"），读者就无法区分**通用结论**与**某个仓库的现状**，
 * 而且会让包看起来像那个项目的附件。这类污染靠人眼审查会漏 ——
 * 所以把它变成机械检查。
 *
 * ## 契约
 *
 *   退出码 0  通过
 *   退出码 1  失败（列出文件、行号、命中的词）
 *   退出码 2  无法判定（读不了文件、或豁免清单里的文件不存在）
 *
 * 用法：
 *   node scripts/check-purity.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/* ------------------------------ 约束定义 ------------------------------ */

/**
 * 禁止出现的标识符 —— 只收录**某个项目的专有名词**。
 *
 * ## 为什么刻意不收 `AGENTS.md` / `CLAUDE.md`
 *
 * 它们是**生态通用文件名**，不是哪个项目的专有物。说"写进你的约定文件"是恰当用法。
 * 把它们一并禁止会产出误报 —— **而一条开始误报的约束会被绕过，然后失效**。
 * 这比漏报更糟。
 *
 * 这两者只在**作证据出处**时才构成污染（"某个项目的约定文档里写了 X"），
 * 那由下面的 ATTRIBUTION 单独管。
 *
 * ## 同理不收的词
 *
 * `plugin`、`route`、`view`、`multipart` 这类是通用编程词汇。
 * 放过它们，检查才有信噪比。
 */
const FORBIDDEN = [
  // ── 具体产品 / 仓库名 ──
  ['\\bOENPC\\b', '某个具体项目的名字'],
  ['\\boenpc', '某个具体项目的名字'],
  ['\\bxray[-_]?v?2?\\b', '某个具体插件的名字'],
  ['\\bfile-share\\b', '某个具体插件的名字'],
  ['\\bagent-manager\\b', '某个具体插件的名字'],

  // ── 某个项目的内部标识符 ──
  ['\\bPUBLIC_PATH\\b', '某个项目的常量名'],
  ['\\bTEMP_PUBLIC_PATH\\b', '某个项目的常量名'],
  ['\\bregisterPublic\\b', '某个项目的 API 名'],
  ['\\bpluginManifest\\b', '某个项目的模块名'],
  ['\\bpublicPage\\b', '某个项目的模块名'],
  ['\\btempPage\\b', '某个项目的模块名'],

  // ── 某个项目的命令名 ──
  ['check:plugins', '某个项目的 npm script 名'],
  ['check-plugins', '某个项目的脚本名'],
  ['regression-file-share', '某个项目的回归脚本名'],
]

/**
 * 「作证据出处」时才算污染 —— 即使词本身是通用的。
 *
 * 例：`AGENTS.md 里写明：…` 是**引用某个项目的规则文本**，那是污染；
 *     而"写进你的 AGENTS.md"是**通用建议**，不是污染。
 *
 * 用**归因句式**区分两者，而不是一刀切禁词。
 */
const ATTRIBUTION = [
  // 「X 写明 / 写着 / 里写了」—— 引用某处的规则文本
  ['(AGENTS\\.md|CLAUDE\\.md)\\s*[里中]?\\s*(写明|写着|写了|规定|要求)', '作证据出处引用某个项目的规则文本'],
  // 「（来自 X 实测）」「X 的教训」—— 归因到某个具体项目
  ['(来自|源自)\\s*[A-Za-z\\u4e00-\\u9fa5-]{2,20}\\s*(实测|观察|案例)', '把结论归因到某个具体项目'],
]

/**
 * 豁免范围（**按坐标，不按文件列表** —— 这正是 STRATA 的做法）。
 *
 * 为什么这些可以含项目痕迹：
 *   · `docs/research/`     —— 证据来源必须可追溯，写清楚出处是学术规范
 *   · `docs/adapting-logs.md` —— 用真实例子讲"模式匹配 ≠ 违规"这个教训
 *   · `examples/`          —— 示例的作用就是展示"某个项目是怎么做的"
 *   · `scripts/check-purity.mjs` —— 本文件自身必须列出被禁的词
 */
const EXEMPT = [
  /^docs\/research\//,
  /^docs\/adapting-logs\.md$/,
  /^examples\//,
  /^scripts\/check-purity\.mjs$/,
]

/**
 * 参与检查的坐标：本包里的文档与脚本。
 *
 * 注意用**坐标**表达范围（"所有 .md"、"scripts/ 下的 .mjs"），
 * 而不是逐个列文件名 —— 新增文件会自动被覆盖，零新规则。
 */
const IN_SCOPE = [/\.md$/, /^scripts\/.*\.mjs$/, /^templates\/.*\.md$/]
const SKIP_DIR = new Set(['.git', 'node_modules', '.strata-out'])

/* ------------------------------ 收集 ------------------------------ */

function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') {
      if (e.name !== '.gitignore') continue
    }
    if (SKIP_DIR.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      collect(full, out)
      continue
    }
    const rel = relative(ROOT, full).replace(/\\/g, '/')
    if (IN_SCOPE.some((re) => re.test(rel))) out.push(rel)
  }
  return out
}

/* ------------------------------ 执行 ------------------------------ */

/*
 * 只在**被直接执行**时跑主流程。
 * 本文件可被 import 复用（FORBIDDEN / EXEMPT 等定义），
 * 若无条件执行会在 import 时调用 process.exit()。
 */
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run()
}

function run() {
    let files
  try {
    files = collect(ROOT).sort()
  } catch (error) {
    console.error(`无法遍历仓库：${error.message}`)
    process.exit(2)
  }

  /* 豁免清单里的文件若不存在，说明仓库结构变了，检查已失效 —— 报 2 而不是静默通过 */
  for (const p of ['docs/research/status.md', 'docs/adapting-logs.md']) {
    if (!existsSync(join(ROOT, p))) {
      console.error(`豁免清单引用的文件不存在：${p}`)
      console.error('仓库结构可能已变，本检查的结果不再可信。')
      process.exit(2)
    }
  }

  const violations = []
  let scanned = 0
  let unreadable = 0

  for (const rel of files) {
    if (EXEMPT.some((re) => re.test(rel))) continue
    scanned += 1

    let text
    try {
      text = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      unreadable += 1
      continue
    }

    const lines = text.split('\n')
    for (const [pattern, why] of [...FORBIDDEN, ...ATTRIBUTION]) {
      const re = new RegExp(pattern, 'g')
      lines.forEach((line, i) => {
        if (re.test(line)) {
          violations.push({ file: rel, line: i + 1, pattern, why, text: line.trim().slice(0, 90) })
        }
        re.lastIndex = 0
      })
    }
  }

  /* ------------------------------ 输出 ------------------------------ */

  if (violations.length > 0) {
    console.error(`purity-no-project-identifiers: ${violations.length} 处违规`)
    console.error('')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  «${v.text}»`)
      console.error(`      → 命中 ${v.pattern}（${v.why}）`)
    }
    console.error('')
    console.error('修法：把项目专属的名称换成通用表述，或写进豁免范围。')
    console.error('      若某段确实需要举例，把它移到 docs/research/ 或 examples/。')
    process.exit(1)
  }

  if (unreadable > 0) {
    console.error(`有 ${unreadable} 个文件无法读取，判定不完整。`)
    process.exit(2)
  }

  console.log(`purity-no-project-identifiers: OK（检查 ${scanned} 个文件，豁免 ${files.length - scanned} 个）`)
  process.exit(0)
}
