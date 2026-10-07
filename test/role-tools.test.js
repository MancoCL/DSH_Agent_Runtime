/**
 * 语义角色工具策略的测试。
 *
 * 这一层是**信息隔离的结构性依据**：独立性不能来自提示词里那句「不要读实现」，只能来自「工具面里
 * 根本没有 `read`」。因此测试盯的是三件事：
 *
 *  1. **判据是角色**：`verification_design` 与 `verification_execution` 的写范围都是空的，读取能力
 *     却必须完全相反——用「写范围是否为空」推导工具面，两者会塌成同一档。
 *  2. **拒绝先于一切**：委派是编排权问题，与这个角色能不能读文件无关，因此任何角色、任何写范围下
 *     都必须先被委派判定拦下。
 *  3. **失败方向保守**：认不出的角色退到「只推理」那一档，而不是退到最宽的 Builder——退错方向会让
 *     一个拼错的角色名静默拿到写入面。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATION_TOOLS,
  PARENT_COORDINATION_TOOLS,
  ROLE_CODES,
  ROLE_TOOL_POLICY,
  deniedToolNamesFor,
  isDelegationTool,
  isParentCoordinationTool,
  roleDenyFor,
  roleDenyReason,
  rolePolicyFor,
  semanticRoleOf,
} from '../lib/role-tools.js'

/** 一个够用的节点。 */
function node(overrides = {}) {
  return {
    id: 'T1',
    objective: '把配置字段删掉',
    write_scope: ['src/'],
    required_capabilities: ['implementation'],
    ...overrides,
  }
}

/** 判定一次的简写。 */
function deny({ role, name, write_scope: writeScope = [] }) {
  return roleDenyFor({ role, name, write_scope: writeScope })
}

describe('语义角色：判据是角色，不是写范围', () => {
  it('显式 role 优先，否则按能力推断', () => {
    assert.equal(semanticRoleOf(node({ role: 'review' })), 'review')
    assert.equal(semanticRoleOf(node()), 'implementation')
    assert.equal(semanticRoleOf(node({ required_capabilities: ['verification'] })), 'verification_execution')
    assert.equal(semanticRoleOf(node({ required_capabilities: ['review'] })), 'review')
  })

  it('缺省永远不会推断成 verification_design —— 那条角色带着「可以没有冻结计划」的豁免', () => {
    // 靠推断给出设计角色，会让一个没声明角色的验证节点悄悄绕过计划门禁。
    for (const capabilities of [[], ['verification'], ['implementation'], ['documentation']]) {
      assert.notEqual(semanticRoleOf(node({ required_capabilities: capabilities })), 'verification_design')
    }
  })

  it('角色名不在词表里时不抛错，退到最保守的那一档', () => {
    // 守卫不能因为一个坏字段就让这个会话的**每一次**工具调用都炸掉——那是拒绝整条会话，不是拒绝一次。
    assert.equal(semanticRoleOf(node({ role: 'reviewer' })), '__unknown__')
    assert.deepEqual(rolePolicyFor('__unknown__').deny_kinds, ROLE_TOOL_POLICY.verification_design.deny_kinds)
  })

  it('设计节点与执行节点的写范围都是空的，工具面却必须相反', () => {
    const design = { role: 'verification_design', name: 'read' }
    const execution = { role: 'verification_execution', name: 'read' }
    assert.equal(deny(design)?.category, 'read')
    assert.equal(deny(execution), undefined, '执行节点要读实现、跑用例')
    // 两者都写不了文件——这一条恰好说明「写范围为空」不能当作唯一的判据。
    assert.equal(deny({ role: 'verification_design', name: 'write' })?.category, 'write_scope_empty')
    assert.equal(deny({ role: 'verification_execution', name: 'write' })?.category, 'write_scope_empty')
  })
})

