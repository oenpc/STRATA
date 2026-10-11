#!/usr/bin/env node
/**
 * 会话指标提取器（STRATA 的实验数据管道）。
 *
 * 用途：把 Agent 会话日志（zstd 多帧 JSONL）变成 STRATA 框架 E1–E4 需要的可测数据，
 * 尤其是 **E3（判决层是否必要）** —— "同一条约定，散文形式 vs 可执行形式，复发率差多少"。
 *
 * ## 为什么需要它
 *
 * STRATA 的核心主张必须由真实开发过程的数据检验，而会话日志是唯一的原始记录
 * （git 历史可能被压缩过，且 git 本身不记"Agent 当时看到了什么规则"）。
 *
 * ## 输入格式
 *
 * 本脚本读的是 **JSONL 记录流**，每行一个 JSON 对象，整体再用 **zstd 多帧**压缩。
 * 记录类型形如 `turn/start`、`tool/call`、`step/end`，字段见下。这是
 * **DeepSeek Harness (DSH)** 的会话日志格式；若你用别的 Agent 运行器，
 * 按同样的记录类型转换即可（见 `docs/adapting-logs.md` 的字段表）。
 *
 * ## 日志格式的关键坑（实测，非文档）
 *
 * 文件是 **多个 zstd 帧顺序拼接**，不是单个流：
 *   · `zstdDecompressSync(buf)` 只解**第一帧**（会话头），静默忽略其余
 *   · 必须用 `{ info: true }` 取 `engine.bytesWritten` 逐帧推进
 *   · 每帧解出 1..n 行 JSONL
 * 这个格式没有文档，是靠试错确定的（`createZstdDecompress` 流式解压会报
 * `prefix_unknown`，因为多帧拼接不被接受）。
 *
 * ## 用法
 *
 *   node scripts/research/.mjs <文件或目录> [--json <输出路径>]
 *   node scripts/research/.mjs --all [--sessions-dir <目录>] [--filter <正则>]
 *
 *   --all            递归扫描 --sessions-dir 下所有 *.zstd
 *   --sessions-dir   日志根目录（默认 ~/.dsh/sessions）
 *   --filter         只处理路径匹配该正则的会话（默认全部）
 *
 * 例：
 *   node scripts/research/.mjs --all --sessions-dir ~/logs --filter 'myproject'
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/* ------------------------------ 日志读取 ------------------------------ */

/**
 * 逐帧解压一个 .zstd 会话文件。
 *
 * 关键：`zstdDecompressSync` 一次只吃一帧，`engine.bytesWritten` 给出该帧的
 * **压缩侧字节数**，用它推进偏移。若某帧解压失败即停止（尾部可能被截断）。
 */
export function decodeSession(buffer) {
  const records = []
  let offset = 0
  let frames = 0
  let stopReason = null

  while (offset < buffer.length) {
    let frame
    try {
      frame = zstdDecompressSync(buffer.subarray(offset), { info: true })
    } catch (error) {
      stopReason = `解压失败于偏移 ${offset}: ${error?.code ?? error?.message}`
      break
    }
    const used = frame.engine?.bytesWritten ?? 0
    if (used <= 0) {
      stopReason = `帧长为 0，偏移 ${offset}`
      break
    }
    offset += used
    frames += 1

    for (const line of frame.buffer.toString('utf8').split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        records.push(JSON.parse(text))
      } catch {
        /* 帧边界切开了半行 —— 忽略，不猜测拼接 */
      }
    }
  }

  if (offset < buffer.length && !stopReason) stopReason = `尾部剩余 ${buffer.length - offset} 字节`
  return { records, frames, consumed: offset, total: buffer.length, stopReason }
}

/* ------------------------------ 指标提取 ------------------------------ */

