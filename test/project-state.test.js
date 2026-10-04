/**
 * Project-state tests: loading the adapter from disk and resolving modes.
 *
 * The interesting behaviour here is not "does it read a file" but the caching
 * contract, because a wrong cache turns a fixable mistake into one that needs a
 * restart:
 *
 *  - an absent adapter IS cached (re-probing every call is I/O for nothing);
 *  - an absent adapter is NOT an error (a project need not be adopted);
 *  - an INVALID adapter is NOT cached, because it is a transient authoring
 *    mistake a user is likely fixing right now.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { after, describe, it } from 'node:test'

import { ADAPTER_RELATIVE_PATH, ProjectState } from '../lib/project-state.js'

/** Roots to remove when the suite finishes. */
const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/**
 * A scratch project root with an optional adapter file.
 *
 * @param {string|undefined} adapterText
 * @returns {string} the root.
 */
function scratchProject(adapterText) {
  const root = mkdtempSync(joinPath(tmpdir(), 'gac-project-'))
  scratchRoots.push(root)
  if (adapterText !== undefined) {
    mkdirSync(joinPath(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), adapterText, 'utf8')
  }
  return root
}

/** A valid adapter with two high-risk paths. */
const VALID = JSON.stringify({
  schema_version: 1,
  project: { id: 'proj', title: 'Proj' },
  capabilities: ['implementation', 'verification'],
  executors: { implementation: ['builder'], verification: ['verifier'] },
  risk: { high_risk_paths: ['src/auth/', 'src/boot.c'], default_level: 'low' },
})

/**
 * A state instance whose root resolver returns a fixed root.
 *
 * @param {string} root
 * @returns {ProjectState}
 */
function stateAt(root) {
  return new ProjectState({ resolveRoot: () => root })
}

describe('adapter loading', () => {
  it('loads and validates a well-formed adapter', () => {
    const root = scratchProject(VALID)
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'loaded')
    assert.equal(loaded.adapter.project.id, 'proj')
    // Reported paths use `/` throughout, matching the convention the
    // write-scope matcher normalises to, whatever the host separator is.
    assert.ok(loaded.path.endsWith('.dsh/gac/project.json'))
    assert.equal(loaded.path.includes('\\'), false, `path must be /-separated: ${loaded.path}`)
  })

  it('reports a missing adapter as absent, not as an error', () => {
    // A project need not be adopted. Treating this as a failure would make the
    // plugin unusable everywhere it has not been configured.
    const root = scratchProject(undefined)
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'absent')
    assert.match(loaded.note, /ungoverned/u)
  })

  it('reports malformed JSON without throwing', () => {
    const root = scratchProject('{ not json')
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'invalid')
    assert.match(loaded.note, /not valid JSON/u)
  })

  it('reports a schema violation with the validator’s reason', () => {
    const root = scratchProject(JSON.stringify({ project: {} }))
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'invalid')
    assert.match(loaded.note, /project\.id/u)
  })

  it('names the adapter path in its result, so a bad file is findable', () => {
    const root = scratchProject(VALID)
    const loaded = stateAt(root).loadAdapter(root)
    // The adapter is where it was asked to be, reported readably.
    assert.ok(loaded.path.startsWith(root.replace(/\\/gu, '/')))
    assert.ok(loaded.path.endsWith(ADAPTER_RELATIVE_PATH))
  })
})

describe('caching contract', () => {
  it('caches a successful load rather than re-reading the file', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.loadAdapter(root)
    // Change the file on disk; the cached result must not follow.
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), JSON.stringify({
      ...JSON.parse(VALID),
      project: { id: 'changed' },
    }), 'utf8')
    assert.equal(state.loadAdapter(root).adapter.project.id, 'proj')
  })

  it('caches absence, because re-probing every call is I/O for nothing', () => {
    const root = scratchProject(undefined)
    const state = stateAt(root)
    assert.equal(state.loadAdapter(root).status, 'absent')
    mkdirSync(joinPath(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), VALID, 'utf8')
    assert.equal(state.loadAdapter(root).status, 'absent', 'absence is cached until forgotten')
  })

  it('does NOT cache an invalid adapter, so a fix needs no restart', () => {
    // The important one: a user authoring project.json will get it wrong once,
    // fix it, and expect the fix to take effect.
    const root = scratchProject('{ broken')
    const state = stateAt(root)
    assert.equal(state.loadAdapter(root).status, 'invalid')
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), VALID, 'utf8')
    assert.equal(state.loadAdapter(root).status, 'loaded')
  })

  it('forget() makes the next read reflect the disk', () => {
    const root = scratchProject(undefined)
    const state = stateAt(root)
    state.loadAdapter(root)
    mkdirSync(joinPath(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), VALID, 'utf8')
    state.forget(root)
    assert.equal(state.loadAdapter(root).status, 'loaded')
  })
})

