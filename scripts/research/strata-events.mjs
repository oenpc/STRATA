#!/usr/bin/env node
/**
 * E3 事件提取：在会话日志里**模式匹配**已知陷阱，并记录**当时是否存在可执行检查器**。
 *
 * ## ⚠️ 输出是「模式匹配」，不是「确认的违规」
 *
 * 检测器匹配的是**形态**（例如"模板字面量内的注释里出现反引号"），
 * 而不是"确实产生了语法错误"。**反引号成对时并不构成语法错误** ——
 * 实测：把该形态注入一个真实文件后，可执行检查器（Node 解析器）报告通过（0 / 2 抓住），
 * 因为注入的反引号与文件里已有的反引号配平了。
 *
 * **所以这个数字会高估。真实违规数 ≤ 匹配数，且本脚本不测真实值。**
 * 报告时必须写"模式匹配 N 次"，不能写"违规 N 次"。
 *
 * ## 为什么要这样设计
 *
 * STRATA 的 E3 主张是"只有可机检的约束真正改变 Agent 行为"。
 * 要做到因果严谨，需要三段时间线：
 *
 *   t0  陷阱首次发生
 *   t1  规则被写入约定文档（散文形式）
 *   t2  可执行检查器出现（如一条 `npm run check` 命令）
 *
 * 于是可以对照：t0–t1（无规则）、t1–t2（散文规则）、t2 之后（可执行）三段的复发率。
 *
 * ## 方法上的诚实前提（必须在论文里写明）
 *
 * 会话日志是**观察性数据**，不是对照实验。因此本脚本**只报告事件与时间线**，
 * **不做因果推断**。因果结论只能由 E1–E4 的对照实验给出。
 * 本脚本产出的是"值得做实验证实的现象"。
 *
 * ## ⚠️ 你需要自己定义陷阱（`PITFALLS`）
 *
 * 脚本里的 `PITFALLS` 是**随包附带的示例**，取自起源案例。
 * 它们**不通用** —— 你必须按自己项目的实际踩坑情况替换 `detect()`。
 * 不用心的 `detect()` 会产出噪声，比没有更糟。
 *
 * ## 检测的两类证据
 *
 *   1. **文本证据**：工具调用参数里出现陷阱特征的字符串
 *      （如 `edit` 的 new_string 含反引号 —— 反引号陷阱）
 *   2. **时序证据**：该会话记录的时间戳与规则/检查器的引入时刻比较
 *
 * 用法：
 *   node scripts/research/.mjs [--json <路径>]
 *   node scripts/research/.mjs --sessions-dir <目录> [--filter <正则>]
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

/* ------------------------------ 复用的解码 ------------------------------ */

function decodeSessionFile(file) {
  const buffer = readFileSync(file)
  const records = []
  let offset = 0
  let frames = 0
  while (offset < buffer.length) {
    let frame
    try {
      frame = zstdDecompressSync(buffer.subarray(offset), { info: true })
    } catch {
      break
    }
    const used = frame.engine?.bytesWritten ?? 0
    if (used <= 0) break
    offset += used
    frames += 1
    for (const line of frame.buffer.toString('utf8').split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        records.push(JSON.parse(text))
      } catch {
        /* 半行，忽略 */
      }
    }
  }
  return { records, frames, bytes: buffer.length }
}

/* ------------------------------ 陷阱定义 ------------------------------ */

const BT = String.fromCharCode(96)

/**
 * 陷阱定义**留空** —— 你必须自己填（或从 `examples/pitfalls-*.mjs` 载入）。
 *
 * 每条陷阱给出：
 *   · `detect(args, toolName)` —— 从一次工具调用判断是否踩中
 *   · `ruleForm`  —— 它当时的**散文**形态（规则写在哪个文档里）
 *   · `checkForm` —— 它当时的**可执行**形态（哪条命令能判它）
 *
 * **为什么留空而不内置示例**：任何具体项目的陷阱都不是通用的。
 * 把一个项目的规则文本内置进来，会让工具看起来像是那个项目的附件，
 * 也会误导使用者以为那些检测器可以直接用。
 *
 * 两条纪律：
 *   1. 只定义**能被机检**的陷阱。"需求理解偏差"这类主观问题无法在日志里
 *      可靠识别，硬检测会产出噪声 —— 不要放进来。
 *   2. `detect()` 匹配的是**形态**，不一定等于**确认的违规**。
 *      报告时必须写"模式匹配 N 次"，不能写"违规 N 次"（见文件头警告）。
 */
