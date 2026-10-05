/**
 * 只读角色收权的测试（适配计划 §4.2 的补强手段、E2E-6）。
 *
 * 这一层有两条性质比功能本身更要紧，因此各有一组用例钉住：
 *
 *  1. **收权必须能撤销，而且撤销必须可靠。** 撤不掉的话，那个会话再也写不了文件——「把自己
 *     关在门外」的同一个形状，只是这次关的是用户。
 *  2. **拿不到收权接缝时必须如实降级**，而不是静默地什么都不做。一条静默失效的收权比没有收权
 *     更糟，因为它会让人以为角色已经安全了。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRoleGuard } from '../lib/role-guard.js'

/**
 * 一个假 agent 的工具服务：记下收权请求，并给出可撤销的凭据。
 *
 * 三个视野刻意分开，因为它们真的不相等（活体实测纠正过一次）：
 *  - `visible`：这个 agent 看得见的（含**作用域自己那一层**注册的，例如宿主的 Team 工具）；
 *  - `restrictable`：`restrict` 会接受的（内核口径是「这个作用域**继承**来的」，不含 own 层）；
 *  - `global`：兜底路径里 `schemas()` 不带 scope 读到的东西（≠ restrictable）。
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.visible]
 * @param {readonly string[]} [options.restrictable] - 缺省与 visible 相同。
 * @param {readonly string[]} [options.global] - 兜底路径用；缺省与 visible 相同。
 * @param {boolean} [options.withView] - 是否提供 `view()`；false 模拟老宿主，走兜底。
 * @param {boolean} [options.throwOnRestrict]
 * @param {boolean} [options.throwOnSchemas]
 * @param {readonly string[]} [options.unknownToRestrict] - 这些名字一旦出现在 deny 里就让 restrict
 *   抛错，模拟宿主「names unknown global tools」的行为。
 * @returns {{tools: object, restrictions: object[], disposed: number[]}}
 */
function fakeTools({
  visible = ['read', 'write', 'edit', 'pwsh', 'run_code', 'gac_task'],
  restrictable,
  global,
  withView = true,
  throwOnRestrict = false,
  throwOnSchemas = false,
  unknownToRestrict = [],
} = {}) {
  const restrictions = []
  const disposed = []
  const globalView = global ?? visible
  const restrictableView = restrictable ?? visible
  const tools = {
    ...(withView
      ? {
        view: () => ({
          visible: new Map(visible.map((name) => [name, { name }])),
          restrictableNames: new Set(restrictableView),
        }),
      }
      : {}),
    schemas: (scope) => {
      if (throwOnSchemas) throw new Error('视野读不出来')
      const names = scope === undefined ? globalView : visible
      return names.map((name) => ({ name }))
    },
    restrict: (filter) => {
      if (throwOnRestrict) throw new Error('收权接缝拒绝了这个过滤器')
      const unknown = (filter?.deny ?? []).filter((name) => unknownToRestrict.includes(name))
      if (unknown.length > 0) {
        // 与宿主一致的措辞：它对不在可收集合里的名字直接抛错。
        throw new Error(
          `tools.restrict() names unknown global tools ${unknown.map((n) => `"${n}"`).join(', ')}`,
        )
      }
      const index = restrictions.length
      restrictions.push(filter)
      return () => disposed.push(index)
    },
  }
  return { tools, restrictions, disposed }
}

/**
 * @param {object} [options]
 * @returns {{guard: object, events: object[]}}
 */
function guardOf(options = {}) {
  const events = []
  const guard = createRoleGuard({ onEvent: (record) => events.push(record), ...options })
  return { guard, events }
}

