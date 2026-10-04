/**
 * Guard behaviour tests — the deny path.
 *
 * Architecture outline §22 requires an out-of-scope write to be stopped BEFORE
 * execution, not observed afterwards (§25). This suite is the executable proof
 * of that gate, and it is deliberately written against the shape DSH actually
 * hands a `tools/pre-execute` listener.
 *
 * The suite is also the honest record of what the gate does NOT cover (shell,
 * unknown tools): those cases assert a denial, because the alternative —
 * claiming coverage this seam cannot provide — is the failure the adaptation
 * plan §7 warns about.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GAC_CODES, createGacCore } from '../lib/plugin.js'

const SESSION = 'session-1'
const ROOT = 'D:/work/proj'

/**
 * Build a `ToolExecution`-shaped object as DSH presents it at pre-execute.
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
 * A core with one declared scope for the default session.
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
