/**
 * 一次性修复：给会话日志里本插件写入的事件补上 `ignorable` 标记。
 *
 * @module dsh-gac-runtime/scripts/repair-session-events
 *
 * 为什么要修 —— 事故说明
 * ----------------------
 * 本插件曾经把 `gac/*` 事件写进会话日志（`session.append('gac/…', …)`）。宿主的事件词表是**构建期
 * 生成**的（`dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`），外部插件的类型按构造就不在其中，而
 * `Session.append()` 也没有任何途径给事件打上 `ignorable` 标记。持久化层读回日志时因此整份拒读：
 *
 *   session "…" contains event type "gac/…" (seq N) unknown to this harness and not marked
 *   ignorable; refusing to interpret the log
 *   （`dsh-session-persistence/lib/index.js` 的 `validateStoredEvents`）
 *
 * 于是**那份会话历史再也打不开**——界面上是「点进去就报错」。宿主为此留了出口：把记录标成
 * `ignorable: true`，它就作为**不参与重放**的日志项被保留（审计线索不丢），日志可以正常读回。
 * 这个脚本做的就是补那个标记；写入端已改为写工程自己的目录，不会再产生新的受害者。
 *
 * 用法
 * ----
 *   node scripts/repair-session-events.js                 # 只报告，不写盘
 *   node scripts/repair-session-events.js --apply          # 真的修（先备份再原子替换）
 *   node scripts/repair-session-events.js --dir <目录>     # 指定会话目录（默认 $DSH_HOME/sessions）
 *   node scripts/repair-session-events.js --only <子串>    # 只处理路径里含该子串的文件
 *
 * 安全约定：默认只报告；`--apply` 时每个文件先原样备份成 `<文件>.bak-gacrepair-<时间戳>`，再改。
 * **没有**改动的帧按字节原样复制，改动只落在需要改的那几帧上。
 */

import { copyFileSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数：日志是**多帧**追加的，一帧一次追加。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名。 */
export const SESSION_LOG_FILE = 'session.v4.jsonl.zstd'

/**
 * 一条记录是否需要补 `ignorable`。
 *
 * 判据刻意收窄到**本插件写过的类型**（`gac/` 前缀）：这是修复，不是重写别人的日志。宿主的头部记录
 * （`type: "session"`）与它自己的事件类型一律不碰。
 *
 * @param {object|undefined} record
 * @returns {boolean}
 */
export function needsIgnorable(record) {
  if (record === null || typeof record !== 'object') return false
  if (record.ignorable === true) return false
  return typeof record.type === 'string' && record.type.startsWith('gac/')
}

/**
 * 给一行日志补标记；不需要改的行**原样返回**（字节不变）。
 *
 * @param {string} line
 * @returns {string}
 */
export function markIgnorableLine(line) {
  if (line.trim() === '') return line
  let record
  try {
    record = JSON.parse(line)
  } catch {
    // 残缺行：原样留着，让读的人自己看见，而不是把它悄悄删掉。
    return line
  }
  if (!needsIgnorable(record)) return line
  return JSON.stringify({ ...record, ignorable: true })
}

/**
 * 按帧切开一段多帧 zstd 内容。
 *
 * @param {Buffer} raw
 * @returns {number[]} 每帧的起始偏移。
 */
function frameStarts(raw) {
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  return starts
}

/**
 * 处理一个会话日志文件。
 *
 * 活着的会话也在修之列，因此写入必须防住竞态：宿主的追加是往文件尾写帧的，而这里要整份重写。
 * 做法是重写之前**把期间新追加的字节原样接回**，循环到不再变化为止——否则「读过之后、改名之前」
 * 落下的那一帧会被静默丢掉，而丢的正是用户最新的对话。
 *
 * @param {string} file
 * @param {object} [options]
 * @param {boolean} [options.apply] - false 只统计不写盘。
 * @param {number} [options.now] - 备份文件名里的时间戳。
 * @param {() => void} [options.beforeWrite] - 只给测试用的接缝：在写盘之前插一下，用来模拟并发追加。
 * @returns {{file: string, frames: number, patched: number, undecodable: number, appended: number, backup?: string}}
 */
export function repairSessionLog(file, { apply = false, now = Date.now(), beforeWrite } = {}) {
  const raw = readFileSync(file)
  const starts = frameStarts(raw)
  const frames = []
  let patched = 0
  let undecodable = 0
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? raw.length
    const frame = raw.subarray(start, end)
    let text
    try {
      text = zstdDecompressSync(frame).toString('utf8')
    } catch {
      // 坏帧：原样复制。修日志的工具不该顺手丢掉读不出来的东西。
      undecodable += 1
      frames.push(frame)
      continue
    }
    const lines = text.split('\n')
    const next = lines.map(markIgnorableLine)
    if (next.every((line, i) => line === lines[i])) {
      frames.push(frame)
      continue
    }
    patched += next.filter((line, i) => line !== lines[i]).length
    frames.push(zstdCompressSync(Buffer.from(next.join('\n'), 'utf8')))
  }
  const result = { file, frames: starts.length, patched, undecodable, appended: 0 }
  if (!apply || patched === 0) return result

  const backup = `${file}.bak-gacrepair-${now}`
  copyFileSync(file, backup)
  // 同目录临时文件 + 改名：中途失败不会留下半截日志。
  const temporary = `${file}.repairing-${now}`
  const pieces = [...frames]
  let consumed = raw.length
  beforeWrite?.()
  // 把期间新追加的字节接回去（最多几轮：追加是零星的，一轮通常就够）。
  for (let round = 0; round < 5; round += 1) {
    const current = readFileSync(file)
    if (current.length <= consumed) break
    pieces.push(current.subarray(consumed))
    result.appended += current.length - consumed
    consumed = current.length
  }
  writeFileSync(temporary, Buffer.concat(pieces))
  renameSync(temporary, file)
  return { ...result, backup }
}

