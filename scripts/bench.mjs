#!/usr/bin/env node
/**
 * STRATA bench —— 在你自己的仓库上做「有 STRATA / 没有 STRATA」的对照自测。
 *
 * 这是 STRATA 的**唯一有效性证据来源**。公开的方法如果不能让使用者自己检验，
 * 就只是主张。本工具的目的就是让主张变成可测的东西。
 *
 * ## 它测什么
 *
 * 同一个任务，在三种上下文条件下各跑一次，比较**任务成功率**：
 *
 *   C1  no-context   只给任务描述
 *   C2  raw-files    给相关文件的**源码**
 *   C3  strata       给 STRATA 索引（条目 + 面 + 约束）
 *
 * **为什么必须有 C2**：如果只比 C1 与 C3，你测的是「多给上下文有没有用」，
 * 而不是「STRATA 有没有用」。C2 给出同等的上下文量但没有结构 ——
 * **C3 相对 C2 的提升，才是 STRATA 的贡献。**
 *
 * ## 判定为什么必须"隐藏"
 *
 * 每个任务有一个 **verifier**（一个命令，退出码 0 = 通过）。它**不进 Agent 的
 * prompt**，Agent 看不到。否则测的是"Agent 能不能猜中测试"，不是"能不能做对"。
 *
 * ## Agent 怎么跑
 *
 * 本工具**不绑定任何 Agent**。它用 `--agent-cmd` 调用你指定的命令，
 * 把 prompt 写到临时文件并用 `{prompt}` 占位符替换。
 *
 *   --agent-cmd 'my-agent --prompt-file {prompt} --cwd {cwd}'
 *
 * 若省略 `--agent-cmd`，工具进入**手动模式**：它打印 prompt，你让 Agent 去做，
 * 完成后按回车，工具自动跑 verifier 并记录结果。
 *
 * ## 用法
 *
 *   # 1. 从 git 历史生成任务（用历史提交当题目）
 *   node scripts/bench.mjs init --repo <仓库> --out bench/tasks --limit 10
 *
 *   # 2. 跑（三条件 × 每任务 × 重复次数）
 *   node scripts/bench.mjs run --tasks bench/tasks --out bench/results \
 *        --conditions no-context,raw-files,strata --repeat 3 \
 *        --agent-cmd 'my-agent --prompt-file {prompt} --cwd {cwd}'
 *
 *   # 3. 出报告（含提升比）
 *   node scripts/bench.mjs report --results bench/results
 *
 * ## 诚实的限制（报告里也会打印）
 *
 *   · 样本量小的时候，差异**可能是噪声**。报告给出 Wilson 置信区间。
 *   · 用历史提交当任务会**泄漏**：模型可能预训练见过公开仓库的这些提交。
 *     私有仓库或未公开分支可缓解。
 *   · 三种条件的**上下文长度不同**，这本身会影响结果 —— C2 就是为控制它而设的。
 *   · 单次运行不能排除 Agent 的随机性，所以有 `--repeat`。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'

/* ============================== 工具 ============================== */

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const has = (flag) => args.includes(flag)