describe('mode resolution', () => {
  it('records a low-risk declaration unchanged', () => {
    const root = scratchProject(VALID)
    const decision = stateAt(root).declareMode({
      session_id: 's1',
      root,
      declared_mode: 'direct_edit',
      reason: 'one config value',
      target_paths: ['README.md'],
    })
    assert.equal(decision.mode, 'direct_edit')
    assert.equal(decision.escalated, false)
    assert.equal(decision.risk, 'low')
    assert.equal(decision.project_id, 'proj')
  })

  it('escalates when a target falls in a declared high-risk path', () => {
    const root = scratchProject(VALID)
    const decision = stateAt(root).declareMode({
      session_id: 's1',
      root,
      declared_mode: 'direct_edit',
      reason: 'tweak one comparison',
      target_paths: ['src/auth/token.c'],
    })
    assert.equal(decision.mode, 'high_risk_task')
    assert.equal(decision.escalated, true)
    assert.equal(decision.escalated_from, 'direct_edit')
    assert.match(decision.reason, /src\/auth\/token\.c/u)
  })

  it('marks a declaration unchecked when the project has no adapter', () => {
    // The honest state: a mode was declared but nothing could confirm it.
    const root = scratchProject(undefined)
    const decision = stateAt(root).declareMode({
      session_id: 's1',
      root,
      declared_mode: 'standard_task',
      reason: 'a normal bugfix',
    })
    assert.equal(decision.mode, 'standard_task')
    assert.equal(decision.unchecked, true)
    assert.equal(decision.project_id, null)
  })

  it('rejects an unknown mode rather than defaulting to something', () => {
    const root = scratchProject(VALID)
    assert.throws(
      () => stateAt(root).declareMode({ session_id: 's1', root, declared_mode: 'quick_fix' }),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('keeps each session’s mode separate', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 'a', root, declared_mode: 'direct_edit' })
    state.declareMode({ session_id: 'b', root, declared_mode: 'high_risk_task' })
    assert.equal(state.modeFor('a').mode, 'direct_edit')
    assert.equal(state.modeFor('b').mode, 'high_risk_task')
  })

  it('replaces a session’s mode rather than accumulating', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 'a', root, declared_mode: 'high_risk_task' })
    state.declareMode({ session_id: 'a', root, declared_mode: 'direct_edit' })
    assert.equal(state.modeFor('a').mode, 'direct_edit')
  })

  it('clears a session’s mode', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 'a', root, declared_mode: 'direct_edit' })
    assert.equal(state.clearMode('a'), true)
    assert.equal(state.modeFor('a'), undefined)
  })
})

describe('inspection', () => {
  it('reports ungoverned and says why when there is no project root', () => {
    const state = new ProjectState({ resolveRoot: () => undefined })
    const view = state.inspect('s1', undefined)
    assert.equal(view.governed, false)
    assert.match(view.note, /no resolvable project root/u)
    assert.equal(view.mode, null)
  })

  it('surfaces the adapter, its high-risk paths and its capabilities', () => {
    const root = scratchProject(VALID)
    const view = stateAt(root).inspect('s1', root)
    assert.equal(view.governed, true)
    assert.equal(view.adapter.project.id, 'proj')
    assert.deepEqual([...view.adapter.risk.high_risk_paths], ['src/auth/', 'src/boot.c'])
    assert.deepEqual([...view.adapter.capabilities], ['implementation', 'verification'])
  })

  it('carries the session’s declared mode alongside the adapter', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 's1', root, declared_mode: 'standard_task' })
    assert.equal(state.inspect('s1', root).mode.mode, 'standard_task')
  })
})
