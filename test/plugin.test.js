/**
 * 守卫行为测试——拒绝路径。
 *
 * 架构大纲 §22 要求越出作用域的写入必须在执行之前被拦下，而不是事后才被观察到（§25）。
 * 本套件是该门禁的可执行证明，并且刻意按照 DSH 实际交给 `tools/pre-execute` 监听器的
 * 形状来编写。
 *
 * 本套件同时也是该门禁「不」覆盖哪些情形的诚实记录（shell、未知工具）：这些用例断言
 * 拒绝，因为另一种做法——声称提供这个接缝无法提供的覆盖——正是适配计划 §7 所警告的
 * 失败。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GAC_CODES, createGacCore } from '../lib/plugin.js'

const SESSION = 'session-1'
const ROOT = 'D:/work/proj'

/**
 * 构造一个 `ToolExecution` 形状的对象，与 DSH 在 pre-execute 时呈现的一致。
 *
 * @param {string} name
 * @param {object} args
 * @param {string} [sessionId]
 * @returns {object}
 */
function exec(name, args, sessionId = SESSION) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name,
    arguments: args,
    agent: { id: sessionId, session: { id: sessionId } },
    signal: new AbortController().signal,
  }
}

/**
 * 一个核心实例，为默认会话声明了一个作用域。
 *
 * @param {readonly string[]} writeScope
 * @param {object} [options]
 * @returns {ReturnType<typeof createGacCore>}
 */
function governed(writeScope, options = {}) {
  const core = createGacCore({
    resolveRoot: () => ROOT,
    ...options,
  })
  core.declareScope({
    session_id: SESSION,
    task_id: 'REQ-1',
    node_id: 'T1',
    write_scope: writeScope,
    root: ROOT,
  })
  return core
}

describe('无人管辖的会话不受干预', () => {
  it('从未声明过作用域时放行写入', () => {
    const core = createGacCore()
    assert.deepEqual(core.preExecute(exec('write', { file_path: 'anywhere.c' })), { kind: 'allow' })
  })

  it('未声明作用域时放行 shell 调用', () => {
    const core = createGacCore()
    assert.equal(core.preExecute(exec('pwsh', { command: 'rm -rf /' })).kind, 'allow')
  })

  it('放行来自另一个会话的调用', () => {
    const core = governed(['src/a.c'])
    assert.equal(
      core.preExecute(exec('write', { file_path: 'elsewhere.c' }, 'session-2')).kind,
      'allow',
    )
  })

  it('放行无法归属到某个会话的调用', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute({ name: 'write', arguments: { file_path: 'x.c' } }).kind, 'allow')
  })
})

describe('范围内的写入放行', () => {
  it('放行已声明的精确文件', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'allow')
  })

  it('放行已声明目录内的文件', () => {
    const core = governed(['src/'])
    assert.equal(core.preExecute(exec('edit', { file_path: 'src/deep/b.c' })).kind, 'allow')
  })

  it('放行解析后落在作用域内的绝对路径', () => {
    const core = governed(['src/a.c'])
    assert.equal(
      core.preExecute(exec('write', { file_path: `${ROOT}/src/a.c` })).kind,
      'allow',
    )
  })

  it('不论作用域如何都放行读工具', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('read', { file_path: 'docs/readme.md' })).kind, 'allow')
  })
})

describe('E2E-4 用例：authority.write = ["mod.c"]，agent 试图写 sub/mod.c', () => {
  it('在执行之前拒绝', () => {
    const core = governed(['mod.c'])
    const verdict = core.preExecute(exec('write', { file_path: 'sub/mod.c' }))
    assert.equal(verdict.kind, 'deny')
  })

  it('携带结构化错误码，调用方无需解析散文', () => {
    const core = governed(['mod.c'])
    const verdict = core.preExecute(exec('write', { file_path: 'sub/mod.c' }))
    assert.equal(verdict.info.code, GAC_CODES.WRITE_SCOPE_DENIED)
    assert.equal(verdict.info.name, 'GacScopeDenied')
  })

  it('在原因里指名已声明的作用域，让模型能自我纠正', () => {
    const core = governed(['mod.c'])
    const verdict = core.preExecute(exec('write', { file_path: 'sub/mod.c' }))
    assert.match(verdict.reason, /mod\.c/u)
    assert.match(verdict.reason, /sub\/mod\.c/u)
  })

  it('仍允许 ./mod.c', () => {
    const core = governed(['mod.c'])
    assert.equal(core.preExecute(exec('write', { file_path: './mod.c' })).kind, 'allow')
  })

  it('拒绝大小写变体绕过', () => {
    const core = governed(['mod.c'])
    assert.equal(core.preExecute(exec('write', { file_path: 'SRC/MOD.C' })).kind, 'deny')
  })
})

describe('拒绝是按路径，而不是按调用', () => {
  it('若干个已声明路径中只要有一个越界就拒绝', () => {
    const core = governed(['src/'])
    const verdict = core.preExecute(
      exec('write', { file_path: 'src/ok.c', path: 'other/bad.c' }),
    )
    assert.equal(verdict.kind, 'deny')
    assert.match(verdict.reason, /other\/bad\.c/u)
  })
})

describe('作用域生效期间拒绝 shell 执行器', () => {
  for (const tool of ['pwsh', 'bash']) {
    it(`拒绝 "${tool}" 并说明原因`, () => {
      const core = governed(['src/'])
      const verdict = core.preExecute(exec(tool, { command: 'echo x > src/a.c' }))
      assert.equal(verdict.kind, 'deny')
      assert.equal(verdict.info.code, GAC_CODES.SHELL_DENIED_UNDER_SCOPE)
      assert.match(verdict.reason, /重定向或生成目标/u)
    })
  }
})

