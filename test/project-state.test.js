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

describe('适配器加载', () => {
  it('加载并校验形式正确的适配器', () => {
    const root = scratchProject(VALID)
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'loaded')
    assert.equal(loaded.adapter.project.id, 'proj')
    // 上报的路径一律使用 `/`，与写作用域匹配器规范化后所采用的约定一致，无论宿主分隔符
    // 是什么。
    assert.ok(loaded.path.endsWith('.dsh/gac/project.json'))
    assert.equal(loaded.path.includes('\\'), false, `路径必须用 / 分隔: ${loaded.path}`)
  })

  it('把缺失的适配器报成 absent，而不是错误', () => {
    // 工程不必被纳管。把它当作失败处理，会让该插件在所有尚未配置它的地方都无法使用。
    const root = scratchProject(undefined)
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'absent')
    assert.match(loaded.note, /不受治理/u)
  })

  it('不抛错地报出畸形 JSON', () => {
    const root = scratchProject('{ not json')
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'invalid')
    assert.match(loaded.note, /不是合法 JSON/u)
  })

  it('报出 schema 违规，并带上校验器给的原因', () => {
    const root = scratchProject(JSON.stringify({ project: {} }))
    const loaded = stateAt(root).loadAdapter(root)
    assert.equal(loaded.status, 'invalid')
    assert.match(loaded.note, /project\.id/u)
  })

  it('在结果里点名适配器路径，坏文件因此可被找到', () => {
    const root = scratchProject(VALID)
    const loaded = stateAt(root).loadAdapter(root)
    // 适配器就在它被要求的位置，且以可读的方式上报。
    assert.ok(loaded.path.startsWith(root.replace(/\\/gu, '/')))
    assert.ok(loaded.path.endsWith(ADAPTER_RELATIVE_PATH))
  })
})

describe('缓存契约', () => {
  it('缓存成功的一次加载，而不是重新读文件', () => {
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

  it('缓存「不存在」，因为每次调用都重新探测等于白做 I/O', () => {
    const root = scratchProject(undefined)
    const state = stateAt(root)
    assert.equal(state.loadAdapter(root).status, 'absent')
    mkdirSync(joinPath(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), VALID, 'utf8')
    assert.equal(state.loadAdapter(root).status, 'absent', '「不存在」会被缓存，直到被遗忘')
  })

  it('「不」缓存无效适配器，于是修好它不需要重启', () => {
    // 最重要的一个：用户编写 project.json 时会先写错一次，然后修好它，并期望修改立即
    // 生效。
    const root = scratchProject('{ broken')
    const state = stateAt(root)
    assert.equal(state.loadAdapter(root).status, 'invalid')
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), VALID, 'utf8')
    assert.equal(state.loadAdapter(root).status, 'loaded')
  })

  it('forget() 让下一次读取反映磁盘上的内容', () => {
    const root = scratchProject(undefined)
    const state = stateAt(root)
    state.loadAdapter(root)
    mkdirSync(joinPath(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(joinPath(root, '.dsh', 'gac', 'project.json'), VALID, 'utf8')
    state.forget(root)
    assert.equal(state.loadAdapter(root).status, 'loaded')
  })
})

describe('模式解析', () => {
  it('原样记录低风险声明', () => {
    const root = scratchProject(VALID)
    const decision = stateAt(root).declareMode({
      session_id: 's1',
      root,
      declared_mode: 'direct_edit',
      reason: '改一个配置项',
      target_paths: ['README.md'],
    })
    assert.equal(decision.mode, 'direct_edit')
    assert.equal(decision.escalated, false)
    assert.equal(decision.risk, 'low')
    assert.equal(decision.project_id, 'proj')
  })

  it('目标落在已声明的高风险路径里时升级', () => {
    const root = scratchProject(VALID)
    const decision = stateAt(root).declareMode({
      session_id: 's1',
      root,
      declared_mode: 'direct_edit',
      reason: '调整一处比较',
      target_paths: ['src/auth/token.c'],
    })
    assert.equal(decision.mode, 'high_risk_task')
    assert.equal(decision.escalated, true)
    assert.equal(decision.escalated_from, 'direct_edit')
    assert.match(decision.reason, /src\/auth\/token\.c/u)
  })

  it('工程没有适配器时把声明标为未核对', () => {
    // 诚实的表述：声明了模式，但没有任何东西能确认它。
    const root = scratchProject(undefined)
    const decision = stateAt(root).declareMode({
      session_id: 's1',
      root,
      declared_mode: 'standard_task',
      reason: '一次普通缺陷修复',
    })
    assert.equal(decision.mode, 'standard_task')
    assert.equal(decision.unchecked, true)
    assert.equal(decision.project_id, null)
  })

  it('拒绝未知模式，而不是退回到某个默认值', () => {
    const root = scratchProject(VALID)
    assert.throws(
      () => stateAt(root).declareMode({ session_id: 's1', root, declared_mode: 'quick_fix' }),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('各会话的模式互不干扰', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 'a', root, declared_mode: 'direct_edit' })
    state.declareMode({ session_id: 'b', root, declared_mode: 'high_risk_task' })
    assert.equal(state.modeFor('a').mode, 'direct_edit')
    assert.equal(state.modeFor('b').mode, 'high_risk_task')
  })

  it('替换会话的模式，而不是累加', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 'a', root, declared_mode: 'high_risk_task' })
    state.declareMode({ session_id: 'a', root, declared_mode: 'direct_edit' })
    assert.equal(state.modeFor('a').mode, 'direct_edit')
  })

  it('清除会话的模式', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 'a', root, declared_mode: 'direct_edit' })
    assert.equal(state.clearMode('a'), true)
    assert.equal(state.modeFor('a'), undefined)
  })
})

describe('检视', () => {
  it('没有工程根目录时报未受治理并说明原因', () => {
    const state = new ProjectState({ resolveRoot: () => undefined })
    const view = state.inspect('s1', undefined)
    assert.equal(view.governed, false)
    assert.match(view.note, /没有可解析的工程根目录/u)
    assert.equal(view.mode, null)
  })

  it('出示适配器、它的高风险路径与它声明的能力', () => {
    const root = scratchProject(VALID)
    const view = stateAt(root).inspect('s1', root)
    assert.equal(view.governed, true)
    assert.equal(view.adapter.project.id, 'proj')
    assert.deepEqual([...view.adapter.risk.high_risk_paths], ['src/auth/', 'src/boot.c'])
    assert.deepEqual([...view.adapter.capabilities], ['implementation', 'verification'])
  })

  it('把会话声明的模式与适配器一并带出', () => {
    const root = scratchProject(VALID)
    const state = stateAt(root)
    state.declareMode({ session_id: 's1', root, declared_mode: 'standard_task' })
    assert.equal(state.inspect('s1', root).mode.mode, 'standard_task')
  })
})
