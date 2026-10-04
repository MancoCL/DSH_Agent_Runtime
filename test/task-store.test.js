/**
 * 任务序列化与持久化测试。
 *
 * 这里最重要的一条是「往返不丢运行态」：节点表是 Map，默认 JSON 序列化会把它变成
 * `{}` 并静默丢光全部节点；而丢掉 execution 又会让执行中的节点在恢复后 attempt 归零，
 * 使一份迟到的旧结果重新看起来像当前结果。两者都属于「看起来还在跑、其实已经坏了」，
 * 所以必须直接测出来。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  COORDINATOR_CODES,
  applyResult,
  compileTask,
  deserializeTask,
  dispatch,
  serializeTask,
} from '../lib/coordinator.js'
import { TASKS_RELATIVE_DIR, TASK_STORE_CODES, TaskStore } from '../lib/task-store.js'

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时项目根，套件结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-tasks-'))
  scratchRoots.push(root)
  return root
}

/**
 * 一份标准任务：实现与验证串行。
 *
 * @returns {object}
 */
function standardTask() {
  return compileTask({
    task_id: 'REQ-1',
    mode: 'standard_task',
    created_at: 1234,
    nodes: [
      {
        id: 'T1',
        objective: '实现功能',
        required_capabilities: ['implementation'],
        write_scope: ['src/'],
        resources: ['build-dir'],
        expected_artifacts: ['ChangeSet'],
      },
      {
        id: 'T2',
        objective: '独立验证',
        depends_on: ['T1'],
        required_capabilities: ['verification'],
        write_scope: [],
        expected_artifacts: ['VerificationReport'],
        frozen: true,
      },
    ],
  })
}

describe('serializeTask — 不能静默丢节点', () => {
  it('节点表被完整写出，而不是变成空对象', () => {
    // Map 的默认 JSON 序列化是 `{}`，这正是需要显式转换的原因。
    const raw = serializeTask(standardTask())
    assert.equal(Array.isArray(raw.nodes), true)
    assert.deepEqual(raw.nodes.map((node) => node.id), ['T1', 'T2'])
    assert.deepEqual(JSON.parse(JSON.stringify(raw)).nodes.length, 2)
  })

  it('带上运行态与计划声明', () => {
    const raw = serializeTask(standardTask())
    assert.equal(raw.schema_version, 1)
    assert.equal(raw.created_at, 1234)
    const t2 = raw.nodes.find((node) => node.id === 'T2')
    assert.equal(t2.frozen, true)
    assert.deepEqual(t2.depends_on, ['T1'])
    assert.deepEqual(t2.expected_artifacts, ['VerificationReport'])
    assert.deepEqual(t1Resources(raw), ['build-dir'])
  })
})

/**
 * 取 T1 的 resources，避免在断言里重复找节点。
 *
 * @param {object} raw
 * @returns {string[]}
 */
function t1Resources(raw) {
  return raw.nodes.find((node) => node.id === 'T1').resources
}

describe('deserializeTask — 恢复并重新校验', () => {
  it('往返后结构不变', () => {
    const original = standardTask()
    const restored = deserializeTask(serializeTask(original))
    assert.equal(restored.task_id, original.task_id)
    assert.equal(restored.status, original.status)
    assert.deepEqual([...restored.nodes.keys()], [...original.nodes.keys()])
    assert.deepEqual(
      restored.nodes.get('T1').write_scope,
      original.nodes.get('T1').write_scope,
    )
  })

  it('往返后保持执行身份，attempt 不归零', () => {
    // 丢掉这个会让一份迟到的旧结果重新看起来像当前结果。
    const flown = dispatch(standardTask(), ['T1'])
    const restored = deserializeTask(serializeTask(flown))
    const node = restored.nodes.get('T1')
    assert.equal(node.status, 'in_progress')
    assert.equal(node.execution.attempt, 1)
    assert.equal(node.execution.active_dispatch_id, 'REQ-1-T1-A1')
    // 身份一致，所以一份对应的结果仍然被接受。
    const applied = applyResult(restored, {
      node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed',
    })
    assert.equal(applied.classification, 'accepted')
  })

  it('往返后终态仍然是终态', () => {
    const flown = dispatch(standardTask(), ['T1'])
    const done = applyResult(flown, {
      node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed',
    }).task
    const restored = deserializeTask(serializeTask(done))
    assert.equal(restored.nodes.get('T1').status, 'completed')
    const late = applyResult(restored, {
      node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed',
    })
    assert.notEqual(late.classification, 'accepted')
  })

  it('恢复路径与新建路径受同一套校验：有环的记录被拒', () => {
    // 手工改过的文件若能直接恢复，等于可以绕过 compileTask 造出一个有环的 DAG。
    const cyclic = serializeTask(standardTask())
    cyclic.nodes.find((node) => node.id === 'T1').depends_on = ['T2']
    assert.throws(
      () => deserializeTask(cyclic),
      (error) => error.code === COORDINATOR_CODES.CYCLE,
    )
  })

  it('拒绝未知的任务状态', () => {
    const raw = serializeTask(standardTask())
    raw.status = 'finished'
    assert.throws(
      () => deserializeTask(raw),
      (error) => error.code === COORDINATOR_CODES.INVALID_TRANSITION,
    )
  })

  it('拒绝「执行中却没有执行身份」的记录', () => {
    // 这种记录会让下一份结果因身份对不上而被判 stale，节点从此走不动。
    const flown = dispatch(standardTask(), ['T1'])
    const raw = serializeTask(flown)
    raw.nodes.find((node) => node.id === 'T1').execution.active_dispatch_id = null
    assert.throws(
      () => deserializeTask(raw),
      (error) => error.code === COORDINATOR_CODES.INVALID_TRANSITION,
    )
  })

  it('拒绝「未在执行却持有执行身份」的记录', () => {
    const raw = serializeTask(standardTask())
    raw.nodes.find((node) => node.id === 'T1').execution.active_dispatch_id = 'stale-id'
    assert.throws(
      () => deserializeTask(raw),
      (error) => error.code === COORDINATOR_CODES.INVALID_TRANSITION,
    )
  })

  it('报错时指认来源文件', () => {
    assert.throws(() => deserializeTask({}, 'C:/proj/.dsh/gac/tasks/REQ-1.json'), /REQ-1\.json/u)
  })
})

