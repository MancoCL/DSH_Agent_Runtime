/**
 * 工程适配器测试。
 *
 * 这里有两项性质是重要的，并被直接断言：
 *
 *  1. 通用运行时不含任何工程事实（架构大纲 §2.4、§15、§50）。「无工程事实泄漏」套件
 *     会读取库源码，一旦其中出现某个工程专属词就失败。
 *  2. 声明的执行模式会与工程声明的高风险路径交叉核对，这样「从最低的充分级别开始」就
 *     不可能变成「声称最低级别」（大纲 §5、§6、§7）。
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  EXECUTION_MODES,
  ProjectAdapterError,
  RISK_LEVELS,
  isHighRiskPath,
  loadProjectAdapterFromText,
  modeForRisk,
  modeRank,
  modeToRisk,
  resolveExecutionMode,
  validateProjectAdapter,
} from '../lib/project.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** 一个最小的合法适配器，每个测试各自建立，这样变更不会泄漏到别处。 */
function adapter(overrides = {}) {
  return validateProjectAdapter({
    schema_version: 1,
    project: { id: 'example-project', title: 'Example' },
    capabilities: ['implementation', 'verification'],
    executors: {
      implementation: ['builder'],
      verification: ['verifier'],
    },
    risk: { high_risk_paths: ['src/boot/**', 'src/auth/**'], default_level: 'low' },
    ...overrides,
  })
}

describe('validateProjectAdapter — accepts a well-formed adapter', () => {
  it('freezes the result so later mutation cannot change policy', () => {
    const parsed = adapter()
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.risk.high_risk_paths), true)
    assert.throws(() => {
      parsed.risk.high_risk_paths.push('src/evil.c')
    }, TypeError)
  })

  it('defaults memory scope to the outline §13 allow-list', () => {
    const parsed = adapter()
    assert.deepEqual([...parsed.memory.allow], ['current_project', 'global_reusable'])
    assert.deepEqual([...parsed.memory.deny_as_project_fact], ['foreign_project', 'unknown'])
  })
})

describe('execution 一节 —— 运行时真正读取的字段必须能通过校验', () => {
  it('未声明时给出去掉猜测的默认值', () => {
    // 校验器不认识的字段，运行时也不该去读。反过来同样成立：运行时读的字段，校验器必须
    // 放行——否则适配器里写了会被整体拒绝，不写则永远读到 undefined，而读到的空值看起来
    // 与「没有配置」一模一样。
    const parsed = adapter()
    assert.deepEqual({ ...parsed.execution.provider_routes }, {})
    assert.deepEqual([...parsed.execution.require_contract], [])
  })

  it('接受 provider_routes 并冻结每一层', () => {
    const parsed = adapter({
      execution: { provider_routes: { verifier: { provider: 'p', model: 'm' } } },
    })
    assert.equal(parsed.execution.provider_routes.verifier.model, 'm')
    assert.equal(Object.isFrozen(parsed.execution.provider_routes.verifier), true)
    assert.throws(() => { parsed.execution.provider_routes.verifier.model = 'x' }, TypeError)
  })

  it('拒绝空的 provider 或 model', () => {
    assert.throws(
      () => adapter({ execution: { provider_routes: { verifier: { model: '' } } } }),
      /non-empty string/u,
    )
  })

  it('拒绝非对象的 provider_routes', () => {
    assert.throws(
      () => adapter({ execution: { provider_routes: ['verifier'] } }),
      /must be an object/u,
    )
  })

  it('接受 require_contract 的两种写法，并归一成一个模式名数组', () => {
    // 消费方只关心「哪些模式要求契约」，不该同时理解两种写法。
    const asArray = adapter({ execution: { require_contract: ['high_risk_task'] } })
    assert.deepEqual([...asArray.execution.require_contract], ['high_risk_task'])
    const asObject = adapter({ execution: { require_contract: { modes: ['high_risk_task'] } } })
    assert.deepEqual([...asObject.execution.require_contract], ['high_risk_task'])
  })

  it('拒绝 require_contract 里的未知执行模式', () => {
    assert.throws(
      () => adapter({ execution: { require_contract: ['no_such_mode'] } }),
      /execution modes/u,
    )
  })

  it('拒绝 execution 里的未知键', () => {
    assert.throws(
      () => adapter({ execution: { require_contracted: [] } }),
      /unknown "execution" key/u,
    )
  })
})