/**
 * 递归找出会话日志文件。
 *
 * @param {string} root
 * @param {string} [only] - 路径里必须包含的子串。
 * @returns {string[]}
 */
export function findSessionLogs(root, only) {
  const found = []
  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name !== SESSION_LOG_FILE) continue
      if (only !== undefined && !full.includes(only)) continue
      found.push(full)
    }
  }
  walk(root)
  return found
}

/**
 * 命令行入口。
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {number} 退出码。
 */
export function main(argv, env = process.env) {
  const apply = argv.includes('--apply')
  const dirIndex = argv.indexOf('--dir')
  const onlyIndex = argv.indexOf('--only')
  const root = dirIndex >= 0 && argv[dirIndex + 1] !== undefined
    ? argv[dirIndex + 1]
    : join(env.DSH_HOME ?? join(env.USERPROFILE ?? '.', '.dsh'), 'sessions')
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined

  if (!safeToScan(root)) {
    console.error(`会话目录不存在或不是目录：${root}`)
    return 1
  }
  const files = findSessionLogs(root, only)
  let changed = 0
  let totalPatched = 0
  for (const file of files) {
    const result = repairSessionLog(file, { apply })
    if (result.patched === 0) continue
    changed += 1
    totalPatched += result.patched
    console.log(`${apply ? '已修' : '待修'} ${result.patched} 条 / ${result.frames} 帧：${file}`)
    if (result.undecodable > 0) console.log(`  注意：有 ${result.undecodable} 帧解不开，已按字节原样保留`)
    if (result.backup !== undefined) console.log(`  备份：${result.backup}`)
  }
  console.log(
    `\n扫描 ${files.length} 个会话日志，${changed} 个需要修，共 ${totalPatched} 条记录。`
    + `${apply ? '' : '（这是预演；加 --apply 才会写盘）'}`,
  )
  return 0
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function safeToScan(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 直接执行时才跑 CLI；被测试 import 时不跑。
if (process.argv[1] !== undefined && process.argv[1].endsWith('repair-session-events.js')) {
  process.exitCode = main(process.argv.slice(2))
}
