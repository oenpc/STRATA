#!/usr/bin/env node
/**
 * STRATA measure —— 在任何仓库上静态测量「面」的适用性。
 *
 * 为什么先跑这个：STRATA 的核心主张只在**面密集**的仓库里成立。
 * 如果 κ < 0.3，面已经退化成文件，这个方法对你无效 —— 早发现比晚发现便宜。
 *
 * 不需要 Agent、不需要会话日志、不需要 LLM。只需要一个 git 仓库。
 *
 * ## 四个指标
 *
 *   |F|     参与统计的文件数
 *   |faces| 用到的面数（面 = ⟨层, 域⟩）
 *   κ       **共享面覆盖率**：与至少一个其他文件同面的文件比例 ← 主指标
 *   γ       **规则增长系数**：新增文件里"需要一个新面"的比例
 *
 * κ 高 = 面是有效的压缩；γ 低 = 新文件大多落在已有的面上。
 * **两者都好，方法才适用。**
 *
 * ## 用法
 *
 *   node scripts/measure.mjs --root <仓库路径> [选项]
 *
 *   --root <dir>     仓库根目录（默认当前目录）
 *   --depth <n>      用目录前 n 段作为「域」的代理（默认 2）
 *   --layers <list>  自定义层取值，逗号分隔
 *   --domains <list> 自定义域取值，逗号分隔
 *   --ext <list>     参与统计的扩展名（默认常见源码扩展名）
 *   --json <path>    把结果写成 JSON
 *   --no-git         跳过 γ（γ 需要 git 历史）
 *
 * ## 关于 --layers / --domains
 *
 * 若不提供，脚本用**目录结构**近似：第 1 段是层，前 `--depth` 段拼起来是域。
 * 这只是**代理** —— 真正的字典应当由人按项目语义定义（见 templates/instance-index.md）。
 * 代理足够用来判断"方法是否适用"，不足以用来生成正式索引。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2)
const opt = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const has = (flag) => args.includes(flag)

const ROOT = opt('--root', process.cwd())
const DEPTH = Number(opt('--depth', '2'))
const JSON_OUT = opt('--json')
const USE_GIT = !has('--no-git')

const DEFAULT_EXT = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'php', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'sql', 'sh', 'ps1', 'lua', 'ex',
]

const EXT = new Set(
  (opt('--ext') ? opt('--ext').split(',') : DEFAULT_EXT).map((e) => e.trim().replace(/^\./, '').toLowerCase()),
)

const customLayers = opt('--layers') ? opt('--layers').split(',').map((s) => s.trim()) : null
const customDomains = opt('--domains') ? opt('--domains').split(',').map((s) => s.trim()) : null

/** 不该进入统计的目录 */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  'target', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.output',
  'release', 'tmp', '.tmp', '.cache',
])

/* ------------------------------ 扫描文件 ------------------------------ */

function collectFiles(root) {
  const files = []
  const walk = (dir) => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      if (SKIP_DIR.has(item.name)) continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      const dot = item.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = item.name.slice(dot + 1).toLowerCase()
      if (!EXT.has(ext)) continue
      files.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return files.sort()
}

/* ------------------------------ 面推断 ------------------------------ */

/**
 * 把一个路径映射到 ⟨层, 域⟩。
 * 优先用显式字典（若提供），否则用目录结构代理。
 */
function faceOf(path, depth) {
  const parts = path.split('/')
  const dirs = parts.slice(0, -1) // 去掉文件名

  if (customLayers && customDomains) {
    const layer = customLayers.find((l) => dirs.includes(l)) ?? '(unknown)'
    const domain = customDomains.find((d) => dirs.includes(d)) ?? '(unknown)'
    return { layer, domain, face: `${layer}·${domain}` }
  }

  if (dirs.length === 0) return { layer: '(root)', domain: '(root)', face: '(root)·(root)' }

  const layer = dirs[0]
  const domain = dirs.slice(0, Math.max(1, depth)).join('/')
  return { layer, domain, face: `${layer}·${domain}` }
}

/* ------------------------------ 指标 ------------------------------ */

