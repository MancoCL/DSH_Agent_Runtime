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
 * `global` 是**全局注册表**的视野（`schemas()` 不带 scope 时读到的），`visible` 是这个 agent 的
 * 视野。两者不相等是实测里真实发生的事：宿主把 Team 那几个工具注册进了 agent 自己的层，而全局
 * 注册表里没有它们，于是整次收权被它们拖垮。
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.visible]
 * @param {readonly string[]} [options.global] - 缺省与 visible 相同。
 * @param {boolean} [options.throwOnRestrict]
 * @param {boolean} [options.throwOnSchemas]
 * @param {readonly string[]} [options.unknownToRestrict] - 这些名字一旦出现在 deny 里就让 restrict
 *   抛错，模拟宿主「names unknown global tools」的行为。
 * @returns {{tools: object, restrictions: object[], disposed: number[]}}
 */
function fakeTools({
  visible = ['read', 'write', 'edit', 'pwsh', 'run_code', 'gac_task'],
  global,
  throwOnRestrict = false,
  throwOnSchemas = false,
  unknownToRestrict = [],
} = {}) {
  const restrictions = []
  const disposed = []
  const globalView = global ?? visible
  const tools = {
    schemas: (scope) => {
      if (throwOnSchemas) throw new Error('视野读不出来')
      const names = scope === undefined ? globalView : visible
      return names.map((name) => ({ name }))
    },
    restrict: (filter) => {
      if (throwOnRestrict) throw new Error('收权接缝拒绝了这个过滤器')
      const unknown = (filter?.deny ?? []).filter((name) => unknownToRestrict.includes(name))
      if (unknown.length > 0) {
        // 与宿主一致的措辞：它对全局注册表不认识的名字直接抛错。
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
    assert.deepEqual([...record.revoked], ['write', 'edit', 'run_code'])
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit', 'run_code'] }])
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
    assert.deepEqual([...record.revoked], ['write', 'edit', 'pwsh', 'run_code'])
    assert.equal(record.include_shell, true)
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit', 'pwsh', 'run_code'] }])
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
  it('作用域内注册、全局注册表不认识的名字不进 deny —— 它们会让整次收权失败（活体实测）', () => {
    // 实测原文：`tools.restrict() names unknown global tools "spawn_teammate", …, "subagent"`。
    // 名单里混进一个这样的名字，整次 `restrict` 就抛错、退化成兜底——而兜底本该只是兜底。
    const { tools, restrictions } = fakeTools({
      visible: ['read', 'write', 'edit', 'spawn_teammate', 'subagent'],
      global: ['read', 'write', 'edit'],
      unknownToRestrict: ['spawn_teammate', 'subagent'],
    })
    const { guard } = guardOf({ toolsFor: () => tools })
    const record = guard.sync({ sessionId: 's1', taskId: 'R', readOnlyNodes: ['T2'], agent: {} })
    assert.equal(record.mode, 'restricted', '能收的照样收，不该因为有两个收不掉就一个都不收')
    assert.deepEqual([...record.revoked], ['write', 'edit'])
    assert.deepEqual(restrictions, [{ deny: ['write', 'edit'] }])
    // 收不掉的那些必须留下痕迹：它们仍会被守卫拒绝，但「没被收回」这件事本身要可见。
    assert.deepEqual([...record.shadowed], ['spawn_teammate', 'subagent'])
  })

  it('收不掉的名字被报进 role-restricted 事件', () => {
    const { tools } = fakeTools({
      visible: ['read', 'write', 'spawn_teammate'],
      global: ['read', 'write'],
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
    // 猜出来的名单与真实视野不一致，而 `restrict` 对未注册的名字会抛错——那会变成一次工具调用
    // 失败，代价比收权失败本身大得多。
    const { tools, restrictions } = fakeTools({ throwOnSchemas: true })
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
