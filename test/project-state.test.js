/**
 * 工程状态测试：从磁盘加载适配器并解析执行模式。
 *
 * 这里有趣的行为不是「它会不会读文件」，而是缓存契约，因为错误的缓存会把一个本可修好的
 * 失误变成需要重启才能解决：
 *
 *  - 适配器缺失「会」被缓存（每次调用都重新探测纯属无谓的 I/O）；
 *  - 适配器缺失「不是」错误（工程不必被纳管）；
 *  - 适配器「无效」时「不」缓存，因为那是一个转瞬即逝的编写失误，用户很可能正在修
 *    它。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { after, describe, it } from 'node:test'

import { ADAPTER_RELATIVE_PATH, ProjectState } from '../lib/project-state.js'

/** 套件结束时需要删除的根目录。 */
const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/**
 * 一个临时的工程根目录，可附带一个适配器文件。
 *
 * @param {string|undefined} adapterText
 * @returns {string} 根目录。
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

/** 一个合法的适配器，含两条高风险路径。 */
const VALID = JSON.stringify({
  schema_version: 1,
  project: { id: 'proj', title: 'Proj' },
  capabilities: ['implementation', 'verification'],
  executors: { implementation: ['builder'], verification: ['verifier'] },
  risk: { high_risk_paths: ['src/auth/', 'src/boot.c'], default_level: 'low' },
})

/**
 * 一个状态实例，其根目录解析器返回固定的根目录。
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
    // 上报的路径一律使用 `/`，与写作用域匹配器规范化后所采用的约定一致，无论宿主分隔符
    // 是什么。
    assert.ok(loaded.path.endsWith('.dsh/gac/project.json'))
    assert.equal(loaded.path.includes('\\'), false, `path must be /-separated: ${loaded.path}`)
  })

  it('reports a missing adapter as absent, not as an error', () => {
    // 工程不必被纳管。把它当作失败处理，会让该插件在所有尚未配置它的地方都无法使用。
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
    // 适配器就在它被要求的位置，且以可读的方式上报。
    assert.ok(loaded.path.startsWith(root.replace(/\\/gu, '/')))
    assert.ok(loaded.path.endsWith(ADAPTER_RELATIVE_PATH))
  })
})

describe('caching contract', () => {
  it('caches a successful load rather than re-reading the file', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.loadAdapter(root)
    // 改动磁盘上的文件；缓存结果不应随之改变。
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
    // 最重要的一个：用户编写 project.json 时会先写错一次，然后修好它，并期望修改立即
    // 生效。
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
    // 诚实的表述：声明了模式，但没有任何东西能确认它。
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