describe('sync —— 按在飞的只读节点收权', () => {
  it('把写入面收回，shell 默认留着', () => {
    const { tools, restrictions } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({
      sessionId: 's1',
      taskId: 'R',
      readOnlyNodes: ['T2'],
      agent: { id: 'a1' },
    })
    assert.equal(record.mode, 'restricted')
    // `run_code` 不在名单里：内核按名字拒绝它（cannot name reserved PTC mode presentation
    // transport "run_code"），所以 PTC 传输只能由守卫兜底拒绝。
    assert.deepEqual([...record.revoked], ['write', 'edit'])
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit'] }])
    assert.deepEqual([...record.shadowed], ['run_code'])
  })

  it('项目要求连 shell 一起收回时，shell 也在名单里', () => {
    const { tools, restrictions } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({
      sessionId: 's1',
      taskId: 'R',
      readOnlyNodes: ['T2'],
      includeShell: true,
      agent: { id: 'a1' },
    })
    assert.deepEqual([...record.revoked], ['write', 'edit', 'pwsh'])
    assert.equal(record.include_shell, true)
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit', 'pwsh'] }])
  })

  it('名单来自内核的可收集合，而不是「看得见」那一份', () => {
    // 这是活体实测踩过的坑：拿 `schemas()`（不给 scope）当全局视野，`write`/`edit` 被判成收不掉，
    // 于是收权静默退化。内核的口径是「这个作用域**继承**来的」（全局层加祖先层），own 层不算。
    const { tools, restrictions } = fakeTools({
      visible: ['read', 'write', 'edit', 'spawn_teammate', 'subagent'],
      restrictable: ['read', 'write', 'edit'],
    })
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'restricted')
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit'] }])
    assert.deepEqual([...record.shadowed], ['spawn_teammate', 'subagent'])
  })

  it('没有 view() 的老宿主退到两个 schemas 视野的交集', () => {
    const { tools, restrictions } = fakeTools({
      withView: false,
      visible: ['read', 'write', 'edit', 'spawn_teammate'],
      global: ['read', 'write', 'edit'],
    })
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'restricted')
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit'] }])
    assert.deepEqual([...record.shadowed], ['spawn_teammate'])
  })

  it('运行时自己的工具不在名单里 —— 否则角色变成陷阱', () => {
    const { tools, restrictions } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(restrictions[0].deny.includes('gac_task'), false)
  })

  it('没有在飞的只读节点时不收权，并撤销上一次', () => {
    const { tools, disposed } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: [], agent: {} }), undefined)
    assert.deepEqual(disposed, [0])
    assert.equal(guard.active('s1'), undefined)
  })

  it('再次收权时先撤掉上一次 —— 不留下一个再也没人认领的收权', () => {
    const { tools, disposed, restrictions } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2', 'T3'], agent: {} })
    assert.deepEqual(disposed, [0])
    assert.equal(restrictions.length, 2)
    assert.deepEqual([...guard.active('s1').node_ids], ['T2', 'T3'])
  })

  it('会话 id 不是字符串时什么都不做，也不抛错', () => {
    const { tools } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    for (const sessionId of [undefined, null, '', 42]) {
      assert.equal(guard.sync({ sessionId, taskId: 'R', readOnlyNodes: ['T2'], agent: {} }), undefined)
    }
  })
})