/** 从一批记录里提取 STRATA 需要的指标。 */
export function extractMetrics(records) {
  const metrics = {
    session: null,
    turns: 0,
    steps: 0,
    userMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
    toolByName: {},
    turnReasons: {},
    tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, samples: 0 },
    compactions: 0,
    perTurn: [],
  }

  /** 逐轮聚合：turn → { tools, tokens, errors } */
  const byTurn = new Map()
  const turnOf = (n) => {
    if (!byTurn.has(n)) byTurn.set(n, { turn: n, tools: {}, tokens: 0, output: 0, errors: 0 })
    return byTurn.get(n)
  }

  for (const rec of records) {
    const type = rec.type ?? ''
    const data = rec.data ?? {}

    switch (type) {
      case 'session':
        metrics.session = {
          id: rec.id,
          cwd: rec.cwd,
          createdAt: rec.createdAt,
          agentPreset: rec.agentPreset,
        }
        break
      case 'turn/start':
        metrics.turns += 1
        break
      case 'turn/end':
        metrics.turnReasons[data.reason?.kind ?? 'unknown'] =
          (metrics.turnReasons[data.reason?.kind ?? 'unknown'] ?? 0) + 1
        break
      case 'step/start':
        metrics.steps += 1
        break
      case 'user/message':
        metrics.userMessages += 1
        break
      case 'tool/call': {
        metrics.toolCalls += 1
        const name = data.name ?? '(未知)'
        metrics.toolByName[name] = (metrics.toolByName[name] ?? 0) + 1
        const bucket = turnOf(data.turn)
        bucket.tools[name] = (bucket.tools[name] ?? 0) + 1
        break
      }
      case 'tool/result': {
        metrics.toolResults += 1
        const isError = Boolean(data.message?.content?.[0]?.isError)
        if (isError) {
          metrics.errors += 1
          const bucket = turnOf(data.turn ?? 0)
          bucket.errors += 1
        }
        break
      }
      case 'compaction/start':
        metrics.compactions += 1
        break
      default:
        break
    }

    /* token 用量可能嵌在多处（usage / stream.*.chunk.usage），统一递归找 */
    collectUsage(rec, (usage, turn) => {
      metrics.tokens.input += usage.inputTokens ?? 0
      metrics.tokens.output += usage.outputTokens ?? 0
      metrics.tokens.cacheRead += usage.cacheReadTokens ?? 0
      metrics.tokens.reasoning += usage.reasoningTokens ?? 0
      metrics.tokens.total += usage.totalTokens ?? 0
      metrics.tokens.samples += 1
      if (turn !== undefined) {
        const bucket = turnOf(turn)
        bucket.tokens += usage.totalTokens ?? 0
        bucket.output += usage.outputTokens ?? 0
      }
    })
  }

  metrics.perTurn = [...byTurn.values()].sort((a, b) => a.turn - b.turn)
  return metrics
}

/** 递归找 usage 对象；避免把同一个 usage 计入两次（只取顶层出现的那份）。 */
function collectUsage(node, onUsage, depth = 0, turn) {
  if (!node || typeof node !== 'object' || depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) collectUsage(item, onUsage, depth + 1, turn)
    return
  }
  const nextTurn = typeof node.turn === 'number' ? node.turn : turn
  if (node.usage && typeof node.usage === 'object' && typeof node.usage.totalTokens === 'number') {
    onUsage(node.usage, nextTurn)
    /* 命中后不再深入 usage 内部，避免 stream.*.chunk.usage 重复计数 */
    for (const [k, v] of Object.entries(node)) {
      if (k === 'usage') continue
      collectUsage(v, onUsage, depth + 1, nextTurn)
    }
    return
  }
  for (const v of Object.values(node)) collectUsage(v, onUsage, depth + 1, nextTurn)
}

/* ------------------------------ 报告输出 ------------------------------ */

function fmtInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function reportOne(file) {
  const buffer = readFileSync(file)
  const { records, frames, stopReason } = decodeSession(buffer)
  const m = extractMetrics(records)

  const topTools = Object.entries(m.toolByName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)

  console.log('── ' + basename(dirname(file)) + '/' + basename(file))
  console.log(`   压缩 ${(buffer.length / 1024 / 1024).toFixed(1)}MB · ${frames} 帧 · ${records.length} 记录`)
  if (m.session) console.log(`   仓库 ${m.session.cwd ?? '(未知)'} · 预设 ${m.session.agentPreset ?? '-'}`)
  console.log(
    `   轮次 ${m.turns} · 步 ${m.steps} · 用户消息 ${m.userMessages} · 工具调用 ${fmtInt(m.toolCalls)} · 错误 ${m.errors}`,
  )
  console.log(
    `   token: in ${fmtInt(m.tokens.input)} / out ${fmtInt(m.tokens.output)} / cacheRead ${fmtInt(m.tokens.cacheRead)} / 合计 ${fmtInt(m.tokens.total)}`,
  )
  if (m.compactions) console.log(`   压缩 ${m.compactions} 次`)
  console.log('   工具: ' + topTools.map(([k, v]) => `${k}×${v}`).join('  '))
  if (stopReason) console.log(`   ⚠ ${stopReason}`)
  console.log('')

  return { file, frames, records: records.length, metrics: m }
}