function computeMetrics(files, depth) {
  const byFace = new Map()
  for (const f of files) {
    const { face } = faceOf(f, depth)
    if (!byFace.has(face)) byFace.set(face, [])
    byFace.get(face).push(f)
  }

  const shared = [...byFace].filter(([, v]) => v.length >= 2)
  const singleton = [...byFace].filter(([, v]) => v.length === 1)
  const coveredByShared = shared.reduce((s, [, v]) => s + v.length, 0)

  return {
    files: files.length,
    faces: byFace.size,
    facePerFile: byFace.size / Math.max(1, files.length),
    sharedFaces: shared.length,
    singletonFaces: singleton.length,
    kappa: coveredByShared / Math.max(1, files.length),
    byFace,
    shared,
    singleton,
  }
}

/* ------------------------------ γ（规则增长系数）------------------------------ */

/**
 * 从 git 历史求 γ：**新增文件落在"首次出现的面"上的比例**。
 *
 * 这是 STRATA 成本定理的直接检验：
 *   · 若新文件大多落在**已有的面**上 → 面锚定下不需要新规则 → γ ≈ 0
 *   · 若新文件大多带来**新的面**       → 面锚定无收益       → γ ≈ 1
 */
function computeGamma(root, depth) {
  let log
  try {
    log = execFileSync(
      'git',
      ['-C', root, 'log', '--reverse', '--diff-filter=A', '--name-only', '--pretty=format:__C__%H'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    )
  } catch (error) {
    return { ok: false, reason: `git 不可用或不是仓库：${String(error.message).slice(0, 80)}` }
  }

  const seenFaces = new Set()
  let added = 0
  let newFace = 0
  const samples = []

  let commit = null
  for (const raw of log.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('__C__')) {
      commit = line.slice(5, 12)
      continue
    }
    const dot = line.lastIndexOf('.')
    if (dot < 0) continue
    if (!EXT.has(line.slice(dot + 1).toLowerCase())) continue
    /* 跳过被忽略目录里的路径 */
    if (line.split('/').some((seg) => SKIP_DIR.has(seg))) continue

    added += 1
    const { face } = faceOf(line, depth)
    if (!seenFaces.has(face)) {
      seenFaces.add(face)
      newFace += 1
      if (samples.length < 8) samples.push({ commit, file: line, face })
    }
  }

  if (added === 0) return { ok: false, reason: 'git 历史里没有新增源码文件' }
  return { ok: true, added, newFace, gamma: newFace / added, facesSeen: seenFaces.size, samples }
}

/* ------------------------------ 输出 ------------------------------ */


/* ------------------------------ 入口 ------------------------------ */

/*
 * 只在**被直接执行**时跑主流程。
 * 本文件同时是可 import 的库（导出 collectFiles / faceOf / computeMetrics / computeGamma），
 * 若无条件执行，await import(...) 会打印整份报告 —— 对调用方是意外副作用。
 */
