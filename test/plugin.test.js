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

describe('ungoverned sessions are left alone', () => {
  it('allows a write when no scope was ever declared', () => {
    const core = createGacCore()
    assert.deepEqual(core.preExecute(exec('write', { file_path: 'anywhere.c' })), { kind: 'allow' })
  })

  it('allows a shell call when no scope was declared', () => {
    const core = createGacCore()
    assert.equal(core.preExecute(exec('pwsh', { command: 'rm -rf /' })).kind, 'allow')
  })

  it('allows a call from a different session', () => {
    const core = governed(['src/a.c'])
    assert.equal(
      core.preExecute(exec('write', { file_path: 'elsewhere.c' }, 'session-2')).kind,
      'allow',
    )
  })

  it('allows a call it cannot attribute to a session', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute({ name: 'write', arguments: { file_path: 'x.c' } }).kind, 'allow')
  })
})

describe('in-scope writes pass', () => {
  it('allows an exact declared file', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'allow')
  })

  it('allows a file inside a declared directory', () => {
    const core = governed(['src/'])
    assert.equal(core.preExecute(exec('edit', { file_path: 'src/deep/b.c' })).kind, 'allow')
  })

  it('allows an absolute path that resolves inside the scope', () => {
    const core = governed(['src/a.c'])
    assert.equal(
      core.preExecute(exec('write', { file_path: `${ROOT}/src/a.c` })).kind,
      'allow',
    )
  })

  it('allows a read tool regardless of scope', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('read', { file_path: 'docs/readme.md' })).kind, 'allow')
  })
})

describe('the E2E-4 case: authority.write = ["mod.c"], agent tries sub/mod.c', () => {
  it('denies before execution', () => {
    const core = governed(['mod.c'])
    const verdict = core.preExecute(exec('write', { file_path: 'sub/mod.c' }))
    assert.equal(verdict.kind, 'deny')
  })

  it('carries the structured code so the caller need not parse prose', () => {
    const core = governed(['mod.c'])
    const verdict = core.preExecute(exec('write', { file_path: 'sub/mod.c' }))
    assert.equal(verdict.info.code, GAC_CODES.WRITE_SCOPE_DENIED)
    assert.equal(verdict.info.name, 'GacScopeDenied')
  })

  it('names the declared scope in the reason so the model can correct itself', () => {
    const core = governed(['mod.c'])
    const verdict = core.preExecute(exec('write', { file_path: 'sub/mod.c' }))
    assert.match(verdict.reason, /mod\.c/u)
    assert.match(verdict.reason, /sub\/mod\.c/u)
  })

  it('still allows ./mod.c', () => {
    const core = governed(['mod.c'])
    assert.equal(core.preExecute(exec('write', { file_path: './mod.c' })).kind, 'allow')
  })

  it('denies a case-variant escape', () => {
    const core = governed(['mod.c'])
    assert.equal(core.preExecute(exec('write', { file_path: 'SRC/MOD.C' })).kind, 'deny')
  })
})

describe('denial is per-path, not per-call', () => {
  it('denies when only one of several declared paths is out of scope', () => {
    const core = governed(['src/'])
    const verdict = core.preExecute(
      exec('write', { file_path: 'src/ok.c', path: 'other/bad.c' }),
    )
    assert.equal(verdict.kind, 'deny')
    assert.match(verdict.reason, /other\/bad\.c/u)
  })
})

describe('shell executors are denied while a scope is active', () => {
  for (const tool of ['pwsh', 'bash']) {
    it(`denies "${tool}" and says why`, () => {
      const core = governed(['src/'])
      const verdict = core.preExecute(exec(tool, { command: 'echo x > src/a.c' }))
      assert.equal(verdict.kind, 'deny')
      assert.equal(verdict.info.code, GAC_CODES.SHELL_DENIED_UNDER_SCOPE)
      assert.match(verdict.reason, /redirection|generator/u)
    })
  }
})

describe('unknown tools fail closed while a scope is active', () => {
  it('denies a tool the runtime cannot classify', () => {
    const core = governed(['src/'])
    const verdict = core.preExecute(exec('fs_patch_everything', { file_path: 'src/a.c' }))
    assert.equal(verdict.kind, 'deny')
    assert.equal(verdict.info.code, GAC_CODES.UNGUARDABLE_WRITE_DENIED)
  })

  it('denies a known write tool that carried no readable path argument', () => {
    const core = governed(['src/'])
    const verdict = core.preExecute(exec('write', { filePath: 'src/a.c' }))
    assert.equal(verdict.kind, 'deny')
    assert.equal(verdict.info.code, GAC_CODES.UNGUARDABLE_WRITE_DENIED)
  })
})

describe('scope lifecycle', () => {
  it('re-declaring replaces the scope instead of widening it', () => {
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

  it('clearing a scope returns the session to ungoverned', () => {
    const core = governed(['src/'])
    assert.equal(core.clearScope(SESSION), true)
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'allow')
  })

  it('reports governance state for diagnostics', () => {
    const core = governed(['src/'])
    const view = core.inspect(SESSION)
    assert.equal(view.governed, true)
    assert.equal(view.declaration.task_id, 'REQ-1')
    assert.equal(core.inspect('session-9').governed, false)
  })

  it('refuses a malformed declaration rather than storing a broken scope', () => {
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

  it('an empty declared scope permits nothing', () => {
    const core = governed([])
    assert.equal(core.preExecute(exec('write', { file_path: 'anything.c' })).kind, 'deny')
  })
})

describe('the scope tool must stay callable while a scope is active', () => {
  // 一个真实缺陷，是在实时会话中运行该门禁、而不是在本套件中发现的：`gac_scope` 不在
  // 已知表里，因此一旦声明了作用域，守卫就会拒绝它。这把作用域变成了陷阱——它无法被
  // 查看、重新声明或释放。
  it('allows gac_scope, so the current scope can always be inspected', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('gac_scope', {})).kind, 'allow')
  })

  it('allows gac_scope clear, so a scope can always be released', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('gac_scope', { clear: true })).kind, 'allow')
  })

  it('allows re-declaring, so a task can advance to its next node', () => {
    const core = governed(['src/a.c'])
    assert.equal(
      core.preExecute(exec('gac_scope', { task_id: 'REQ-1', node_id: 'T2', scope: ['docs/'] })).kind,
      'allow',
    )
  })

  it('an empty scope still permits the scope tool — the trap case', () => {
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
    it(`allows ${name}`, () => {
      const core = governed(['src/a.c'])
      assert.equal(core.preExecute(exec(name, args)).kind, 'allow')
    })
  }

  it('an empty scope still permits them — the worst shape of the same trap', () => {
    const core = governed([])
    assert.equal(
      core.preExecute(exec('gac_task', { action: 'advance', task_id: 'REQ-1' })).kind,
      'allow',
    )
  })

  it('product files are still refused: what is allowed is bookkeeping, not the write surface', () => {
    const core = governed(['src/a.c'])
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'deny')
  })
})

describe('the nomination of the guard itself', () => {
  it('every denial states a reason a model can act on', () => {
    const core = governed(['src/'])
    const verdicts = [
      core.preExecute(exec('write', { file_path: 'bad.c' })),
      core.preExecute(exec('pwsh', { command: 'echo hi' })),
      core.preExecute(exec('mystery_tool', {})),
    ]
    for (const verdict of verdicts) {
      assert.equal(verdict.kind, 'deny')
      assert.ok(verdict.reason.length > 40, 'reason should explain the refusal, not just name it')
    }
  })
})