let PITFALLS = []

/** 载入外部陷阱定义模块（`--pitfalls <路径>`）。 */
async function loadPitfalls(path) {
  const mod = await import(pathToFileURL(path).href)
  const list = mod.PITFALLS ?? mod.default ?? []
  if (!Array.isArray(list)) throw new Error(`${path} 未导出 PITFALLS 数组`)
  for (const p of list) {
    if (!p?.id || typeof p.detect !== 'function') {
      throw new Error(`${path} 里每条陷阱必须有 id 与 detect()`)
    }
  }
  return list
}

/* ------------------------------ 事件提取 ------------------------------ */

/**
 * 判定一个工具调用是否"跑了检查器"。
 *
 * 默认用一组**通用关键词**（check / lint / test / verify），可用
 * `--checker-pattern <正则>` 覆盖。**刻意不内置任何具体项目的命令名。**
 */
function isCheckerRun(args, toolName, pattern) {
  if (!/shell|bash|zsh|pwsh|powershell|exec|run/i.test(toolName)) return false
  const cmd = String(args.command ?? args.cmd ?? args.script ?? '')
  if (!cmd) return false
  return pattern.test(cmd)
}

function scanSession(file, pitfalls, checkerPattern) {
  const { records, frames, bytes } = decodeSessionFile(file)
  const events = []
  let checkerRuns = 0
  let sessionMeta = null

  for (const rec of records) {
    if (rec.type === 'session') sessionMeta = { cwd: rec.cwd, createdAt: rec.createdAt, id: rec.id }
    if (rec.type !== 'tool/call') continue

    const data = rec.data ?? {}
    let args = {}
    try {
      args = data.arguments ? JSON.parse(data.arguments) : {}
    } catch {
      args = {}
    }

    if (isCheckerRun(args, data.name, checkerPattern)) checkerRuns += 1

    for (const p of pitfalls) {
      if (p.detect(args, data.name)) {
        events.push({
          pitfall: p.id,
          time: rec.time,
          turn: data.turn,
          step: data.step,
          tool: data.name,
          seq: rec.seq,
        })
      }
    }
  }

  return { file, frames, bytes, sessionMeta, checkerRuns, events }
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 递归收集会话日志，并按会话去重（只保留快照版本最高的那一份）。
 *
 * @param {string} root   日志根目录
 * @param {RegExp|null} filter  只保留路径匹配该正则的日志
 */
function findSessionFiles(root, filter = null) {
  /** @type {Map<string, {file: string, version: number}>} */
  const perSession = new Map()

  const walk = (dir) => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      const m = /^(.+)\.jsonl\.zstd$/.exec(item.name)
      if (!m) continue
      if (filter && !filter.test(full)) continue
      const v = /\.v(\d+)$/.exec(m[1])
      const version = v ? Number(v[1]) : 0
      const prev = perSession.get(dir)
      if (!prev || version > prev.version) perSession.set(dir, { file: full, version })
    }
  }

  walk(root)
  return [...perSession.values()].map((v) => v.file).sort()
}

