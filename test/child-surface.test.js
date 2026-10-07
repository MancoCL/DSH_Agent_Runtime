/**
 * 子会话工具面对账与守卫的测试。
 *
 * 这一层的存在理由是**创建窗口里的 `toolFilter` 有结构性边界**：它只能收「继承来的」工具，收不掉
 * 子会话自己那一层注册的（宿主的 Team 工具），也点不了内核按名字保留的 `run_code`。因此测试盯的是：
 *
 *  1. **以子会话的真实视图为准**：补收的名单来自 `view(localAgent).restrictableNames`，不是派遣方
 *     自己算出来的名单。
 *  2. **收不掉就如实记**：`restrict` 抛错、或收权后名字仍在，都降级成 `guard-only` 并记一条事件——
 *     「没法确认」绝不写成「已经收掉」。
 *  3. **拿不到 `localAgent` 时不假装**：进程外 provider 装不上这一层，只能记一条 `unavailable`。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SURFACE_CODES, createChildSurface } from '../lib/child-surface.js'

/**
 * 一个假的子会话工具容器。
 *
 * 形状对齐内核的 `view()`：`{visible: Map, restrictableNames: Set}`。`restrict` 只影响「继承来的」
 * 那一层——`ownNames` 里的名字模拟内核的 own 层豁免：点过名也不会从视图里消失。
 *
 * @param {object} [options]
 * @param {string[]} [options.visible] 子会话当前能看到的工具。
 * @param {string[]} [options.restrictable] 本作用域真正可收的名字（默认等于 `visible`）。
 * @param {string[]} [options.ownNames] 收不掉的名字（own 层注册 / 内核保留）。
 * @param {boolean} [options.restrictThrows]
 * @param {boolean} [options.hasGuard]
 */
function fakeTools({
  visible = [],
  restrictable = visible,
  ownNames = [],
  restrictThrows = false,
  hasGuard = true,
} = {}) {
  const state = {
    visible: [...visible],
    denies: [],
    guards: [],
    lifted: 0,
  }
  const tools = {
    view: () => ({
      visible: new Map(state.visible.map((name) => [name, {}])),
      knownNames: new Set(state.visible),
      restrictableNames: new Set(restrictable),
    }),
    restrict: ({ deny }) => {
      if (restrictThrows) throw new Error('tools.restrict() names unknown global tool "spawn_teammate"')
      state.denies.push([...deny])
      state.visible = state.visible.filter((name) => !deny.includes(name) || ownNames.includes(name))
      return () => { state.lifted += 1 }
    },
    guard: hasGuard
      ? (check) => {
          state.guards.push(check)
          return () => { state.lifted += 1 }
        }
      : undefined,
  }
  return { tools, state }
}

/** 一个够用的登记输入。 */
function bindInput(overrides = {}) {
  return {
    child_session_id: 'child-session-1',
    role: 'verification_design',
    write_scope: [],
    binding: { task_id: 'REQ-1', node_id: 'D1', dispatch_id: 'REQ-1-D1-A1' },
    agent: { ctx: { tools: undefined } },
    ...overrides,
  }
}