describe('拿不到收权接缝时如实降级', () => {
  it('名单里混进一个 restrict 不认识的名字时，整次收权退化成兜底（活体实测的形态）', () => {
    // 实测原文：`tools.restrict() names unknown global tools "spawn_teammate", …, "subagent"`。
    // 这不是我们想要的形态，但它**必须是可见的**：退到兜底、记进事件，而不是静静地什么都不做。
    // 真正的修法是别把那些名字放进名单（见「名单来自内核的可收集合」），这条守的是退化的那一步。
    const { tools } = fakeTools({
      visible: ['read', 'write', 'edit', 'spawn_teammate', 'subagent'],
      restrictable: ['read', 'write', 'edit', 'spawn_teammate', 'subagent'],
      unknownToRestrict: ['spawn_teammate', 'subagent'],
    })
    const { guard, events } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'guard-only')
    assert.deepEqual([...record.revoked], [], '没成功收掉任何东西，就不能声称收掉了')
    assert.equal(events.some((entry) => entry.event === 'role-revocation-failed'), true)
    assert.equal(guard.active('s1').mode, 'guard-only', '兜底状态必须记下，否则守卫不知道要拒什么')
  })

  it('收不掉的名字被报进 role-restricted 事件', () => {
    const { tools } = fakeTools({
      visible: ['read', 'write', 'spawn_teammate'],
      restrictable: ['read', 'write'],
    })
    const { guard, events } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    const event = events.find((entry) => entry.event === 'role-restricted')
    assert.deepEqual(event.revoked, ['write'])
    assert.deepEqual(event.shadowed, ['spawn_teammate'])
  })

  it('没有工具服务时退到守卫兜底，并记下这件事', () => {
    // 静默失效是最坏的形态：调用方会以为角色已经安全了。
    const { guard, events } = guardOf()
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'guard-only')
    assert.deepEqual([...record.revoked], [])
    assert.equal(guard.active('s1').mode, 'guard-only')
    assert.equal(events.filter((entry) => entry.event === 'role-restricted').length, 1)
  })

  it('工具视野读不出来时同样退到守卫兜底，而不是猜一份名单', () => {
    // 猜出来的名单与真实视野不一致，而 `restrict` 对不在可收集合里的名字会抛错——那会变成一次
    // 工具调用失败，代价比收权失败本身大得多。
    const { tools, restrictions } = fakeTools({ withView: false, throwOnSchemas: true })
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'guard-only')
    assert.deepEqual(restrictions, [])
  })

  it('view() 抛错时退到兜底，而不是让收权整条失效', () => {
    const { tools, restrictions } = fakeTools({ throwOnSchemas: true })
    tools.view = () => { throw new Error('视野读不出来') }
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'guard-only')
    assert.deepEqual(restrictions, [])
  })

  it('收权接缝抛错时吞掉它、记下来、退到守卫兜底', () => {
    const { tools } = fakeTools({ throwOnRestrict: true })
    const { guard, events } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'guard-only')
    assert.equal(events.some((entry) => entry.event === 'role-revocation-failed'), true)
    // 兜底状态必须已经记下，否则守卫那一层不知道要拒绝什么。
    assert.equal(guard.active('s1').mode, 'guard-only')
  })

  it('撤销抛错时不假装已经放开，而是如实报告', () => {
    const events = []
    const guard = createRoleGuard({
      toolsFor: () => ({
        schemas: () => [{ name: 'write' }],
        restrict: () => () => { throw new Error('撤销失败') },
      }),
      onEvent: (record) => events.push(record),
    })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.doesNotThrow(() => guard.lift('s1'))
    assert.equal(events.some((entry) => entry.event === 'role-revocation-lift-failed'), true)
  })
})

describe('撤销 —— 不能把自己关在门外', () => {
  it('lift 撤销一次，重复调用返回 false', () => {
    const { tools, disposed } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(guard.lift('s1'), true)
    assert.equal(guard.lift('s1'), false)
    assert.deepEqual(disposed, [0])
  })

  it('liftAll 把每个会话都放开 —— 插件卸载时用', () => {
    const { tools, disposed } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    guard.sync({ sessionId: 's2', taskId: 'R', readOnlyNodes: ['T3'], agent: {} })
    assert.equal(guard.liftAll(), 2)
    assert.deepEqual(disposed.sort(), [0, 1])
    assert.equal(guard.active('s1'), undefined)
    assert.equal(guard.active('s2'), undefined)
    assert.equal(guard.liftAll(), 0)
  })

  it('inspect 给出可读视图，且不带上撤销凭据', () => {
    const { tools } = fakeTools()
    const { guard } = guardOf({ toolsFor: () => tools })
    guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    const view = guard.inspect()
    assert.equal(view.length, 1)
    assert.equal(view[0].session_id, 's1')
    assert.equal(Object.hasOwn(view[0], 'dispose'), false)
  })
})
