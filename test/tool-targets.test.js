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

import { CALL_KINDS, classifyCall, knownTools, writeCapableToolNames } from '../lib/tool-targets.js'

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
    it(`classifies ${name} as ${kind}`, () => {
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

describe('收权：失败即收回', () => {
  it('只读的留下，其余全部收回', () => {
    const deny = writeCapableToolNames([
      'read', 'glob', 'grep', 'gac_evidence', 'todo_write',
      'write', 'edit', 'pwsh', 'gac_task', 'gac_scope', 'gac_project',
    ])
    assert.deepEqual(deny, ['write', 'edit', 'pwsh', 'gac_task', 'gac_scope', 'gac_project'])
  })

  it('表里没有的工具一律收回——运行时升级带来的新工具不会悄悄落进只读执行者手里', () => {
    assert.deepEqual(writeCapableToolNames(['some_new_tool']), ['some_new_tool'])
  })

  it('委派类工具也在收回之列，否则限制只是一次绕道', () => {
    // `subagent`/`workflow` 不在已知表里，因此按失败即收回被算作可疑。这条断言把这个
    // 结果钉住：一个只读执行者若能再委派一个不受限的子 Agent，收权就是装饰。
    assert.deepEqual(writeCapableToolNames(['subagent', 'workflow']), ['subagent', 'workflow'])
  })

  it('拿不到工具清单时收回空列表，而不是猜一份', () => {
    // 空列表意味着「什么都收不掉」，调用方必须据此拒绝启动一个收不了权的执行者，
    // 而不是拿一个空过滤器冒充收权。
    assert.deepEqual(writeCapableToolNames(undefined), [])
    assert.deepEqual(writeCapableToolNames(null), [])
    assert.deepEqual(writeCapableToolNames('write'), [])
  })

  it('忽略清单里的非字符串', () => {
    assert.deepEqual(writeCapableToolNames([42, null, '', 'write', {}]), ['write'])
  })
})