/** 收集事件的出口。 */
function collector() {
  const events = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('对账补收：以子会话自己的真实视图为准', () => {
  it('按角色补收创建期漏掉的名字，并记下收掉与留下各是哪些', () => {
    const { tools, state } = fakeTools({
      visible: ['read', 'grep', 'write', 'run_code', 'structured_output', 'subagent'],
      restrictable: ['read', 'grep', 'write', 'subagent'],
    })
    const { events, onEvent } = collector()
    const surface = createChildSurface({ toolsFor: () => tools, onEvent })

    const record = surface.bind(bindInput())

    assert.deepEqual(state.denies, [['read', 'grep', 'write', 'subagent']])
    assert.deepEqual(record.removed, ['read', 'grep', 'write', 'subagent'])
    assert.deepEqual(record.presented, ['run_code', 'structured_output'])
    assert.equal(record.mode, 'restricted')
    assert.equal(record.role, 'verification_design')

    const recorded = events.find((event) => event.code === SURFACE_CODES.SURFACE_RECORDED)
    assert.ok(recorded !== undefined, '对账结果必须留痕')
    assert.deepEqual(recorded.removed_tools, ['read', 'grep', 'write', 'subagent'])
    assert.deepEqual(recorded.presented_tools, ['run_code', 'structured_output'])
    assert.equal(recorded.local_agent, true)
  })

  it('可收集合里没有的名字不点名 —— 点错一个名字会让整次收权归零', () => {
    const { tools, state } = fakeTools({ visible: ['read', 'grep'], restrictable: ['read'] })
    const surface = createChildSurface({ toolsFor: () => tools })
    surface.bind(bindInput())
    assert.deepEqual(state.denies, [['read']])
  })

  it('实现节点只收委派与父会话协调类，读、写、shell 都留着', () => {
    const { tools, state } = fakeTools({
      visible: ['read', 'write', 'pwsh', 'subagent', 'gac_task'],
    })
    const surface = createChildSurface({ toolsFor: () => tools })
    surface.bind(bindInput({ role: 'implementation', write_scope: ['src/'], agent: {} }))
    assert.deepEqual(state.denies, [['subagent', 'gac_task']])
  })
})

describe('收不掉的靠守卫，收不了就说收不了', () => {
  it('PTC 保留名不进 restrict（点名它直接抛错），只由守卫拒', () => {
    const { tools, state } = fakeTools({ visible: ['read', 'run_code'], restrictable: ['read'] })
    const surface = createChildSurface({ toolsFor: () => tools })
    surface.bind(bindInput())

    assert.deepEqual(state.denies, [['read']], 'run_code 不该出现在 restrict 名单里')
    assert.equal(state.guards.length, 1, '守卫必须装上，否则 run_code 无人可拒')
    assert.match(state.guards[0]({ name: 'run_code' }), /run_code/u)
    assert.equal(state.guards[0]({ name: 'structured_output' }), undefined, '回报通道不能被守卫误伤')
  })

  it('收权后名字仍在（own 层豁免）→ 降级 guard-only 并记一条「没确认」', () => {
    const { tools } = fakeTools({ visible: ['read', 'grep'], ownNames: ['read', 'grep'] })
    const { events, onEvent } = collector()
    const surface = createChildSurface({ toolsFor: () => tools, onEvent })

    const record = surface.bind(bindInput())

    assert.equal(record.mode, 'guard-only')
    assert.deepEqual(record.still_visible, ['read', 'grep'])
    const unverified = events.find((event) => event.code === SURFACE_CODES.SURFACE_UNVERIFIED)
    assert.ok(unverified !== undefined, '「没法确认」不该写成「已经收掉」')
    assert.deepEqual(unverified.still_visible, ['read', 'grep'])
  })

  it('restrict 抛错 → 降级 guard-only，守卫照装', () => {
    const { tools, state } = fakeTools({ visible: ['read'], restrictThrows: true })
    const { events, onEvent } = collector()
    const surface = createChildSurface({ toolsFor: () => tools, onEvent })

    const record = surface.bind(bindInput())

    assert.equal(record.mode, 'guard-only')
    assert.match(record.restrict_failure, /unknown global tool/u)
    assert.equal(state.guards.length, 1, '收权失败不该连守卫也不装')
    assert.ok(events.some((event) => event.code === SURFACE_CODES.SURFACE_RESTRICT_FAILED))
  })

  it('容器没有 guard() → 同样如实降级，不宣称受限', () => {
    const { tools } = fakeTools({ visible: ['read'], hasGuard: false })
    const surface = createChildSurface({ toolsFor: () => tools })
    assert.equal(surface.bind(bindInput()).mode, 'guard-only')
  })
})

describe('拿不到 localAgent 时不假装收过', () => {
  it('进程外 provider：记 unavailable 与原因，presented / removed 都为空', () => {
    const { events, onEvent } = collector()
    const surface = createChildSurface({ toolsFor: () => undefined, onEvent })

    const record = surface.bind(bindInput({ agent: undefined }))

    assert.equal(record.mode, 'unavailable')
    assert.deepEqual(record.presented, [])
    assert.deepEqual(record.removed, [])
    const gap = events.find((event) => event.code === SURFACE_CODES.SURFACE_UNAVAILABLE)
    assert.ok(gap !== undefined)
    assert.match(gap.reason, /localAgent/u)
    assert.equal(events.some((event) => event.code === SURFACE_CODES.SURFACE_RECORDED), false,
      '没装上的层不该发一条「已对账」')
  })

  it('默认取子会话自己的容器，而不是退到派遣方那一层', () => {
    // 落到错误的层上，`restrict` 会去改父会话的工具面——E2E-6 留下的那个疑问正长在这个位置上。
    const { tools, state } = fakeTools({ visible: ['read'] })
    const surface = createChildSurface()
    const record = surface.bind(bindInput({ agent: { ctx: { tools } } }))
    assert.equal(record.mode, 'restricted')
    assert.deepEqual(state.denies, [['read']])
  })
})

describe('登记表的生命周期', () => {
  it('bind 缺 child_session_id → undefined（不能拿一个空键占位）', () => {
    const surface = createChildSurface({ toolsFor: () => fakeTools().tools })
    assert.equal(surface.bind(bindInput({ child_session_id: undefined })), undefined)
    assert.equal(surface.bind(bindInput({ child_session_id: '' })), undefined)
    assert.equal(surface.size(), 0)
  })

  it('roleOf / inspect / inspectAll / size 读得到，unbind 摘干净', () => {
    const { tools, state } = fakeTools({ visible: ['read'] })
    const { events, onEvent } = collector()
    const surface = createChildSurface({ toolsFor: () => tools, onEvent })
    surface.bind(bindInput())

    assert.equal(surface.roleOf('child-session-1'), 'verification_design')
    assert.equal(surface.size(), 1)
    assert.equal(surface.inspect('child-session-1').mode, 'restricted')
    assert.equal(surface.inspectAll().length, 1)

    assert.equal(surface.unbind('child-session-1'), true)
    assert.equal(surface.unbind('child-session-1'), false, '摘两次只有第一次动东西')
    assert.equal(surface.size(), 0)
    assert.equal(surface.roleOf('child-session-1'), undefined)
    assert.equal(state.lifted, 2, '收权与守卫的 disposer 都要被调用')
    assert.ok(events.some((event) => event.code === SURFACE_CODES.SURFACE_LIFTED))
  })
})
