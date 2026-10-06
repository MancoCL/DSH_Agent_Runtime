/**
 * 工具分类表的测试。
 *
 * 这张表被两处消费，而两处的后果相反：
 *
 *  - **门禁**按它决定一次调用能不能过。表里没有的工具被拒（失败即拒绝）。
 *  - **收权**按它决定一个只读执行者拿不到哪些工具（失败即收回）。
 *
 * 于是分类错一格的代价是双份的：`gac_task` 被算成 `unknown` 时，门禁会在作用域生效期间
 * 拒掉推进任务的工具（陷阱），而收权又会把它留给一个验证者（越权）。本套件把每一格钉住。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CALL_KINDS, classifyCall, knownTools, roleRevokedToolNames } from '../lib/tool-targets.js'

describe('分类表把每一类工具都摆在明处', () => {
  const cases = [
    ['write', CALL_KINDS.WRITE],
    ['edit', CALL_KINDS.WRITE],
    ['pwsh', CALL_KINDS.SHELL],
    ['bash', CALL_KINDS.SHELL],
    ['read', CALL_KINDS.READ],
    ['grep', CALL_KINDS.READ],
    ['gac_evidence', CALL_KINDS.READ],
    ['gac_metrics', CALL_KINDS.READ],
    ['gac_task', CALL_KINDS.RUNTIME],
    ['gac_scope', CALL_KINDS.RUNTIME],
    ['gac_project', CALL_KINDS.RUNTIME],
    ['mystery_tool', CALL_KINDS.UNKNOWN],
  ]

  for (const [name, kind] of cases) {
    it(`把 ${name} 归类为 ${kind}`, () => {
      assert.equal(classifyCall(name, {}).kind, kind)
    })
  }

  it('运行时工具不产出路径：它们写的不是产品文件', () => {
    for (const name of knownTools().runtime) {
      const call = classifyCall(name, { file_path: 'src/a.c' })
      assert.deepEqual(call.paths, [], `${name} 不该报出产品文件路径`)
      assert.equal(call.guarded, false)
    }
  })
})

describe('本 profile 不支持的传输工具：知道它、明确拒绝', () => {
  it('把 run_code 归类为 unsupported，而不是 unknown', () => {
    // 两者的区别是**拒因要说准**：unknown 会让人以为「守卫不认识这个工具」，而事实是
    // 「我们知道它是 PTC 的传输工具、本 profile 不支持」。
    const call = classifyCall('run_code', { code: 'x' })
    assert.equal(call.kind, CALL_KINDS.UNSUPPORTED)
    assert.match(call.reason, /不在本运行时的生产能力清单里/u)
  })

  it('不产出路径，也不声称自己受守卫', () => {
    const call = classifyCall('run_code', { file_path: 'src/a.c' })
    assert.deepEqual(call.paths, [])
    assert.equal(call.guarded, false)
  })

  it('普通工具的分类与它无关 —— 不支持一个通道不该动到别的判定', () => {
    assert.equal(classifyCall('write', { file_path: 'src/a.c' }).kind, CALL_KINDS.WRITE)
    assert.equal(classifyCall('pwsh', { command: 'x' }).kind, CALL_KINDS.SHELL)
    assert.deepEqual(classifyCall('write', { file_path: 'src/a.c' }).paths, ['src/a.c'])
  })

  it('内核若给传输改名，这里认不出来——落到失败即拒绝那一侧，而不是悄悄放行', () => {
    assert.equal(classifyCall('run_code_v2', { code: 'x' }).kind, CALL_KINDS.UNKNOWN)
  })

  it('knownTools 把这一类也列出来', () => {
    assert.deepEqual(knownTools().unsupported, ['run_code'])
  })

  it('它也在收权之列：只读执行者不该拿到这个通道', () => {
    // 收权与门禁走同一张表。保留这一条还有一个具体原因：宿主 `restrict` 按名字拒绝这个名字，
    // 所以 `lib/role-guard.js` 那边有一条排除护栏（否则整次子会话创建会失败）。
    assert.deepEqual(roleRevokedToolNames(['run_code']), ['run_code'])
  })
})

describe('收权：失败即收回', () => {
  it('只读的与运行时自己的工具都留下，写入面收回', () => {
    // 运行时自己的工具必须留下：收掉 `gac_task`/`gac_scope` 之后，一个只读角色就再也回报不了
    // 结果、也清不掉自己的作用域——那是把角色变成陷阱，与 `gac_scope` 当初被自己的门禁拒掉
    // 是同一个形状。
    const deny = roleRevokedToolNames([
      'read', 'glob', 'grep', 'gac_evidence', 'todo_write',
      'write', 'edit', 'pwsh', 'gac_task', 'gac_scope', 'gac_project',
    ])
    assert.deepEqual(deny, ['write', 'edit'])
  })

  it('shell 默认留着：验证者要靠它执行计划用例留证据', () => {
    // 把 shell 也收掉会让「每条用例都要有独立证据」的收口门禁永远过不去——那是拿掉验证者的
    // 能力，不是收窄它的权限（适配计划 §4.4 阶段 3）。
    assert.deepEqual(roleRevokedToolNames(['pwsh', 'bash']), [])
  })

  it('项目声明连 shell 一起收回时，shell 也收掉', () => {
    assert.deepEqual(
      roleRevokedToolNames(['pwsh', 'bash', 'read'], { includeShell: true }),
      ['pwsh', 'bash'],
    )
  })

  it('运行时工具一个都不收，无论 shell 收不收', () => {
    for (const includeShell of [false, true]) {
      assert.deepEqual(
        roleRevokedToolNames(knownTools().runtime, { includeShell }),
        [],
        `includeShell=${includeShell} 时不该收运行时工具`,
      )
    }
  })

  it('表里没有的工具一律收回——运行时升级带来的新工具不会悄悄落进只读执行者手里', () => {
    assert.deepEqual(roleRevokedToolNames(['some_new_tool']), ['some_new_tool'])
  })

  it('委派类工具也在收回之列，否则限制只是一次绕道', () => {
    // `subagent`/`workflow` 不在已知表里，因此按失败即收回被算作可疑。这条断言把这个
    // 结果钉住：一个只读执行者若能再委派一个不受限的子 Agent，收权就是装饰。
    assert.deepEqual(roleRevokedToolNames(['subagent', 'workflow']), ['subagent', 'workflow'])
  })

  it('拿不到工具清单时收回空列表，而不是猜一份', () => {
    // 空列表意味着「什么都收不掉」，调用方必须据此退到守卫兜底，而不是拿一个空过滤器冒充收权。
    assert.deepEqual(roleRevokedToolNames(undefined), [])
    assert.deepEqual(roleRevokedToolNames(null), [])
    assert.deepEqual(roleRevokedToolNames('write'), [])
  })

  it('忽略清单里的非字符串', () => {
    assert.deepEqual(roleRevokedToolNames([42, null, '', 'write', {}]), ['write'])
  })
})