describe('设计节点：只推理', () => {
  const design = (name) => deny({ role: 'verification_design', name })

  it('仓库检视类工具一个都留不下', () => {
    for (const name of ['read', 'glob', 'grep', 'read_image', 'list_dir', 'search', 'web_fetch', 'web_search']) {
      assert.notEqual(design(name), undefined, `设计节点不该能使用 ${name}`)
    }
  })

  it('执行类工具一个都留不下：shell、PTC 传输、写工具', () => {
    assert.equal(design('pwsh')?.category, 'shell')
    assert.equal(design('bash')?.category, 'shell')
    assert.equal(design('run_code')?.category, 'ptc')
    assert.equal(design('write')?.category, 'write_scope_empty')
    assert.equal(design('edit')?.category, 'write_scope_empty')
  })

  it('连不认识的工具也拒 —— 未知写入行为不能靠名字猜', () => {
    // `classifyCall` 对不在表里的名字返回 `unknown`，而未知工具可能就是一个写工具（宿主升级带来
    // 新名字时正是这样）。设计节点没有「试一下」的余地，因此按 fail-closed 处理。
    assert.equal(design('some_new_tool')?.category, 'unknown')
  })

  it('回报通道留着：它要靠 structured_output 作答', () => {
    assert.equal(design('structured_output'), undefined)
    assert.equal(design('todo_write'), undefined)
  })
})

describe('执行 / 复核节点：读得到，写不了', () => {
  it('验证执行：读仓库与 shell 都在，写入工具不在', () => {
    for (const name of ['read', 'grep', 'glob', 'pwsh']) {
      assert.equal(deny({ role: 'verification_execution', name }), undefined, `${name} 应当保留`)
    }
    assert.equal(deny({ role: 'verification_execution', name: 'write' })?.category, 'write_scope_empty')
  })

  it('复核：证据与实现都要读，同样不许写', () => {
    for (const name of ['read', 'read_image', 'grep', 'pwsh']) {
      assert.equal(deny({ role: 'review', name }), undefined, `${name} 应当保留`)
    }
    assert.equal(deny({ role: 'review', name: 'edit' })?.category, 'write_scope_empty')
  })

  it('实现节点是唯一能改文件的角色，但写范围为空时照样不许写', () => {
    assert.equal(deny({ role: 'implementation', name: 'write', write_scope: ['src/'] }), undefined)
    assert.equal(deny({ role: 'implementation', name: 'write' })?.category, 'write_scope_empty')
  })
})

describe('委派与派遣方协调：所有角色一律拒绝', () => {
  const ROLES = ['implementation', 'verification_design', 'verification_execution', 'review', '__unknown__']

  it('委派先于一切 —— 判据是编排权，与这个角色能不能读文件无关', () => {
    for (const role of ROLES) {
      for (const name of DELEGATION_TOOLS) {
        const denial = deny({ role, name, write_scope: ['src/'] })
        assert.equal(denial?.category, 'delegation', `${role} 不该能用 ${name}`)
        assert.equal(denial.code, ROLE_CODES.CHILD_DELEGATION_DENIED)
      }
    }
  })

  it('带前缀的委派族靠前缀接住 —— 逐个点名的名单会随宿主升级静默过期', () => {
    for (const name of ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']) {
      assert.equal(isDelegationTool(name), true)
      assert.equal(deny({ role: 'implementation', name, write_scope: ['src/'] })?.category, 'delegation')
    }
  })

  it('派遣方的协调状态所有角色都碰不得 —— 子会话有自己的回报通道', () => {
    for (const role of ROLES) {
      for (const name of PARENT_COORDINATION_TOOLS) {
        const denial = deny({ role, name, write_scope: ['src/'] })
        assert.equal(denial?.category, 'parent_coordination', `${role} 不该能碰 ${name}`)
        assert.equal(denial.code, ROLE_CODES.ROLE_TOOL_DENIED)
      }
    }
  })

  it('名字不是字符串时不算命中（守卫不该被一个坏字段带偏）', () => {
    assert.equal(isDelegationTool(undefined), false)
    assert.equal(isDelegationTool(''), false)
    assert.equal(isParentCoordinationTool(undefined), false)
    assert.equal(roleDenyFor({ role: 'implementation', name: undefined, write_scope: ['src/'] }), undefined)
  })
})

