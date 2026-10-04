/**
 * 能力路由测试。
 *
 * 这里钉死的是大纲 §9 的意图：执行者不是固定岗位。最容易退化成「谁声称什么都会谁就
 * 全接」——那样能力声明形同虚设、验证独立性也无从谈起，所以「额外覆盖最少优先」这条
 * 规则必须有测试守着。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ROUTER_CODES, routeCapabilities, routeTask } from '../lib/capability-router.js'
import { compileTask } from '../lib/coordinator.js'

/** 一份常见的能力 → 执行者声明：builder 会写，verifier 只验，generalist 什么都会。 */
const EXECUTORS = {
  implementation: ['builder', 'generalist'],
  verification: ['verifier', 'generalist'],
  review: ['reviewer', 'generalist'],
}

describe('routeCapabilities', () => {
  it('选能完整覆盖所需能力的执行者', () => {
    const route = routeCapabilities(['implementation'], EXECUTORS)
    assert.equal(route.executor, 'builder')
  })

  it('偏好额外覆盖最少的执行者，而不是「什么都会」的那个', () => {
    // 否则 generalist 会赢下所有节点，能力声明就白写了。
    const route = routeCapabilities(['verification'], EXECUTORS)
    assert.equal(route.executor, 'verifier')
    assert.match(route.reason, /verifier/u)
  })

  it('所需能力跨一组执行者时选覆盖得住的', () => {
    const route = routeCapabilities(['implementation', 'verification'], EXECUTORS)
    // 只有 generalist 同时覆盖两者。
    assert.equal(route.executor, 'generalist')
  })

  it('覆盖不全时给出缺口，而不是硬凑一个执行者', () => {
    const route = routeCapabilities(['implementation', 'deployment'], EXECUTORS)
    assert.equal(route.executor, undefined)
    // 缺口是「没有任何执行者覆盖」的那个，而不是各候选缺口的并集：并集会把
    // 「实现」也算成缺口，而它其实有人会——那会把拆节点的方向指错。
    assert.deepEqual(route.missing, ['deployment'])
    assert.match(route.reason, /拆节点/u)
  })

  it('缺口为「能力组合本身」时也如实说明，而不是报一个假的缺口名', () => {
    // 两个执行者各会一半、无人全会：没有一个能力是人人都不覆盖的。
    const split = { a: ['alpha'], b: ['beta'] }
    const route = routeCapabilities(['a', 'b'], split)
    assert.equal(route.executor, undefined)
    assert.deepEqual(route.missing, [])
    assert.match(route.reason, /能力组合/u)
  })

  it('并列时按工程声明顺序，结果可复现', () => {
    const order = { implementation: ['first', 'second'] }
    assert.equal(routeCapabilities(['implementation'], order).executor, 'first')
  })

  it('与声明顺序无关的部分由名称排序兜底，避免结果随对象键序漂移', () => {
    const same = { implementation: ['zeta'], verification: ['alpha'] }
    // 两个执行者都只覆盖 implementation 之外的同一能力时，名称排序给出稳定结果。
    const route = routeCapabilities(['implementation'], same)
    assert.equal(route.executor, 'zeta')
  })

  it('忽略重复的能力名', () => {
    const route = routeCapabilities(['implementation', 'implementation'], EXECUTORS)
    assert.equal(route.executor, 'builder')
  })

  it('没有能力要求时如实说明，而不是随便选一个', () => {
    const route = routeCapabilities([], EXECUTORS)
    assert.equal(route.executor, undefined)
    assert.match(route.reason, /未声明所需能力/u)
  })

  it('候选里给出每个执行者的覆盖情况，便于诊断', () => {
    const route = routeCapabilities(['verification'], EXECUTORS)
    const generalist = route.candidates.find((candidate) => candidate.name === 'generalist')
    assert.equal(generalist.covers, true)
    assert.deepEqual([...generalist.extra].sort(), ['implementation', 'review'])
  })

  it('拒绝形状不对的入参', () => {
    assert.throws(() => routeCapabilities('implementation', EXECUTORS), TypeError)
    assert.throws(() => routeCapabilities(['implementation'], []), TypeError)
    assert.throws(() => routeCapabilities(['implementation'], { implementation: 'builder' }), TypeError)
  })
})

describe('routeTask', () => {
  /** 一份实现+验证的两节点计划。 */
  function plan() {
    return compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'T2', objective: '验证', depends_on: ['T1'], required_capabilities: ['verification'], write_scope: [] },
      ],
    })
  }

  it('一次算完所有节点的执行者', () => {
    const routes = routeTask(plan(), EXECUTORS)
    assert.equal(routes.get('T1').executor, 'builder')
    assert.equal(routes.get('T2').executor, 'verifier')
  })

  it('任一节点无法调度就在动手之前整体报错', () => {
    // 放到派遣时才发现，前几个节点已经改过文件了。
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'T2', objective: '部署', required_capabilities: ['deployment'], write_scope: [] },
      ],
    })
    assert.throws(
      () => routeTask(task, EXECUTORS),
      (error) => {
        assert.equal(error.code, ROUTER_CODES.UNSCHEDULABLE)
        assert.equal(error.detail.unschedulable[0].node, 'T2')
        return true
      },
    )
  })

  it('错误信息里指出缺口，并说明应拆节点而不是声明全能', () => {
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [{ id: 'T1', objective: 'a', required_capabilities: ['nope'], write_scope: [] }],
    })
    assert.throws(() => routeTask(task, EXECUTORS), /拆开|全能/u)
  })
})