function sh(cwd, command, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) }
  } catch (error) {
    if (allowFail) return { ok: false, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    throw error
  }
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/* ============================== init：从 git 历史生成任务 ============================== */

/**
 * 把仓库的历史提交变成任务。
 *
 * 一个任务 = 一次真实提交：
 *   · prompt    = 该提交的标题（去掉类型前缀）
 *   · baseRef   = 该提交的**父提交**（Agent 从这里开始改）
 *   · touched   = 该提交改过的文件（用于构造 C2 的源码上下文）
 *   · verifier  = 由 `--verify-cmd` 指定（默认跑仓库的测试命令）；**不告诉 Agent**
 */
function cmdInit() {
  const repo = resolve(opt('--repo', process.cwd()))
  const out = resolve(opt('--out', 'bench/tasks'))
  const limit = Number(opt('--limit', '10'))
  const verifyCmd = opt('--verify-cmd', null)
  const minFiles = Number(opt('--min-files', '1'))
  const maxFiles = Number(opt('--max-files', '6'))
  const skip = opt('--skip') ? new RegExp(opt('--skip'), 'i') : /^(chore|docs|style|ci|build|release)\b/i

  console.log(`从 ${repo} 的历史生成任务`)
  console.log('')

  /* 取最近 N 个改动源码文件的提交（跳过大改动与纯文档/杂务提交） */
  const log = execFileSync(
    'git',
    ['-C', repo, 'log', '--no-merges', '--pretty=format:%H%x09%P%x09%s', '-n', '400'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )

  const tasks = []
  for (const line of log.split('\n')) {
    if (tasks.length >= limit) break
    const [hash, parents, ...rest] = line.split('\t')
    const subject = rest.join('\t')
    if (!hash || !parents) continue
    const parent = parents.split(' ')[0]
    if (!parent) continue
    if (skip.test(subject)) continue

    const nameOnly = execFileSync('git', ['-C', repo, 'diff', '--name-only', `${parent}..${hash}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const files = nameOnly.split('\n').map((s) => s.trim()).filter(Boolean)
    const codeFiles = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|kt|cs|php|rb|sql)$/i.test(f))
    if (codeFiles.length < minFiles || codeFiles.length > maxFiles) continue

    /* prompt：去掉 "fix(x):" 这类前缀，保留可读描述 */
    const prompt = subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').trim()
    if (prompt.length < 8) continue

    tasks.push({
      id: `${hash.slice(0, 8)}`,
      repo,
      baseRef: parent,
      commit: hash,
      prompt,
      touched: codeFiles,
      verifyCmd,
    })
  }

  if (tasks.length === 0) {
    console.error('没有生成任何任务。试试放宽 --min-files/--max-files，或去掉 --skip。')
    process.exit(1)
  }

  ensureDir(out)
  for (const t of tasks) {
    const dir = join(out, t.id)
    ensureDir(dir)
    writeFileSync(join(dir, 'task.json'), JSON.stringify(t, null, 2))
    writeFileSync(join(dir, 'prompt.md'), t.prompt + '\n')
  }

  /* 写一份任务集说明，便于人审——任务质量决定实验质量 */
  const readme = [
    '# 任务集',
    '',
    `来源：\`${repo}\``,
    `生成时间：${new Date().toISOString()}`,
    '',
    '**请人工过一遍**：任务必须（a）描述清楚到能独立完成，（b）不依赖提交信息之外的知识，',
    '（c）判定命令能在 baseRef 上失败、在真实提交上通过。',
    '',
    '| id | 文件数 | 任务描述 |',
    '|---|---|---|',
    ...tasks.map((t) => `| ${t.id} | ${t.touched.length} | ${t.prompt.replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n')
  writeFileSync(join(out, 'README.md'), readme)

  console.log(`生成 ${tasks.length} 个任务 → ${out}`)
  console.log('')
  for (const t of tasks) console.log(`  ${t.id}  [${t.touched.length} 文件]  ${t.prompt.slice(0, 64)}`)
  console.log('')
  if (!verifyCmd) {
    console.log('⚠ 未指定 --verify-cmd，任务没有自动判定命令。')
    console.log('  请在每个 task.json 里补 verifyCmd，或用 --verify-cmd 重新生成。')
    console.log('  判定命令要满足：**在 baseRef 上失败，在真实提交上通过**。')
  }
}

/* ============================== 上下文构造 ============================== */

/** C1：只给任务描述 */
function ctxNone() {
  return ''
}

/** C2：给出该提交改过的文件的**当前（提交后）内容** —— 控制"上下文量"这个混淆变量 */
function ctxRawFiles(repo, task) {
  const parts = ['以下是本任务相关的文件内容：', '']
  for (const f of task.touched.slice(0, 6)) {
    const r = sh(repo, `git show ${task.commit}:"${f}"`, { allowFail: true })
    if (!r.ok) continue
    const body = r.out.split('\n').slice(0, 220).join('\n')
    parts.push('```', `// ${f}`, body, '```', '')
  }
  return parts.join('\n')
}

/**
 * C3：给出 STRATA 索引中相关条目的原文。
 *
 * 实现上很直接：从你的实例索引里，抽出 `touched` 文件对应的条目行，
 * 再加上 §1 的全局约束。**不注入源码** —— 这正是与 C2 的区别。
 */
function ctxStrata(indexPath, task) {
  if (!indexPath || !existsSync(indexPath)) return '(未找到索引文件)'
  const text = readFileSync(indexPath, 'utf8')
  const lines = text.split('\n')

  const picked = []
  for (const f of task.touched) {
    const base = basename(f)
    const hit = lines.find((l) => l.trim().startsWith(f) || l.includes(`](${f})`) || l.includes(base + '['))
    if (hit) picked.push(hit.trim())
  }

  /* 顺带带上全局约束段（§1 或 "硬约束" 小节） */
  const gi = lines.findIndex((l) => /全局硬约束|Global constraints/i.test(l))
  const globals = gi >= 0 ? lines.slice(gi, gi + 24).filter((l) => l.trim()).join('\n') : ''

  return [
    '# 本项目的 STRATA 索引（相关内容）',
    '',
    globals ? '## 全局约束\n\n' + globals + '\n' : '',
    '## 相关条目',
    '',
    ...(picked.length ? picked.map((l) => '- ' + l) : ['(该任务涉及的文件尚无条目)']),
    '',
    '> 条目格式：`路径[层·域·重要性·特征·规模]: F:角色 | R:相关 | A:导出 | S:约束与陷阱`',
  ].join('\n')
}

function buildPrompt(condition, task, repo, indexPath) {
  const header = [
    '你正在一个代码仓库里完成一个开发任务。',
    '',
    '## 任务',
    task.prompt,
    '',
    '## 涉及的文件',
    ...task.touched.map((f) => `- ${f}`),
    '',
  ].join('\n')

  let extra = ''
  if (condition === 'raw-files') extra = ctxRawFiles(repo, task)
  else if (condition === 'strata') extra = ctxStrata(indexPath, task)

  return header + (extra ? '\n---\n\n' + extra + '\n' : '')
}

/* ============================== run ============================== */

async function cmdRun() {
  const tasksDir = resolve(opt('--tasks', 'bench/tasks'))
  const outDir = resolve(opt('--out', 'bench/results'))
  const conditions = (opt('--conditions', 'no-context,raw-files,strata')).split(',').map((s) => s.trim())
  const repeat = Number(opt('--repeat', '1'))
  const agentCmd = opt('--agent-cmd', null)
  const indexPath = opt('--index', null)
  const keepWork = has('--keep-work')

  const taskIds = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  if (taskIds.length === 0) {
    console.error(`没有任务：${tasksDir}`)
    process.exit(1)
  }

  ensureDir(outDir)
  const layout = join(outDir, 'layout.json')
  writeFileSync(
    layout,
    JSON.stringify({ generatedAt: new Date().toISOString(), conditions, repeat, tasksDir, agentCmd: agentCmd ? 'set' : 'manual' }, null, 2),
  )

  const rl = agentCmd ? null : createInterface({ input: process.stdin, output: process.stdout })
  console.log(`任务 ${taskIds.length} 个 × 条件 ${conditions.length} 个 × 重复 ${repeat} 次 = ${taskIds.length * conditions.length * repeat} 次运行`)
  console.log(agentCmd ? `Agent: ${agentCmd}` : 'Agent: 手动模式（工具打印 prompt，你去做，回车后判定）')
  console.log('')

  for (const id of taskIds) {
    const task = readJson(join(tasksDir, id, 'task.json'))
    if (!task.verifyCmd) {
      console.log(`  跳过 ${id}：没有 verifyCmd（无法判定）`)
      continue
    }
    for (const condition of conditions) {
      for (let r = 1; r <= repeat; r++) {
        const runDir = join(outDir, `${id}__${condition}__r${r}`)
        if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
        ensureDir(runDir)

        const prompt = buildPrompt(condition, task, task.repo, indexPath)
        const promptFile = join(runDir, 'prompt.md')
        writeFileSync(promptFile, prompt)

        /* 工作副本：从 baseRef 起一个独立 worktree，避免污染用户仓库 */
        const workDir = join(runDir, 'work')
        ensureDir(dirname(workDir))
        let prepared = false
        const wt = sh(task.repo, `git worktree add --detach "${workDir}" ${task.baseRef}`, { allowFail: true })
        if (wt.ok) prepared = true
        else {
          /* 退路：无 worktree 支持时用 clone */
          const cl = sh(task.repo, `git clone --quiet --no-checkout "${task.repo}" "${workDir}"`, { allowFail: true })
          if (cl.ok) {
            sh(workDir, `git checkout --quiet ${task.baseRef}`, { allowFail: true })
            prepared = true
          }
        }
        if (!prepared) {
          console.log(`  ✗ ${id}/${condition}/r${r}: 无法创建工作副本`)
          continue
        }

        const ctxLabel = `${id}/${condition}/r${r}`
        let agentStatus = 'not-run'

        if (agentCmd) {
          const filled = agentCmd
            .replace(/\{prompt\}/g, `"${promptFile}"`)
            .replace(/\{cwd\}/g, `"${workDir}"`)
          try {
            execSync(filled, { cwd: workDir, stdio: 'inherit', shell: true, timeout: 20 * 60 * 1000 })
            agentStatus = 'ok'
          } catch {
            agentStatus = 'nonzero-exit'
          }
        } else {
          console.log('─'.repeat(70))
          console.log(`任务 ${ctxLabel}`)
          console.log(`prompt 已写入：${promptFile}`)
          console.log(`工作副本：   ${workDir}`)
          console.log('')
          console.log('请让 Agent 在该工作副本里完成任务，然后按回车跑判定。')
          await rl.question('[完成后按回车] ')
        }

        /*
         * 判定：**不看 Agent 说了什么，只看 verifier 的退出码**。
         *
         * execSync 在非零退出时抛异常，所以必须 try/catch ——
         * 初版这里写成 try{return true}catch{return false}，
         * 结果 `passed` 恒为 true，报告会显示 100% 通过率。
         * 那是最危险的一种假数据，所以这段特意写清楚。
         */
        let passed = false
        let verifierExit = null
        let verifierOutput = ''
        try {
          verifierOutput = execSync(task.verifyCmd, {
            cwd: workDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024,
            timeout: 10 * 60 * 1000,
          })
          passed = true
          verifierExit = 0
        } catch (error) {
          passed = false
          verifierExit = typeof error.status === 'number' ? error.status : 'timeout-or-spawn-error'
          verifierOutput = String(error.stdout ?? '') + String(error.stderr ?? '') + String(error.message ?? '')
        }

        const record = {
          taskId: id,
          condition,
          repeat: r,
          agentStatus,
          passed,
          verifierExit,
          verifierOutput: verifierOutput.slice(0, 4000),
          at: new Date().toISOString(),
        }
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(record, null, 2))

        console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${ctxLabel}`)

        if (!keepWork) {
          const wtRemove = sh(task.repo, `git worktree remove --force "${workDir}"`, { allowFail: true })
          if (!wtRemove.ok) rmSync(workDir, { recursive: true, force: true })
        }
      }
    }
  }

  if (rl) rl.close()
  console.log('')
  console.log(`结果写入 ${outDir}`)
  console.log(`出报告：node scripts/bench.mjs report --results "${outDir}"`)
}

/* ============================== report ============================== */

/**
 * Wilson 区间：小样本下比正态近似可靠。
 * 用于告诉使用者"这个差异有没有可能是噪声"。
 */
function wilson(successes, n, z = 1.96) {
  if (n === 0) return [0, 0]
  const p = successes / n
  const d = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

function cmdReport() {
  const resultsDir = resolve(opt('--results', 'bench/results'))
  const dirs = readdirSync(resultsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  const records = []
  for (const d of dirs) {
    const p = join(resultsDir, d, 'result.json')
    if (!existsSync(p)) continue
    records.push(readJson(p))
  }
  if (records.length === 0) {
    console.error('没有找到结果。先跑 run。')
    process.exit(1)
  }

  const conditions = [...new Set(records.map((r) => r.condition))]
  const stats = new Map()
  for (const c of conditions) {
    const rs = records.filter((r) => r.condition === c)
    const ok = rs.filter((r) => r.passed).length
    stats.set(c, { n: rs.length, ok, rate: rs.length ? ok / rs.length : 0, ci: wilson(ok, rs.length) })
  }

  const pct = (x) => (x * 100).toFixed(1) + '%'
  const bar = (x) => '█'.repeat(Math.round(x * 30)).padEnd(30, '·')

  console.log('')
  console.log('STRATA bench — 对照结果')
  console.log('')
  console.log('  条件            运行  通过   成功率')
  console.log('  ─────────────────────────────────────────────')
  for (const c of conditions) {
    const s = stats.get(c)
    console.log(`  ${c.padEnd(14)} ${String(s.n).padStart(4)}  ${String(s.ok).padStart(4)}   ${pct(s.rate).padStart(6)}  ${bar(s.rate)}`)
    console.log(`  ${''.padEnd(14)}                   95% CI [${pct(s.ci[0])}, ${pct(s.ci[1])}]`)
  }

  /* 关键对比：strata vs raw-files —— 这才是 STRATA 的贡献 */
  const base = stats.get('no-context')
  const raw = stats.get('raw-files')
  const strata = stats.get('strata')

  console.log('')
  console.log('── 提升 ──')
  if (base && strata) {
    const d = strata.rate - base.rate
    console.log(`  STRATA vs 无上下文 : ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} 个百分点` +
      (base.rate > 0 ? `   提升比 ${(strata.rate / base.rate).toFixed(2)}×` : '   （基线为 0，比值无定义）'))
  }
  if (raw && strata) {
    const d = strata.rate - raw.rate
    console.log(`  STRATA vs 原始源码 : ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} 个百分点` +
      (raw.rate > 0 ? `   提升比 ${(strata.rate / raw.rate).toFixed(2)}×` : '   （基线为 0，比值无定义）'))
    console.log('')
    console.log('  ⚠ 这一行才是 STRATA 的贡献。若它接近 0，说明提升来自「多给上下文」，')
    console.log('    而不是来自「结构化的面与约束」。')
  }
  if (!raw) {
    console.log('')
    console.log('  ⚠ 未运行 raw-files 条件 —— 无法区分「STRATA 有用」与「多给上下文有用」。')
    console.log('    强烈建议补跑：--conditions no-context,raw-files,strata')
  }

  console.log('')
  console.log('── 必须写进结论的限制 ──')
  console.log('  · 样本量小的时候差异可能是噪声 —— 看上面的 95% CI 是否重叠。')
  console.log('  · 用历史提交当任务会泄漏：模型可能预训练见过公开仓库的提交。')
  console.log('  · 三条件的上下文长度不同 —— raw-files 条件就是为控制它而设的。')
  console.log('  · 单次运行不能排除 Agent 随机性 —— 用 --repeat 增加重复。')
  console.log('')

  const outPath = join(resultsDir, 'report.json')
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), records: records.length, stats: Object.fromEntries(stats), recordsDetail: records },
      null,
      2,
    ),
  )
  console.log(`已写出 ${outPath}`)
}

/* ============================== 入口 ============================== */

const COMMANDS = { init: cmdInit, run: cmdRun, report: cmdReport }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log('STRATA bench —— 有/无 STRATA 的对照自测')
    console.log('')
    console.log('用法：')
    console.log('  node scripts/bench.mjs init   --repo <仓库> --out bench/tasks [--limit 10] [--verify-cmd "<命令>"]')
    console.log('  node scripts/bench.mjs run    --tasks bench/tasks --out bench/results')
    console.log('                                [--conditions no-context,raw-files,strata] [--repeat 3]')
    console.log('                                [--agent-cmd \'my-agent --prompt-file {prompt} --cwd {cwd}\']')
    console.log('  node scripts/bench.mjs report --results bench/results')
    console.log('')
    console.log('三个条件：')
    console.log('  no-context  只给任务描述')
    console.log('  raw-files   给相关文件源码       ← 控制「上下文量」这个混淆变量')
    console.log('  strata      给索引与约束          ← 被测对象')
    console.log('')
    console.log('判定命令必须满足：**在 baseRef 上失败，在真实提交上通过**。')
    process.exit(cmd ? 1 : 0)
  }
  await fn()
}

export { wilson, buildPrompt }