describe('作用域生效期间未知工具失败即拒绝', () => {
  it('拒绝运行时无法分类的工具', () => {
    const core = governed(['src/'])
    const verdict = core.preExecute(exec('fs_patch_everything', { file_path: 'src/a.c' }))
    assert.equal(verdict.kind, 'deny')
    assert.equal(verdict.info.code, GAC_CODES.UNGUARDABLE_WRITE_DENIED)
  })

  it('拒绝没有携带可读路径参数的已知写工具', () => {
    const core = governed(['src/'])
    const verdict = core.preExecute(exec('write', { filePath: 'src/a.c' }))
    assert.equal(verdict.kind, 'deny')
    assert.equal(verdict.info.code, GAC_CODES.UNGUARDABLE_WRITE_DENIED)
  })
})

describe('作用域生命周期', () => {
  it('重新声明是替换作用域，而不是把它放宽', () => {
    const core = governed(['src/'])
    core.declareScope({
      session_id: SESSION,
      task_id: 'REQ-1',
      node_id: 'T2',
      write_scope: ['docs/'],
      root: ROOT,
    })
    assert.equal(core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'deny')
    assert.equal(core.preExecute(exec('write', { file_path: 'docs/a.md' })).kind, 'allow')
  })

  it('清除作用域让会话回到无人管辖状态', () => {
    const core = governed(['src/'])
    assert.equal(core.clearScope(SESSION), true)
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'allow')
  })

  it('为诊断上报管辖状态', () => {
    const core = governed(['src/'])
    const view = core.inspect(SESSION)
    assert.equal(view.governed, true)
    assert.equal(view.declaration.task_id, 'REQ-1')
    assert.equal(core.inspect('session-9').governed, false)
  })

  it('拒绝格式错误的声明，而不是存下一个坏掉的作用域', () => {
    const core = createGacCore()
    assert.throws(
      () => core.declareScope({ session_id: '', task_id: 't', node_id: 'n', write_scope: [] }),
      TypeError,
    )
    assert.throws(
      () => core.declareScope({ session_id: 's', task_id: 't', node_id: 'n', write_scope: 'src/' }),
      TypeError,
    )
  })

  it('已声明的空作用域什么都不放行', () => {
    const core = governed([])
    assert.equal(core.preExecute(exec('write', { file_path: 'anything.c' })).kind, 'deny')
  })
})

describe('作用域生效期间作用域工具必须保持可调用', () => {
  // 一个真实缺陷，是在实时会话中运行该门禁、而不是在本套件中发现的：`gac_scope` 不在
  // 已知表里，因此一旦声明了作用域，守卫就会拒绝它。这把作用域变成了陷阱——它无法被
  // 查看、重新声明或释放。
  it('放行 gac_scope，使当前作用域总能被查看', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('gac_scope', {})).kind, 'allow')
  })

  it('放行 gac_scope clear，使作用域总能被释放', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('gac_scope', { clear: true })).kind, 'allow')
  })

  it('放行重新声明，使任务能推进到下一个节点', () => {
    const core = governed(['src/a.c'])
    assert.equal(
      core.preExecute(exec('gac_scope', { task_id: 'REQ-1', node_id: 'T2', scope: ['docs/'] })).kind,
      'allow',
    )
  })

  it('空作用域仍放行作用域工具 —— 陷阱情形', () => {
    // 空作用域下每一次写入都会被拒绝。如果作用域工具也被拒绝，那就再也没有任何东西能
    // 撤销它了。
    const core = governed([])
    assert.equal(core.preExecute(exec('gac_scope', { clear: true })).kind, 'allow')
  })
})

describe('运行时自己的工具不能被它自己执行的作用域挡住', () => {
  // 上一组只修了 `gac_scope` 一个工具。同一张表里其余的 GAC 工具当时仍被算作 `unknown`，
  // 于是**推进任务的那个工具**在作用域生效时会被自己的门禁拒掉：模型写完了文件，却再也
  // 推不动任务，而它看到的只是一句「这个工具无法检查」——正是把作用域变成陷阱的同一个形状。
  const callable = [
    ['gac_task', { action: 'advance', task_id: 'REQ-1' }],
    ['gac_project', { mode: 'standard_task' }],
    ['gac_scope', {}],
    ['gac_evidence', {}],
    ['gac_metrics', {}],
  ]

  for (const [name, args] of callable) {
    it(`放行 ${name}`, () => {
      const core = governed(['src/a.c'])
      assert.equal(core.preExecute(exec(name, args)).kind, 'allow')
    })
  }

  it('空作用域仍放行它们 —— 同一个陷阱最糟糕的形态', () => {
    const core = governed([])
    assert.equal(
      core.preExecute(exec('gac_task', { action: 'advance', task_id: 'REQ-1' })).kind,
      'allow',
    )
  })

  it('产品文件仍被拒绝：放行的是记账，而不是写入面', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'deny')
  })
})

describe('守卫自身的说明', () => {
  it('每一次拒绝都给出模型可以据以行动的原因', () => {
    const core = governed(['src/'])
    const verdicts = [
      core.preExecute(exec('write', { file_path: 'bad.c' })),
      core.preExecute(exec('pwsh', { command: 'echo hi' })),
      core.preExecute(exec('mystery_tool', {})),
    ]
    for (const verdict of verdicts) {
      assert.equal(verdict.kind, 'deny')
      assert.ok(verdict.reason.length > 40, '拒绝原因应当讲清为什么，而不只是点个名')
    }
  })
})