/*
 * 只在**被直接执行**时跑主流程。
 * 本文件的主要产物可被 import 复用（PITFALLS / 判定逻辑），
 * 若无条件执行，await import(...) 会触发一次全量扫描 —— 对调用方是意外副作用。
 */
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const args = process.argv.slice(2)

  /** 取 `--flag value` 形式的参数值 */
  const optValue = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : null
  }

  const jsonOut = optValue('--json')
  const sessionsDir = optValue('--sessions-dir') ?? join(homedir(), '.dsh', 'sessions')
  const filterRaw = optValue('--filter')
  const filter = filterRaw ? new RegExp(filterRaw, 'i') : null

  /* 陷阱定义：外部模块（推荐）或内置（默认空） */
  const pitfallsPath = optValue('--pitfalls')
  if (pitfallsPath) {
    PITFALLS = await loadPitfalls(pitfallsPath)
    console.log(`陷阱定义：${pitfallsPath}（${PITFALLS.length} 条）`)
  } else {
    console.log('陷阱定义：**空** —— 用 --pitfalls <路径> 载入你自己的定义。')
    console.log('           参考 examples/pitfalls-example.mjs 的写法。')
  }

  /* 检查器命令的识别模式：通用关键词，或用户指定 */
  const checkerRaw = optValue('--checker-pattern')
  const checkerPattern = checkerRaw
    ? new RegExp(checkerRaw, 'i')
    : /\b(check|lint|test|verify|validate|typecheck)\b/i

  const files = findSessionFiles(sessionsDir, filter)
  console.log(`日志目录 ${sessionsDir}`)
  console.log(`扫描 ${files.length} 个会话日志（已按会话去重快照）`)
  console.log('')

  const results = []
  for (const file of files) {
    try {
      results.push(scanSession(file, PITFALLS, checkerPattern))
    } catch (error) {
      console.log(`  ✗ ${file}: ${error?.message}`)
    }
  }

  /* 汇总 */
  const byPitfall = new Map()
  let totalCheckerRuns = 0
  for (const r of results) {
    totalCheckerRuns += r.checkerRuns
    for (const e of r.events) {
      if (!byPitfall.has(e.pitfall)) byPitfall.set(e.pitfall, [])
      byPitfall.get(e.pitfall).push({ ...e, file: r.file, cwd: r.sessionMeta?.cwd })
    }
  }

  console.log('════ 陷阱模式匹配事件（非确认违规）════')
  for (const p of PITFALLS) {
    const list = (byPitfall.get(p.id) ?? []).sort((a, b) => a.time - b.time)
    console.log('')
    console.log(`── ${p.name}  （模式匹配 ${list.length} 次，真实违规数 ≤ 此值）`)
    console.log(`   规则形态 : ${p.ruleForm}`)
    console.log(`   检查形态 : ${p.checkForm}`)
    if (list.length === 0) {
      console.log('   未检出')
      continue
    }
    for (const e of list.slice(0, 12)) {
      const when = new Date(e.time).toISOString().replace('T', ' ').slice(0, 16)
      console.log(`   ${when}  轮${e.turn} 步${e.step}  ${e.tool}  ${String(e.cwd ?? '').split('\\').pop()}`)
    }
    if (list.length > 12) console.log(`   … 另 ${list.length - 12} 次`)
  }

  console.log('')
  console.log('════ 检查器运行次数 ════')
  console.log(`  检查器运行次数（匹配 --checker-pattern）: ${totalCheckerRuns}`)
  console.log('')
  console.log('⚠️  提醒：本输出是**观察性**数据，不可直接作因果结论。')
  console.log('   因果只能由对照实验（E3 的 C1/C2 条件）给出。')

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true })
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          note: '观察性数据，非对照实验；不作因果推断',
          pitfalls: PITFALLS.map((p) => ({ id: p.id, name: p.name, ruleForm: p.ruleForm, checkForm: p.checkForm })),
          totalCheckerRuns,
          occurrences: Object.fromEntries([...byPitfall].map(([k, v]) => [k, v])),
          sessions: results.map((r) => ({
            file: r.file,
            cwd: r.sessionMeta?.cwd,
            createdAt: r.sessionMeta?.createdAt,
            frames: r.frames,
            checkerRuns: r.checkerRuns,
            events: r.events.length,
          })),
        },
        null,
        2,
      ),
    )
    console.log('')
    console.log('已写出 JSON: ' + jsonOut)
  }

}