describe('TaskStore', () => {
  it('一任务一文件', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    const files = readdirSync(join(root, ...TASKS_RELATIVE_DIR.split('/')))
    assert.deepEqual(files, ['REQ-1.json'])
  })

  it('同 ID 拒绝覆盖，新的交付目标须另建任务', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    assert.throws(
      () => store.save(standardTask(), { create: true }),
      (error) => error.code === TASK_STORE_CODES.EXISTS,
    )
  })

  it('非创建式保存用于推进状态', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    const flown = dispatch(standardTask(), ['T1'])
    store.save(flown)
    assert.equal(store.load('REQ-1').nodes.get('T1').status, 'in_progress')
  })

  it('载入一个不存在的任务返回 undefined，而不是抛错', () => {
    const store = new TaskStore({ root: scratch() })
    assert.equal(store.load('REQ-absent'), undefined)
  })

  it('跨实例可见，因此重载后任务仍在', () => {
    const root = scratch()
    new TaskStore({ root }).save(standardTask(), { create: true })
    const reloaded = new TaskStore({ root }).load('REQ-1')
    assert.equal(reloaded.task_id, 'REQ-1')
    assert.equal(reloaded.nodes.size, 2)
  })

  it('列出全部任务 id', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    store.save(compileTask({
      task_id: 'REQ-2',
      nodes: [{ id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [] }],
    }), { create: true })
    assert.deepEqual(store.list(), ['REQ-1', 'REQ-2'])
  })

  it('没有任务目录时列表为空，不算错误', () => {
    const store = new TaskStore({ root: scratch() })
    assert.deepEqual(store.list(), [])
    assert.deepEqual(store.unreadable, [])
  })

  it('读不出来的记录被报告，而不是静默跳过', () => {
    // 静默跳过会让「某个任务不见了」看起来像「从来没建过」。
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    writeFileSync(join(root, ...TASKS_RELATIVE_DIR.split('/'), 'broken.json'), '{ not json', 'utf8')
    const view = store.inspect()
    assert.equal(view.unreadable.length, 1)
    assert.match(view.unreadable[0].file, /broken\.json/u)
    assert.deepEqual(view.tasks, ['REQ-1'])
  })

  it('文件名与 task_id 不一致的记录被报告', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    const directory = join(root, ...TASKS_RELATIVE_DIR.split('/'))
    store.save(standardTask(), { create: true })
    writeFileSync(join(directory, 'forged.json'), JSON.stringify(serializeTask(standardTask())), 'utf8')
    assert.equal(store.inspect().unreadable.some((e) => /不一致/u.test(e.reason)), true)
  })

  it('构造式 id 不会写到任务目录之外', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    const hostile = '../../escape'
    store.save(compileTask({
      task_id: hostile,
      nodes: [{ id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [] }],
    }), { create: true })
    const files = readdirSync(join(root, ...TASKS_RELATIVE_DIR.split('/')))
    assert.equal(files.length, 1)
    assert.equal(/[\\/]/u.test(files[0]), false, `文件名不得含分隔符：${files[0]}`)
    assert.equal(store.load(hostile).task_id, hostile)
  })

  it('删除任务记录', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    assert.equal(store.remove('REQ-1'), true)
    assert.equal(store.load('REQ-1'), undefined)
  })

  it('损坏的记录在载入时抛错，而不是返回半个任务', () => {
    const root = scratch()
    const store = new TaskStore({ root })
    store.save(standardTask(), { create: true })
    const path = join(root, ...TASKS_RELATIVE_DIR.split('/'), 'REQ-1.json')
    writeFileSync(path, '{ broken', 'utf8')
    assert.throws(
      () => store.load('REQ-1'),
      (error) => error.code === TASK_STORE_CODES.MALFORMED,
    )
  })

  it('需要项目根', () => {
    assert.throws(() => new TaskStore({}), TypeError)
  })
})