describe('validateProjectAdapter — refuses malformed input', () => {
  const cases = [
    ['a non-object top level', []],
    ['a missing project id', { project: {} }],
    ['an unknown top-level key', { project: { id: 'p' }, typo_section: {} }],
    ['a capability not declared before use', {
      project: { id: 'p' },
      capabilities: ['implementation'],
      executors: { review: ['r'] },
    }],
    ['a non-array high_risk_paths', {
      project: { id: 'p' },
      risk: { high_risk_paths: 'src/' },
    }],
    ['an out-of-vocabulary risk level', {
      project: { id: 'p' },
      risk: { high_risk_paths: [], default_level: 'catastrophic' },
    }],
    ['an out-of-vocabulary memory scope', {
      project: { id: 'p' },
      memory: { allow: ['somewhere_else'] },
    }],
  ]

  for (const [label, raw] of cases) {
    it(`refuses ${label}`, () => {
      assert.throws(() => validateProjectAdapter(raw), ProjectAdapterError)
    })
  }

  it('carries a stable code so callers need not parse the message', () => {
    try {
      validateProjectAdapter({ project: {} })
      assert.fail('expected a throw')
    } catch (error) {
      assert.equal(error.code, 'GAC_PROJECT_ADAPTER_INVALID')
    }
  })
})

describe('loadProjectAdapterFromText', () => {
  it('reports malformed JSON as an adapter error, not a SyntaxError', () => {
    assert.throws(
      () => loadProjectAdapterFromText('{ not json', 'project.json'),
      (error) => error instanceof ProjectAdapterError && /not valid JSON/u.test(error.message),
    )
  })

  it('names the source path in the error, so a bad file is findable', () => {
    assert.throws(
      () => loadProjectAdapterFromText('null', 'C:/proj/.dsh/gac/project.json'),
      /C:\/proj\/\.dsh\/gac\/project\.json/u,
    )
  })
})

describe('isHighRiskPath', () => {
  const paths = ['src/boot/**', 'src/auth/**']

  it('matches a declared high-risk subtree', () => {
    assert.equal(isHighRiskPath('src/auth/login.c', paths), true)
  })

  it('matches the high-risk directory itself', () => {
    assert.equal(isHighRiskPath('src/boot', paths), true)
  })

  it('is case-insensitive on the same footing as the write gate', () => {
    assert.equal(isHighRiskPath('SRC/AUTH/LOGIN.C', paths), true)
  })

  it('does not match unrelated code, even with a similar prefix', () => {
    assert.equal(isHighRiskPath('src/authz/helper.c', paths), false)
  })

  it('is false when the project declares no high-risk paths', () => {
    assert.equal(isHighRiskPath('src/boot/main.c', []), false)
  })
})

