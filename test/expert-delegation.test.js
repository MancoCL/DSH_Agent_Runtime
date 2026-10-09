import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExpertHelpers } from '../lib/tool-expert.js'
import { createChildBindings } from '../lib/child-binding.js'
import { roleDenyFor } from '../lib/role-tools.js'

function harness(role = 'test_design') {
  const root = mkdtempSync(join(tmpdir(), 'gac-helper-'))
  const bindings = createChildBindings({ registry: { declare() {} } })
  const parent = { session: { id: 'expert', header: { delegationDepth: 1 } } }
  const identity = { child_session_id: 'expert', task_id: 'task', node_id: 'D', dispatch_id: 'attempt-1', attempt: 1, role, write_scope: [] }
  bindings.declareRole(identity)
  const requests = []
  const notices = []
  const disposals = []
  const surface = { bind() {}, unbind() {} }
  let current = true
  const helpers = new ExpertHelpers({ root, bindings, surface, isCurrent: () => current, namesFor: () => ['read', 'write', 'pwsh', 'gac_task', 'gac_expert', 'spawn', 'structured_output'], notify: async (_, message) => notices.push(message), subagentsFor: () => ({ start: async (_, request) => {
    const id = `helper-${requests.length}`
    const pending = {}
    const result = new Promise((resolve) => { pending.resolve = resolve; request.signal.addEventListener('abort', () => resolve({ structured: { status: 'completed', summary: '迟到结果', artifact: '旧产物' } }), { once: true }) })
    requests.push({ ...pending, request, id })
    return { id, result, dispose: async () => disposals.push(id) }
  } }) })
  const signal = new AbortController()
  helpers.openParent('expert', identity, signal.signal, '冻结需求及测试入口')
  return { root, helpers, parent, requests, notices, disposals, signal, invalidate: () => { current = false }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const question = { question: '补充边界条件', expected_artifact: '边界条件列表' }

test('助手只见授权上下文且盲化继承；结果返回父专家，不能再次委派', async () => {
  const h = harness()
  try {
    const started = h.helpers.start(h.parent, question)
    await Promise.resolve()
    const request = h.requests[0].request
    assert.equal(request.maxDepth, 2)
    assert.match(request.prompt[0].text, /冻结需求及测试入口/u)
    for (const name of ['read', 'write', 'pwsh', 'gac_task', 'gac_expert', 'spawn']) assert.ok(request.toolFilter.deny.includes(name))
    assert.throws(() => h.helpers.start({ session: { id: 'helper-0', header: { delegationDepth: 2 } } }, question), /PARENT_INVALID/u)
    h.requests[0].resolve({ structured: { status: 'completed', summary: '已补边界', artifact: '空值与越界' } })
    await h.helpers.parents.get('expert').helpers.get(started.helper_id).done
    assert.equal(h.helpers.status(h.parent, started.helper_id).result.artifact, '空值与越界')
    assert.equal(h.notices.length, 1)
    assert.equal(h.disposals.length, 1)
    assert.throws(() => h.helpers.status(h.parent, 'foreign'), /OWNER_MISMATCH/u)
  } finally { await h.helpers.closeParent('expert'); h.cleanup() }
})

test('并发与累计预算按父派遣限制；失效父 attempt 和其他角色拒绝', async () => {
  const h = harness('software_design')
  try {
    for (let wave = 0; wave < 2; wave++) {
      const a = h.helpers.start(h.parent, question)
      const b = h.helpers.start(h.parent, question)
      assert.throws(() => h.helpers.start(h.parent, question), /BUDGET_EXCEEDED/u)
      await Promise.resolve()
      for (const request of h.requests.slice(wave * 2)) request.resolve({ structured: { status: 'completed', summary: '完成', artifact: '产物' } })
      await Promise.all([a, b].map((entry) => h.helpers.parents.get('expert').helpers.get(entry.helper_id).done))
    }
    assert.throws(() => h.helpers.start(h.parent, question), /BUDGET_EXCEEDED/u)
    h.invalidate()
    assert.throws(() => h.helpers.start(h.parent, question), /PARENT_INVALID/u)
    assert.ok(roleDenyFor({ role: 'implementation', name: 'gac_expert', write_scope: ['src/'] }))
    assert.ok(roleDenyFor({ role: 'software_design_assistant', name: 'pwsh', write_scope: [] }))
  } finally { await h.helpers.closeParent('expert'); h.cleanup() }
})

test('父取消后迟到助手结果不得成为成功产物，资源全部释放', async () => {
  const h = harness()
  try {
    const started = h.helpers.start(h.parent, question)
    await Promise.resolve()
    const record = h.helpers.parents.get('expert').helpers.get(started.helper_id)
    h.signal.abort()
    await h.helpers.closeParent('expert')
    assert.equal(record.status, 'cancelled')
    assert.equal(record.result, undefined)
    assert.equal(h.disposals.length, 1)
    assert.equal(h.notices.length, 0)
  } finally { h.cleanup() }
})
