/**
 * 会话日志修复工具的测试。
 *
 * 为什么这条必须存在：修复工具会**改写用户的会话日志**。没有测试的写盘脚本，一次错判就是把历史
 * 改坏；而且要断言的性质很具体——「只碰本插件写过的类型」「未改动的帧字节不变」「预演不写盘」
 * 「写盘前先备份」。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  findSessionLogs,
  markIgnorableLine,
  needsIgnorable,
  repairSessionLog,
  SESSION_LOG_FILE,
} from '../scripts/repair-session-events.js'

/**
 * 造一个**多帧**会话日志：一帧一次追加，和宿主写出来的形状一致。
 *
 * @param {object[]} frames - 每帧的记录数组。
 * @returns {Buffer}
 */
function writeMultiFrameLog(frames) {
  return Buffer.concat(frames.map((records) => zstdCompressSync(
    Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8'),
  )))
}

/**
 * @param {Buffer} raw
 * @returns {object[]}
 */
function readRecords(raw) {
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
  }
  const records = []
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? raw.length
    const text = zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim() !== '') records.push(JSON.parse(line))
    }
  }
  return records
}

describe('修复工具：只给本插件写过的事件补 ignorable', () => {
  it('认得出本插件的事件，也认得出已经标好的', () => {
    assert.equal(needsIgnorable({ type: 'gac/mode-declared', seq: 3 }), true)
    assert.equal(needsIgnorable({ type: 'gac/mode-declared', seq: 3, ignorable: true }), false)
    // 宿主自己的类型与头部记录一律不碰：这是修复，不是重写别人的日志。
    assert.equal(needsIgnorable({ type: 'turn/start', seq: 2 }), false)
    assert.equal(needsIgnorable({ type: 'session', version: 4 }), false)
    assert.equal(needsIgnorable(undefined), false)
  })

  it('不需要改的行原样返回；残缺行也原样留着', () => {
    const platform = '{"type":"turn/start","seq":2,"time":1}'
    assert.equal(markIgnorableLine(platform), platform)
    assert.equal(markIgnorableLine('{"type":"gac/'), '{"type":"gac/')
    const gac = '{"type":"gac/mode-declared","seq":3,"time":1,"data":{"mode":"standard_task"}}'
    const patched = JSON.parse(markIgnorableLine(gac))
    assert.equal(patched.ignorable, true)
    assert.equal(patched.data.mode, 'standard_task', '补标记不该动 data')
  })

  it('预演不写盘，--apply 才写，而且先备份', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gac-repair-'))
    const file = join(directory, SESSION_LOG_FILE)
    writeFileSync(file, writeMultiFrameLog([
      [{ type: 'session', version: 4, id: 's-1' }],
      [{ type: 'turn/start', seq: 1, time: 1 }],
      [{ type: 'gac/mode-declared', seq: 2, time: 2, data: { mode: 'standard_task' } }],
      [{ type: 'gac/task-created', seq: 3, time: 3, data: { task_id: 'R' } }],
    ]))

    const before = readFileSync(file)
    const dry = repairSessionLog(file, { apply: false, now: 111 })
    assert.equal(dry.patched, 2)
    assert.equal(dry.frames, 4)
    assert.deepEqual(readFileSync(file), before, '预演不得改动一个字节')
    assert.equal(readdirSync(directory).length, 1, '预演不得留下备份或临时文件')

    const applied = repairSessionLog(file, { apply: true, now: 222 })
    assert.equal(applied.patched, 2)
    assert.equal(applied.backup, `${file}.bak-gacrepair-222`)
    assert.deepEqual(readFileSync(applied.backup), before, '备份必须是原样')

    const records = readRecords(readFileSync(file))
    assert.equal(records.length, 4)
    assert.equal(records[0].type, 'session')
    assert.equal(records[0].ignorable, undefined, '头部记录不得被碰')
    assert.equal(records[1].type, 'turn/start')
    assert.equal(records[1].ignorable, undefined, '宿主事件不得被碰')
    assert.equal(records[2].ignorable, true)
    assert.equal(records[3].ignorable, true)
    assert.equal(records[3].data.task_id, 'R', '数据必须原样保留')
    // 修完之后不该再有需要修的记录。
    assert.equal(records.filter(needsIgnorable).length, 0)
  })

  it('已经标好的会话重复跑是幂等的（第二次一条都不改）', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gac-repair-idem-'))
    const file = join(directory, SESSION_LOG_FILE)
    writeFileSync(file, writeMultiFrameLog([
      [{ type: 'session', version: 4, id: 's-2' }],
      [{ type: 'gac/node-dispatched', seq: 1, time: 1, data: { task_id: 'R' } }],
    ]))
    assert.equal(repairSessionLog(file, { apply: true, now: 1 }).patched, 1)
    const afterFirst = readFileSync(file)
    assert.equal(repairSessionLog(file, { apply: true, now: 2 }).patched, 0)
    assert.deepEqual(readFileSync(file), afterFirst, '第二次不该再动它')
  })

  it('修活着的会话时，写入期间新追加的那一帧必须保住', () => {
    // 修的是整份文件，而宿主是往文件尾追加帧的：如果「读过之后、改名之前」落下的那帧被丢掉，
    // 丢的正是用户最新的对话。这条用只给测试用的接缝把这个时刻插出来。
    const directory = mkdtempSync(join(tmpdir(), 'gac-repair-race-'))
    const file = join(directory, SESSION_LOG_FILE)
    writeFileSync(file, writeMultiFrameLog([
      [{ type: 'session', version: 4, id: 's-race' }],
      [{ type: 'gac/mode-declared', seq: 1, time: 1, data: { mode: 'standard_task' } }],
    ]))
    const tail = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 2, time: 2 })}\n`, 'utf8'))

    const applied = repairSessionLog(file, {
      apply: true,
      now: 333,
      beforeWrite: () => {
        // 模拟宿主在我们读完之后又追加了一帧。
        writeFileSync(file, Buffer.concat([readFileSync(file), tail]))
      },
    })
    assert.equal(applied.patched, 1)
    assert.equal(applied.appended, tail.length, '新追加的字节应当被原样接回')

    const records = readRecords(readFileSync(file))
    assert.deepEqual(records.map((record) => record.type), ['session', 'gac/mode-declared', 'turn/start'])
    assert.equal(records[1].ignorable, true)
    assert.equal(records[2].ignorable, undefined, '后追加的宿主事件不该被碰')
  })

  it('能按目录递归找日志，并支持子串过滤', () => {
    const root = mkdtempSync(join(tmpdir(), 'gac-repair-scan-'))
    mkdirSync(join(root, '--proj--', 'session-a'), { recursive: true })
    mkdirSync(join(root, '--proj--', 'session-b'), { recursive: true })
    const log = writeMultiFrameLog([[{ type: 'session', version: 4, id: 's' }]])
    writeFileSync(join(root, '--proj--', 'session-a', SESSION_LOG_FILE), log)
    writeFileSync(join(root, '--proj--', 'session-b', SESSION_LOG_FILE), log)

    assert.equal(findSessionLogs(root).length, 2)
    assert.equal(findSessionLogs(root, 'session-a').length, 1)
    assert.equal(findSessionLogs(join(root, '不存在')).length, 0)
  })
})