describe('resolveExecutionMode — the escalation gate', () => {
  it('keeps a low-risk declaration as-is', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: 'remove one config field',
      target_paths: ['config/app.json'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'direct_edit')
    assert.equal(verdict.escalated, false)
    assert.equal(verdict.risk, 'low')
  })

  it('escalates direct_edit to high_risk_task when a target is a high-risk path', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: 'adjust one constant',
      target_paths: ['src/auth/token.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'high_risk_task')
    assert.equal(verdict.escalated, true)
    assert.equal(verdict.escalated_from, 'direct_edit')
    assert.equal(verdict.code, 'GAC_PROCESS_ESCALATION_REQUIRED')
    assert.match(verdict.reason, /src\/auth\/token\.c/u)
  })

  it('escalates by semantic impact, not by file count', () => {
    // 只有一个文件，仍是高风险。大纲明确指出文件数量从来不是判据（单个认证策略文件也
    // 可以是高风险）。
    const verdict = resolveExecutionMode({
      declared_mode: 'standard_task',
      reason: 'single-file auth change',
      target_paths: ['src/boot/main.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'high_risk_task')
  })

  it('records irreversibility without inventing an escalation', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'standard_task',
      reason: 'write a migration',
      target_paths: ['src/db/schema.sql'],
      irreversible: true,
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'standard_task')
    assert.match(verdict.reason, /IRREVERSIBLE/u)
  })

  it('records ambiguity without inventing an escalation', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: 'tweak a value',
      target_paths: ['config/app.json'],
      ambiguous: true,
      adapter: adapter(),
    })
    assert.match(verdict.reason, /AMBIGUOUS/u)
  })

  it('leaves an already-high-risk declaration unescalated', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'high_risk_task',
      reason: 'auth rework',
      target_paths: ['src/auth/token.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.escalated, false)
  })

  it('rejects an out-of-vocabulary mode instead of defaulting to something', () => {
    assert.throws(
      () => resolveExecutionMode({
        declared_mode: 'quick_fix',
        target_paths: [],
        adapter: adapter(),
      }),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('refuses to run without an adapter, rather than assuming low risk', () => {
    assert.throws(
      () => resolveExecutionMode({ declared_mode: 'direct_edit', target_paths: [] }),
      ProjectAdapterError,
    )
  })
})

describe('mode / risk tables', () => {
  it('maps each risk to exactly one mode and back again', () => {
    for (const risk of ['low', 'medium', 'high']) {
      assert.equal(modeToRisk(modeForRisk(risk)), risk)
    }
  })

  it('orders modes from cheapest process to most ceremonious', () => {
    assert.equal(modeRank('read_only'), 0)
    assert.ok(modeRank('direct_edit') < modeRank('standard_task'))
    assert.ok(modeRank('standard_task') < modeRank('high_risk_task'))
  })

  it('rejects an unknown risk instead of guessing', () => {
    assert.throws(() => modeForRisk('severe'), ProjectAdapterError)
  })
})

describe('每一个对外宣告的模式都必须真的能声明', () => {
  /**
   * 一份可用的适配器。
   *
   * @returns {object}
   */
  function governed() {
    return adapter()
  }

  it('EXECUTION_MODES 的每一项都能解析出模式与风险', () => {
    // 这条断言拦的是一整类缺陷：工具把模式列在 enum 里、模型照着选，而运行时在某个环节
    // 拒收它。早先 `read_only` 正是如此——它在白名单里，却因为风险反查表里没有它而抛错，
    // 于是目录里排在最前、最常用的那个模式根本声明不了。逐项跑一遍是唯一能发现它的动作：
    // 只测其中一项时，恰好漏掉的就是没被选中的那些。
    for (const mode of EXECUTION_MODES) {
      const resolved = resolveExecutionMode({
        declared_mode: mode,
        reason: 'test',
        adapter: governed(),
      })
      assert.equal(resolved.mode, mode, `${mode} 应当可用`)
      assert.ok(RISK_LEVELS.includes(resolved.risk), `${mode} 的风险必须是已知档位`)
    }
  })

  it('正向表与反向表一致：每档风险的起点模式，其风险就是那一档', () => {
    // 两张表各自可以是对的，却互相矛盾。矛盾时会有一条路径给出错误的风险级别。
    for (const risk of RISK_LEVELS) {
      assert.equal(modeToRisk(modeForRisk(risk)), risk, `${risk} 的起点模式风险应当仍是 ${risk}`)
    }
  })

  it('read_only 是最便宜的一档，不会把目标路径升级', () => {
    const resolved = resolveExecutionMode({
      declared_mode: 'read_only',
      reason: '只看不改',
      target_paths: ['src/anything.c'],
      adapter: governed(),
    })
    assert.equal(resolved.mode, 'read_only')
    assert.equal(resolved.escalated, false)
  })

  it('read_only 命中高风险路径时同样升级', () => {
    // 只看不改也可能踩到高风险面；升级规则不因模式便宜而放宽。
    const resolved = resolveExecutionMode({
      declared_mode: 'read_only',
      reason: '读一个高风险文件',
      target_paths: ['src/auth/session.c'],
      adapter: governed(),
    })
    assert.equal(resolved.mode, 'high_risk_task')
    assert.equal(resolved.escalated, true)
  })
})

describe('no project facts leak into the universal runtime', () => {
  it('the library sources name no capability or project from any adapter', async () => {
    // 属于*工程*、而从不属于运行时的词。如果其中任何一个出现在 lib/ 里，就说明某个
    // 工程事实被硬编码了，跨工程复用的目标（大纲 §1、§2.4）也就被破坏了。
    const forbidden = [
      'hardware-facts',
      'c-safety',
      'security-analysis',
      'stm32',
      'bootloader',
      'firmware',
    ]
    const files = (await readdir(libDir)).filter((name) => name.endsWith('.js'))
    assert.ok(files.length > 0, 'expected library sources to exist')

    for (const file of files) {
      const text = (await readFile(join(libDir, file), 'utf8')).toLowerCase()
      const source = stripComments(text)
      for (const word of forbidden) {
        assert.equal(
          source.includes(word),
          false,
          `${file} mentions project-specific "${word}" outside a comment`,
        )
      }
    }
  })

  it('the execution-mode vocabulary is closed', () => {
    assert.deepEqual([...EXECUTION_MODES], [
      'read_only',
      'direct_edit',
      'standard_task',
      'high_risk_task',
    ])
  })
})

/**
 * 移除块注释与行注释，好让泄漏检查针对代码，而不是针对那些合理地讨论工程形状示例的
 * 文档。
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
}