function main() {
  const files = collectFiles(ROOT)
  if (files.length === 0) {
    console.error(`在 ${ROOT} 下没找到源码文件（可用 --ext 指定扩展名）。`)
    process.exit(1)
  }

  const m = computeMetrics(files, DEPTH)
  const gamma = USE_GIT ? computeGamma(ROOT, DEPTH) : { ok: false, reason: '已用 --no-git 跳过' }

  const pct = (x) => (x * 100).toFixed(1) + '%'
  const bar = (x, width = 24) => '█'.repeat(Math.round(x * width)).padEnd(width, '·')

  console.log('')
  console.log('STRATA measure')
  console.log('  root  : ' + ROOT)
  console.log('  depth : ' + DEPTH + (customLayers ? '  (显式字典)' : '  (目录结构代理)'))
  console.log('')
  console.log('── 规模 ──')
  console.log(`  文件 |F|     ${m.files}`)
  console.log(`  面   |faces| ${m.faces}`)
  console.log(`  面/文件      ${m.facePerFile.toFixed(3)}`)
  console.log('')
  console.log('── 共享面分布 ──')
  console.log(`  共享面（≥2 文件）  ${String(m.sharedFaces).padStart(4)}  ${bar(m.sharedFaces / m.faces)}`)
  console.log(`  单文件面           ${String(m.singletonFaces).padStart(4)}  ${bar(m.singletonFaces / m.faces)}`)
  console.log('')
  console.log('── 主指标：κ（共享面覆盖率）──')
  console.log(`  κ = ${m.kappa.toFixed(3)}   ${bar(m.kappa)}  ${pct(m.kappa)}`)
  console.log('')

  let verdict
  if (m.kappa >= 0.5) verdict = '适用 —— 面是有效的压缩，按 quickstart 落地'
  else if (m.kappa >= 0.3) verdict = '部分适用 —— 只在密集区域有收益；报告结论时必须限定范围'
  else verdict = '不适用 —— 面已退化为文件；只用判决层（quickstart §5），或换项目'
  console.log(`  判定：${verdict}`)

  /*
   * ⚠️ 必须声明的局限。
   *
   * 用**目录结构**当面的代理时，κ 会**系统性偏高**：
   * "同一目录下的文件同面"是构造上必然的，因此这里的 κ 只是**上界**，
   * 不具区分力 —— 实测同一仓库在 depth=1..4 下 κ 恒在 0.94–0.99。
   *
   * 所以本工具**不能**单独用 κ 下结论。真正的 κ 要用**你按语义定义的字典**来测。
   */
  if (!customLayers) {
    console.log('')
    console.log('  ⚠ 上界警告：本数值用「目录结构」代理面，会系统性偏高。')
    console.log('     同目录 ⇒ 同面 是构造上必然的，所以它是**上界**，不是估计值。')
    console.log('     要得到有意义的 κ，请用 --layers/--domains 传入你自己的字典。')
  }

  /* 目录规模画像：帮用户判断字典该定义在哪一层 */
  const topDirs = new Map()
  for (const f of files) {
    const p = f.split('/')
    const key = p.length > 1 ? p[0] : '(root)'
    topDirs.set(key, (topDirs.get(key) ?? 0) + 1)
  }
  const sortedDirs = [...topDirs].sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.log('')
  console.log('── 顶层目录规模（字典的候选切分点）──')
  for (const [d, n] of sortedDirs) {
    console.log(`  ${String(n).padStart(5)}  ${d}  ${bar(n / Math.max(...sortedDirs.map((x) => x[1])))}`)
  }
  console.log('  目录越大越值得为它细分「域」；只有一两个文件的目录是单文件面，收益为零。')


  if (gamma.ok) {
    console.log('')
    console.log('── γ（规则增长系数，来自 git 历史）──')
    console.log(`  新增源码文件      ${gamma.added}`)
    console.log(`  其中带来新面      ${gamma.newFace}`)
    console.log(`  γ = ${gamma.gamma.toFixed(3)}   ${bar(gamma.gamma)}`)
    console.log('')
    console.log('  读法：γ 是"新增文件里需要一个新面的比例"。')
    console.log('        面锚定下，只有这些文件才需要新规则 —— γ 越低收益越大。')
    if (gamma.samples.length) {
      console.log('')
      console.log('  带来新面的前几个文件（这些面值得先定义）:')
      for (const s of gamma.samples) console.log(`    ${s.commit}  ${s.face.padEnd(28)} ${s.file}`)
    }
  } else {
    console.log('')
    console.log(`── γ 未计算：${gamma.reason}`)
  }

  console.log('')
  console.log(`提示：本测量用${customLayers ? '显式字典' : '目录结构代理'}推断面。`)
  console.log('      代理足以判断"方法是否适用"，不足以生成正式索引 ——')
  console.log('      正式字典应按项目语义人工定义，见 templates/instance-index.md。')
  console.log('')

  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true })
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          root: ROOT,
          generatedAt: new Date().toISOString(),
          depth: DEPTH,
          dictionary: customLayers ? { layers: customLayers, domains: customDomains } : 'directory-proxy',
          metrics: {
            files: m.files,
            faces: m.faces,
            facePerFile: m.facePerFile,
            sharedFaces: m.sharedFaces,
            singletonFaces: m.singletonFaces,
            kappa: m.kappa,
          },
          gamma,
          faces: [...m.byFace].map(([face, list]) => ({ face, count: list.length, files: list })),
        },
        null,
        2,
      ),
    )
    console.log('已写出 JSON: ' + JSON_OUT)
  }

}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()

export { collectFiles, faceOf, computeMetrics, computeGamma }