describe('deniedToolNamesFor：呈现面与拒绝面共用同一张表', () => {
  it('只在本会话实际可收的名字上求交集', () => {
    const inheritable = ['read', 'grep', 'pwsh', 'write', 'structured_output', 'subagent']
    assert.deepEqual(
      deniedToolNamesFor({ role: 'verification_design', write_scope: [] }, inheritable),
      ['read', 'grep', 'pwsh', 'write', 'subagent'],
    )
    // 名单里没有的名字不会被凭空点名：`restrict` 对不认识的名字抛错，代价是整次收权归零。
    assert.deepEqual(
      deniedToolNamesFor({ role: 'verification_design', write_scope: [] }, ['read', 'structured_output']),
      ['read'],
    )
  })

  it('PTC 保留名照旧出现在名单里，由调用方剔除（内核按名字拒绝它）', () => {
    // `restrict` 点名 `run_code` 直接抛错，所以创建窗口那一层必须把它剔掉；而守卫那一层要拒它，
    // 因此判据本身**不能**把它排除——两件事分开做，才不会一边收不到、一边也拒不掉。
    assert.equal(deniedToolNamesFor({ role: 'verification_design' }, ['run_code']).includes('run_code'), true)
    assert.equal(deny({ role: 'verification_design', name: 'run_code' })?.category, 'ptc')
  })

  it('实现节点只被收掉委派与父会话协调类', () => {
    const inheritable = ['read', 'write', 'pwsh', 'subagent', 'gac_task', 'gac_evidence']
    assert.deepEqual(
      deniedToolNamesFor(node(), inheritable),
      ['subagent', 'gac_task', 'gac_evidence'],
    )
  })

  it('名单不是数组时返回空数组，调用方据此退回「没有过滤」', () => {
    assert.deepEqual(deniedToolNamesFor(node(), undefined), [])
    assert.deepEqual(deniedToolNamesFor(node(), 'read'), [])
  })
})

describe('拒因：一次拒绝要能回答「是谁、哪一次派遣、什么角色、想用什么」', () => {
  const binding = {
    task_id: 'REQ-1',
    node_id: 'T1',
    dispatch_id: 'REQ-1-T1-A1',
    child_session_id: 'child-session-1',
  }

  it('委派类拒因说清「编排权归 GAC」以及正确的做法', () => {
    const reason = roleDenyReason({
      role: 'implementation',
      name: 'subagent',
      category: 'delegation',
      binding,
    })
    assert.match(reason, /REQ-1/u)
    assert.match(reason, /T1/u)
    assert.match(reason, /REQ-1-T1-A1/u)
    assert.match(reason, /child-session-1/u)
    assert.match(reason, /编排权归 GAC/u)
    assert.match(reason, /结构化回报/u)
  })

  it('空写范围的拒因说清「声明为空是明确的不许写」', () => {
    const reason = roleDenyReason({ role: 'verification_execution', name: 'write', category: 'write_scope_empty', binding })
    assert.match(reason, /写范围是\*\*空的\*\*/u)
    assert.match(reason, /明确的不许写/u)
  })

  it('角色类别拒因带上这个角色的策略说明', () => {
    const reason = roleDenyReason({ role: 'verification_design', name: 'read', category: 'read', binding })
    assert.match(reason, /工具类别 read/u)
    assert.match(reason, /不读仓库/u)
  })

  it('没有登记身份时也能给出拒因（拒因不该依赖绑定一定在场）', () => {
    const reason = roleDenyReason({ role: 'review', name: 'edit', category: 'write_scope_empty' })
    assert.match(reason, /角色是 review/u)
    assert.match(reason, /edit/u)
  })
})
