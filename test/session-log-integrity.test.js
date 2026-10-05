/**
 * 会话日志完整性：**本插件绝不往会话日志里写自己的事件类型**。
 *
 * 为什么这条测试必须存在
 * ----------------------
 * 原先的实现在每次 GAC 工具调用后 `session.append('gac/…', …)`，理由是「让 GAC 事件出现在对话
 * 历史里」。它踩了宿主的一条硬契约：
 *
 *   - 会话日志的事件词表由宿主**构建期生成**（`dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`），
 *     外部插件的类型按构造就不在里面；
 *   - `Session.append(type, data, ...opts)` 只把 `sourceEventSeqs` 与 `surfaceOp` 放进日志，
 *     **没有任何途径**给一条事件打上 `ignorable` 标记；
 *   - 持久化层读回日志时因此直接拒读（`dsh-session-persistence` 的 `validateStoredEvents`）：
 *     `session "…" contains event type "gac/…" (seq N) unknown to this harness and not marked
 *     ignorable; refusing to interpret the log`。
 *
 * 后果不是「少一条事件」，而是**那份会话再也打不开**——实测本工程含 GAC 事件的会话全部中招，
 * 界面上的表现是「子智能体的历史记录全部显示不出来，点进去全报错」。
 *
 * 当时 969 条测试全绿，因为**没有任何一条断言过「我们往会话日志写了什么」**。这个文件就是那条
 * 断言：假 ctx 里的 session 会把每一次 `append` 记下来，测试要求它**始终为空**。
 *
 * 审计事件现在写在工程自己的追加文件（`.dsh/gac/events/events.jsonl`），读者是 `gac_evidence`、
 * 该文件与加载报告——不依赖宿主的词表，也不影响任何会话的可读性。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const tempHome = mkdtempSync(join(tmpdir(), 'gac-log-integrity-home-'))
process.env.DSH_HOME = tempHome

const projectRoot = mkdtempSync(join(tmpdir(), 'gac-log-integrity-project-'))
mkdirSync(join(projectRoot, '.dsh', 'gac'), { recursive: true })
writeFileSync(
  join(projectRoot, '.dsh', 'gac', 'project.json'),
  JSON.stringify({ project: { id: 'log-integrity', title: '会话日志完整性' } }),
  'utf8',
)

const { apply } = await import('../lib/index.js')

const SESSION_ID = 'session-log-integrity'

/**
 * 一个会**记录每一次 append** 的假 ctx。
 *
 * @returns {object}
 */
function createFakeContext() {
  const seen = { appended: [], projections: [], listeners: [], tools: [], disposers: [] }
  const disposer = () => {}
  const session = {
    id: SESSION_ID,
    header: { cwd: projectRoot },
    append: (...args) => {
      seen.appended.push(args)
    },
  }
  const ctx = {
    sessions: {
      get: (id) => (id === SESSION_ID ? session : undefined),
      list: () => [session],
      registerMessageProjection: (projection) => {
        seen.projections.push(projection)
        return disposer
      },
    },
    tools: { register: (definition) => { seen.tools.push(definition); return disposer } },
    on: (event, listener, options) => {
      seen.listeners.push({ event, listener, options })
      return disposer
    },
    effect: (body) => {
      for (const yielded of body()) {
        if (typeof yielded === 'function') seen.disposers.push(yielded)
      }
      return disposer
    },
    inject: (deps, callback) => {
      // 只提供系统提示这条可选接缝；工作区观测源缺席，与真实宿主上它缺失时的行为一致。
      if (deps.includes('systemPrompt')) {
        callback({ systemPrompt: { section: () => disposer } })
      }
      return disposer
    },
    get: () => undefined,
  }
  return { ctx, seen }
}

/**
 * 触发一条**会产出 GAC 事件**的工具结果（`gac_project` 声明执行模式）。
 *
 * @param {object} seen
 * @param {object} [result]
 * @returns {number} 触发了几次 `tools/result` 监听器。
 */
function fireModeDeclared(seen, result = { value: { mode: 'standard_task', declared_mode: 'standard_task', escalated: false, risk: 'medium' } }) {
  const listeners = seen.listeners.filter((entry) => entry.event === 'tools/result')
  for (const entry of listeners) {
    entry.listener({ name: 'gac_project', agent: { session: { id: SESSION_ID } }, arguments: {} }, result)
  }
  return listeners.length
}

describe('会话日志完整性 —— 插件自有事件绝不写进会话日志', () => {
  it('挂上监听器之后，session.append 一次都没被调用', async () => {
    const { ctx, seen } = createFakeContext()
    await apply(ctx)

    assert.ok(fireModeDeclared(seen) > 0, '应当挂上了 tools/result 监听器')

    assert.deepEqual(
      seen.appended,
      [],
      '本插件不得往会话日志写任何事件：宿主的事件词表是构建期生成的，外部插件的类型不在其中，'
      + '而 append 无法打 ignorable 标记——写进去的那份日志会被持久化层拒读，用户的历史就打不开了。'
      + `实际写入了 ${seen.appended.length} 次：${JSON.stringify(seen.appended)}`,
    )
  })

  it('也不注册消息投影 —— 那正是让会话「依赖本插件才能读」的机制', async () => {
    const { ctx, seen } = createFakeContext()
    await apply(ctx)

    assert.deepEqual(
      seen.projections,
      [],
      '注册投影会让「读这份日志」依赖本插件在场（撤走投影时派生直接抛错），而本插件默认是关的。',
    )
  })

  it('事件改写到工程自己的追加文件，事实不丢', async () => {
    const { ctx, seen } = createFakeContext()
    await apply(ctx)
    fireModeDeclared(seen)

    const text = readFileSync(join(projectRoot, '.dsh', 'gac', 'events', 'events.jsonl'), 'utf8')
    const records = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    const record = records.find((entry) => entry.type === 'gac/mode-declared')
    assert.ok(record !== undefined, `事件文件里应当有 gac/mode-declared；实际：${text}`)
    assert.equal(record.session_id, SESSION_ID)
    assert.equal(record.tool, 'gac_project')
    assert.equal(record.data.mode, 'standard_task')
    assert.equal(record.seq, 1)
  })

  it('工具报错时不记事件，也不写日志', async () => {
    const { ctx, seen } = createFakeContext()
    await apply(ctx)
    fireModeDeclared(seen, { isError: true, value: undefined })

    assert.deepEqual(seen.appended, [])
  })
})
