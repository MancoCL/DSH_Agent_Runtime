/**
 * 系统提示段落的测试。
 *
 * 这里断言的是两件不同的事，分开写：
 *
 *  1. **它说了什么**：段落是模型唯一的「此刻声明了什么」来源，说漏一句就是一段只能靠
 *     被拒绝来发现的状态。
 *  2. **它永不抛错**：段落的 text 在提示装配管线里被直接调用，一旦抛出，本会话的每一个
 *     模型步进都会失败——包括模型拿来修它的那一步。这一条比第一条重要得多，所以它单独
 *     成组，并且拿畸形输入与抛错的状态读取器来打。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GAC_CODES } from '../lib/plugin.js'
import { EXECUTION_MODES } from '../lib/project.js'
import { ADAPTER_RELATIVE_PATH } from '../lib/project-state.js'
import {
  MODE_OBLIGATIONS,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  createPromptSection,
  gacPromptText,
} from '../lib/prompt-section.js'

/** 一个已加载适配器的最小形状。 */
const adapter = { project: { id: 'demo-project', title: 'Demo' }, risk: { high_risk_paths: ['lib/x.js'] } }

/**
 * 造一个模式记录，只填测试关心的字段。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function mode(overrides = {}) {
  return {
    mode: 'standard_task',
    declared_mode: 'standard_task',
    escalated: false,
    risk: 'medium',
    reason: '行为有变更，需要真实测试',
    ...overrides,
  }
}

/**
 * 造一个写作用域声明。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function scope(overrides = {}) {
  return {
    session_id: 'session-1',
    task_id: 'REQ-DEMO',
    node_id: 'build',
    write_scope: ['lib/', 'test/prompt-section.test.js'],
    ...overrides,
  }
}

describe('段落什么时候出现、什么时候整段消失', () => {
  it('未纳管且什么都没声明时不发声', () => {
    assert.equal(gacPromptText({}), '')
    assert.equal(gacPromptText({ adapter: null, mode: null, scope: null }), '')
  })

  it('工程已纳管就发声，哪怕本会话还没声明任何东西', () => {
    const text = gacPromptText({ adapter })
    assert.notEqual(text, '')
    // 这就是本段落存在的全部理由：在模型撞上第一道拒绝之前，先让它知道门禁在。
    assert.match(text, /gac_project/u)
    assert.match(text, /gac_scope/u)
    assert.ok(text.includes(ADAPTER_RELATIVE_PATH), '应当指出纳管凭据在哪个文件里')
    assert.match(text, /还没有声明执行模式/u)
  })

  it('未纳管却声明了模式时，如实说明没有做过高风险路径核对', () => {
    const text = gacPromptText({ mode: mode() })
    assert.match(text, /没有 GAC 适配器/u)
    assert.match(text, /没有与已声明的高风险路径做过核对/u)
  })

  it('未纳管却只声明了写作用域时，也能说清自己处于什么状态', () => {
    const text = gacPromptText({ scope: scope() })
    assert.match(text, /没有 GAC 适配器/u)
    assert.match(text, /REQ-DEMO/u)
  })
})

describe('子会话读到的是另一套话（活体验收抓到的误导）', () => {
  it('子会话不再被劝去用 gac_project / gac_scope —— 那两个工具根本不在它手里', () => {
    // 实测：被派遣的子会话里也装着这段提示，于是它读到「先用 gac_project 声明模式、用 gac_scope
    // 声明路径」——可它的授权由派遣者绑定，协调类工具也不在它的工具面里。子会话自己都在推理里
    // 记下了这处冲突。门禁行为是对的，但这段话在主动误导它。
    const text = gacPromptText({ adapter, child: true })
    assert.doesNotMatch(text, /先用 gac_project/u)
    assert.doesNotMatch(text, /用 gac_scope 声明/u)
    assert.match(text, /被派遣的子会话/u)
    assert.match(text, /不能从会话内部扩大/u)
    assert.match(text, /不在你的工具面里/u)
  })

  it('子会话的写作用域被说成「派遣者绑定」，而不是「本会话声明」', () => {
    const text = gacPromptText({
      adapter,
      child: true,
      scope: scope({ origin: 'runtime', child_session_id: 'child-1', dispatch_id: 'REQ-DEMO-T1-A1' }),
    })
    assert.match(text, /由派遣者绑定/u)
    assert.match(text, /不是你自报的/u)
    assert.match(text, /越界的写入会在执行前被拒绝/u)
    assert.doesNotMatch(text, /本会话声明的写作用域/u)
  })

  it('子会话不再被告知「引用证据号之前先用 gac_evidence 列出它们」', () => {
    // 那句建议只对**手里有那个工具**的会话成立。子会话那段话里仍然会出现 `gac_evidence` 这个词——
    // 因为它在列举「这些协调类工具不在你的工具面里」——所以断言要落在**建议**上，而不是词频上。
    const text = gacPromptText({ adapter, child: true })
    assert.doesNotMatch(text, /先用 gac_evidence 列出它们/u)
    assert.match(text, /不在你的工具面里/u)
  })

  it('非子会话的行为一个字都没变', () => {
    const text = gacPromptText({ adapter })
    assert.match(text, /先用 gac_project 声明最低的充分模式/u)
    assert.match(text, /gac_evidence/u)
  })
})

describe('段落说出的当前模式', () => {
  it('带上模式、风险与理由', () => {
    const text = gacPromptText({ adapter, mode: mode() })
    assert.match(text, /standard_task/u)
    assert.match(text, /风险 medium/u)
    assert.match(text, /行为有变更，需要真实测试/u)
  })

  it('升级过的模式会说出它从哪里升上来的', () => {
    const text = gacPromptText({
      adapter,
      mode: mode({ mode: 'high_risk_task', declared_mode: 'direct_edit', escalated: true, escalated_from: 'direct_edit', risk: 'high' }),
    })
    assert.match(text, /从 `direct_edit` 升级而来/u)
  })

  it('未核对的声明会在段落里被标记出来', () => {
    const text = gacPromptText({ adapter, mode: mode({ unchecked: true }) })
    assert.match(text, /没有做过交叉核对/u)
  })

  it('每一级模式都有一句义务，且真会出现在段落里', () => {
    // 漏写一级模式在别处是静默的：模型只是不知道自己在什么承诺之下。这里让它变红。
    for (const name of EXECUTION_MODES) {
      const obligation = MODE_OBLIGATIONS[name]
      assert.equal(typeof obligation, 'string', `模式 ${name} 缺一句义务`)
      assert.ok(obligation.length > 0, `模式 ${name} 的义务句是空的`)
      const text = gacPromptText({ adapter, mode: mode({ mode: name }) })
      assert.ok(text.includes(obligation), `段落里没有 ${name} 的义务句`)
    }
  })
})

describe('段落说出的当前写作用域', () => {
  it('列出任务、节点与允许写入的路径', () => {
    const text = gacPromptText({ adapter, mode: mode(), scope: scope() })
    assert.match(text, /任务 `REQ-DEMO`/u)
    assert.match(text, /节点 `build`/u)
    assert.match(text, /lib\//u)
    assert.match(text, /test\/prompt-section\.test\.js/u)
  })

  it('三个拒绝码从契约处取，不是在这里另抄一份', () => {
    const text = gacPromptText({ adapter, mode: mode(), scope: scope() })
    for (const code of [
      GAC_CODES.WRITE_SCOPE_DENIED,
      GAC_CODES.SHELL_DENIED_UNDER_SCOPE,
      GAC_CODES.UNGUARDABLE_WRITE_DENIED,
    ]) {
      assert.ok(text.includes(code), `段落里缺少拒绝码 ${code}`)
    }
    assert.match(text, /不是要绕开的障碍/u)
  })

  it('空作用域说的是「什么都不许写」，而不是留白', () => {
    const text = gacPromptText({ adapter, mode: mode(), scope: scope({ write_scope: [] }) })
    assert.match(text, /\[无\]/u)
  })

  it('声明了任务级模式却没有作用域时，说明还没有任何写入在被检查', () => {
    const text = gacPromptText({ adapter, mode: mode() })
    assert.match(text, /没有写作用域生效/u)
  })

  it('作用域里的路径只取字符串，别的类型被忽略而不是渲染成 [object Object]', () => {
    const text = gacPromptText({
      adapter,
      mode: mode(),
      scope: scope({ write_scope: ['lib/', 42, null, { path: 'x' }, 'test/'] }),
    })
    assert.match(text, /\[lib\/, test\/\]/u)
    assert.doesNotMatch(text, /object/iu)
  })
})

describe('段落永不把异常交给装配管线', () => {
  const hostile = [
    undefined,
    null,
    {},
    { agent: {} },
    { agent: { session: {} } },
    { agent: { session: { id: 42 } } },
    { agent: { session: { id: '' } } },
  ]

  it('状态读取器抛错时返回空串，并把异常交给诊断出口', () => {
    const seen = []
    const section = createPromptSection({
      adapterFor: () => { throw new Error('适配器读取器抛错') },
      modeFor: () => mode(),
      scopeFor: () => undefined,
      onError: (error) => seen.push(error),
    })
    const text = section.text({ agent: { session: { id: 'session-1' } } })
    assert.equal(text, '')
    assert.equal(seen.length, 1)
    assert.match(seen[0].message, /适配器读取器抛错/u)
  })

  it('诊断出口自己也抛错时依然是空串', () => {
    const section = createPromptSection({
      modeFor: () => { throw new Error('炸了') },
      onError: () => { throw new Error('诊断出口也坏了') },
    })
    assert.equal(section.text({ agent: { session: { id: 'session-1' } } }), '')
  })

  it('没有会话（全局装配）时不发声', () => {
    const section = createPromptSection({
      adapterFor: () => { throw new Error('这个读取器根本不该被调用') },
    })
    for (const context of hostile) {
      const text = section.text(context)
      assert.equal(text, '', `context ${JSON.stringify(context)} 应当得到空串`)
    }
  })

  it('对任何畸形输入都只返回字符串，绝不抛错', () => {
    const inputs = [
      {}, null, undefined,
      { adapter: 'governed' }, { adapter: [] }, { adapter: 42 },
      { mode: 'standard_task' }, { mode: [] },
      { scope: 'lib/' }, { scope: [] },
      { adapter, mode: { mode: 42, risk: null, reason: {} } },
      { adapter, scope: { write_scope: 'lib/', task_id: 7, node_id: [] } },
    ]
    for (const input of inputs) {
      let text
      assert.doesNotThrow(() => { text = gacPromptText(input) }, `输入 ${JSON.stringify(input)} 不该抛错`)
      assert.equal(typeof text, 'string', `输入 ${JSON.stringify(input)} 必须得到字符串`)
    }
  })

  it('生成的文本可能含 {{，所以段落必须关掉插值', () => {
    // 工程 id、声明理由、写入路径都是模型/工程给的原文，本模块**不改写**它们（把 `{{`
    // 洗成 `{ {` 是拿数据迁就一条性质）。于是插值必须关掉：一旦开着，一个带 `{{` 的
    // 路径会让**每一步**装配在渲染期抛错。这条断言把两件事绑在一起——文本里真会出现
    // `{{`，而那时的唯一保险就是 interpolate:false。
    const text = gacPromptText({
      adapter: { project: { id: 'a{{b}}c' } },
      mode: mode({ reason: '{{unknown-variable}}' }),
      scope: scope({ write_scope: ['{{weird}}/'] }),
    })
    assert.match(text, /\{\{/u, '原文被改写了，这条绑定就失去意义，需要重新审视')
    if (/\{\{/u.test(text)) {
      assert.equal(createPromptSection({}).interpolate, false, '文本可能含 {{，关掉插值是唯一的保险')
    }
  })

  it('段落定义带着那两条保命性质：不插值，顺序是有限数', () => {
    const section = createPromptSection({})
    assert.equal(section.name, PROMPT_SECTION_NAME)
    assert.equal(section.order, PROMPT_SECTION_ORDER)
    assert.ok(Number.isFinite(section.order), 'systemPrompt.section() 会拒绝非有限顺序')
    assert.equal(section.interpolate, false)
    assert.equal(typeof section.text, 'function')
  })
})