/**
 * 递归收集会话日志，并按会话去重。
 *
 * @param {string} root   日志根目录
 * @param {RegExp|null} filter  只保留路径匹配该正则的日志
 *
 * **为什么要去重**：同一会话会留下多份**快照**（如 `session.v3.jsonl.zstd`、
 * `session.v4.jsonl.zstd`）。实测低版本内容是高版本的**字节前缀**，
 * 因此逐个文件统计会把同一事件**重复计入**。这里按"会话目录"去重，
 * 只保留版本号最高的那一份。
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
      /* 快照版本：session.vN.jsonl.zstd 里取 N；无版本记 0 */
      const v = /\.v(\d+)$/.exec(m[1])
      const version = v ? Number(v[1]) : 0
      const key = dir // 同一会话目录 = 同一 key
      const prev = perSession.get(key)
      if (!prev || version > prev.version) perSession.set(key, { file: full, version })
    }
  }

  walk(root)
  return [...perSession.values()].map((v) => v.file).sort()
}

/* ------------------------------ 入口 ------------------------------ */

/*
 * 只在**被直接执行**时跑主流程。
 * 本文件同时是可 import 的库（导出 decodeSession / extractMetrics），
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

  /* 位置参数 = 显式指定的文件/目录；要跳过所有 `--flag value` 的值 */
  const valueIdx = new Set(
    ['--json', '--sessions-dir', '--filter']
      .map((f) => args.indexOf(f))
      .filter((i) => i >= 0)
      .map((i) => i + 1),
  )
  const targets = args.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i))

  let files = []
  if (args.includes('--all') || targets.length === 0) {
    files = findSessionFiles(sessionsDir, filter)
    console.log(`日志目录 ${sessionsDir}`)
    console.log(`扫描到 ${files.length} 个会话日志（已按会话去重快照）`)
    console.log('')
  } else {
    for (const target of targets) {
      if (statSync(target).isDirectory()) {
        files.push(...findSessionFiles(target, filter))
      } else {
        files.push(target)
      }
    }
  }

  if (files.length === 0) {
    console.error('没有找到会话日志。')
    console.error('用法：node scripts/research/.mjs <文件或目录> [--json <输出>]')
    console.error('      node scripts/research/.mjs --all [--sessions-dir <目录>] [--filter <正则>]')
    process.exit(1)
  }

  const results = []
  for (const file of files) results.push(reportOne(file))

  /* 汇总 */
  const sum = results.reduce(
    (acc, r) => {
      acc.turns += r.metrics.turns
      acc.toolCalls += r.metrics.toolCalls
      acc.errors += r.metrics.errors
      acc.tokens += r.metrics.tokens.total
      acc.output += r.metrics.tokens.output
      for (const [k, v] of Object.entries(r.metrics.toolByName)) acc.tools[k] = (acc.tools[k] ?? 0) + v
      return acc
    },
    { turns: 0, toolCalls: 0, errors: 0, tokens: 0, output: 0, tools: {} },
  )

  console.log('════ 汇总 ════')
  console.log(`  会话 ${results.length} 个 · 轮次 ${sum.turns} · 工具调用 ${fmtInt(sum.toolCalls)}`)
  console.log(`  token 合计 ${fmtInt(sum.tokens)} · 输出 ${fmtInt(sum.output)}`)
  console.log(
    '  工具分布: ' +
      Object.entries(sum.tools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, v]) => `${k}×${v}`)
        .join('  '),
  )

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true })
    writeFileSync(
      jsonOut,
      JSON.stringify({ generatedAt: new Date().toISOString(), summary: sum, results }, null, 2),
    )
    console.log('')
    console.log('已写出 JSON: ' + jsonOut)
  }
}
