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
  NON_TASK_MODES,
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

describe('validateProjectAdapter —— 接受形式正确的适配器', () => {
  it('冻结结果，使后续改动无法改变策略', () => {
    const parsed = adapter()
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.risk.high_risk_paths), true)
    assert.throws(() => {
      parsed.risk.high_risk_paths.push('src/evil.c')
    }, TypeError)
  })

  it('memory 作用域默认为大纲 §13 的白名单', () => {
    const parsed = adapter()
    assert.deepEqual([...parsed.memory.allow], ['current_project', 'global_reusable'])
    assert.deepEqual([...parsed.memory.deny_as_project_fact], ['foreign_project', 'unknown'])
  })

  it('authority 一节：不认识的键被拒，而不是被悄悄收下', () => {
    // 校验器不认识的字段，运行时也不该去读（与 `execution` 那一节同一条教训）。原样透传的
    // 写法会让「项目声明了、但谁都没读」与「项目没声明」在表现上一模一样。
    assert.throws(
      () => adapter({ authority: { enforcement_mode: 'tool_guard', commit_automatically: true } }),
      (error) => error instanceof ProjectAdapterError && /未知的 "authority" 键/u.test(error.message),
    )
    assert.throws(
      () => adapter({ authority: ['tool_guard'] }),
      (error) => error instanceof ProjectAdapterError && /"authority" 必须是一个对象/u.test(error.message),
    )
  })

  it('authority.test_paths 默认为空数组，声明后归一成冻结的数组', () => {
    // 默认空数组就是「这一层不管」：没声明测试路径的工程，行为一字不变。
    assert.deepEqual([...adapter().authority.test_paths], [])
    const parsed = adapter({ authority: { test_paths: ['test/', 'spec/'] } })
    assert.deepEqual([...parsed.authority.test_paths], ['test/', 'spec/'])
    assert.equal(Object.isFrozen(parsed.authority.test_paths), true)
  })

  it('authority.test_paths 必须是字符串数组，且每条非空', () => {
    for (const value of ['test/', 1, {}, [''], [null], [1], ['test/', '']]) {
      assert.throws(
        () => adapter({ authority: { test_paths: value } }),
        (error) => error instanceof ProjectAdapterError && /authority\.test_paths/u.test(error.message),
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

  it('authority 归一之后仍带着原来的其他键', () => {
    const parsed = adapter({ authority: { enforcement_mode: 'tool_guard', test_paths: ['test/'] } })
    assert.equal(parsed.authority.enforcement_mode, 'tool_guard')
  })

  it('authority.coordinator_write 默认 allow —— 没声明的工程行为一字不变', () => {
    // 这条默认值是刻意的：这道门禁会改变「谁在写文件」，而它默认打开会让每一个既有工程的主会话
    // 突然写不了自己的源码。要开就得明说。
    assert.equal(adapter().authority.coordinator_write, 'allow')
    assert.equal(
      adapter({ authority: { coordinator_write: 'protected', protected_paths: ['lib/'] } })
        .authority.coordinator_write,
      'protected',
    )
  })

  it('authority.coordinator_write 只认 allow 与 protected', () => {
    for (const value of ['deny', 'block', true, 1, ['protected'], {}]) {
      assert.throws(
        () => adapter({ authority: { coordinator_write: value } }),
        (error) => error instanceof ProjectAdapterError && /authority\.coordinator_write/u.test(error.message),
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

  it('authority.protected_paths 默认为空数组，声明后归一成冻结的数组', () => {
    assert.deepEqual([...adapter().authority.protected_paths], [])
    const parsed = adapter({
      authority: { coordinator_write: 'protected', protected_paths: ['lib/', 'test/'] },
    })
    assert.deepEqual([...parsed.authority.protected_paths], ['lib/', 'test/'])
    assert.equal(Object.isFrozen(parsed.authority.protected_paths), true)
  })

  it('authority.protected_paths 必须是字符串数组，且每条非空', () => {
    for (const value of ['lib/', 1, {}, [''], [null], [1], ['lib/', '']]) {
      assert.throws(
        () => adapter({ authority: { protected_paths: value } }),
        (error) => error instanceof ProjectAdapterError && /authority\.protected_paths/u.test(error.message),
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

  it('声明了 protected 却一条路径都没给，比「没声明」更糟，因此判非法', () => {
    // 这种情况最可能的成因是漏写。静默接受它，表现就是「声明了保护、主会话照样写」——而工程作者
    // 以为自己已经设防了。
    for (const authority of [
      { coordinator_write: 'protected' },
      { coordinator_write: 'protected', protected_paths: [] },
    ]) {
      assert.throws(
        () => adapter({ authority }),
        (error) => error instanceof ProjectAdapterError && /protected_paths/u.test(error.message),
      )
    }
  })

  it('给了受保护路径但没声明 protected 时，路径只是白存着，不算错', () => {
    // 与上一条的区别：这里没有声明保护，所以没有任何东西声称「已经设防了」。留一份路径清单
    // 供将来打开，是合法的过渡状态。
    const parsed = adapter({ authority: { protected_paths: ['lib/'] } })
    assert.equal(parsed.authority.coordinator_write, 'allow')
    assert.deepEqual([...parsed.authority.protected_paths], ['lib/'])
  })
})

describe('execution 一节 —— 运行时真正读取的字段必须能通过校验', () => {
  it('只读角色要不要连 shell 一起收回：默认 false，声明 true 就通过', () => {
    // 默认必须是不收：验证者要逐条执行计划用例才能留下证据，收掉 shell 会让「每条用例都要有
    // 独立证据」的收口门禁永远过不去（适配计划 §4.4 阶段 3 与 E2E-6 的矛盾，本项目选了前者）。
    assert.equal(adapter().execution.revoke_shell_for_read_only_roles, false)
    assert.equal(
      adapter({ execution: { revoke_shell_for_read_only_roles: true } })
        .execution.revoke_shell_for_read_only_roles,
      true,
    )
  })

  it('这个开关不是布尔量时被拒，而不是被当成 false', () => {
    for (const value of ['true', 1, {}, []]) {
      assert.throws(
        () => adapter({ execution: { revoke_shell_for_read_only_roles: value } }),
        (error) => error instanceof ProjectAdapterError && /revoke_shell/u.test(error.message),
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

  it('原生子会话派遣的开关：默认 true，显式 false 才关', () => {
    // 默认开：独立 Session / 独立上下文 / 独立工具面已是正式架构，默认关会让新纳管的工程静默退回
    // 主会话自我验证。默认开不等于静默降级——接缝缺席时由执行者阻塞或显式降级（lib/child-executor.js）。
    assert.equal(adapter().execution.native_child_dispatch, true)
    assert.equal(
      adapter({ execution: { native_child_dispatch: false } }).execution.native_child_dispatch,
      false,
    )
    assert.equal(
      adapter({ execution: { native_child_dispatch: true } }).execution.native_child_dispatch,
      true,
    )
  })

  it('原生子会话开关不是布尔量时同样被拒', () => {
    for (const value of ['true', 1, {}, []]) {
      assert.throws(
        () => adapter({ execution: { native_child_dispatch: value } }),
        (error) => error instanceof ProjectAdapterError && /native_child_dispatch/u.test(error.message),
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

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
      /必须是非空字符串/u,
    )
  })

  it('拒绝非对象的 provider_routes', () => {
    assert.throws(
      () => adapter({ execution: { provider_routes: ['verifier'] } }),
      /必须是把执行者名字映射到路由的对象/u,
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
      /执行模式列表/u,
    )
  })

  it('拒绝 execution 里的未知键', () => {
    assert.throws(
      () => adapter({ execution: { require_contracted: [] } }),
      /未知的 "execution" 键/u,
    )
  })
})

describe('validateProjectAdapter —— 拒绝畸形输入', () => {
  const cases = [
    ['非对象的顶层', []],
    ['缺少 project.id', { project: {} }],
    ['未知的顶层键', { project: { id: 'p' }, typo_section: {} }],
    ['使用前未声明能力', {
      project: { id: 'p' },
      capabilities: ['implementation'],
      executors: { review: ['r'] },
    }],
    ['非数组的 high_risk_paths', {
      project: { id: 'p' },
      risk: { high_risk_paths: 'src/' },
    }],
    ['词表外的风险级别', {
      project: { id: 'p' },
      risk: { high_risk_paths: [], default_level: 'catastrophic' },
    }],
    ['词表外的 memory 作用域', {
      project: { id: 'p' },
      memory: { allow: ['somewhere_else'] },
    }],
  ]

  for (const [label, raw] of cases) {
    it(`拒绝 ${label}`, () => {
      assert.throws(() => validateProjectAdapter(raw), ProjectAdapterError)
    })
  }

  it('带一个稳定的错误码，调用方无需解析文案', () => {
    try {
      validateProjectAdapter({ project: {} })
      assert.fail('应当抛错')
    } catch (error) {
      assert.equal(error.code, 'GAC_PROJECT_ADAPTER_INVALID')
    }
  })
})

describe('loadProjectAdapterFromText', () => {
  it('把畸形 JSON 报成适配器错误，而不是 SyntaxError', () => {
    assert.throws(
      () => loadProjectAdapterFromText('{ not json', 'project.json'),
      (error) => error instanceof ProjectAdapterError && /不是合法 JSON/u.test(error.message),
    )
  })

  it('在错误里点名来源路径，坏文件因此可被找到', () => {
    assert.throws(
      () => loadProjectAdapterFromText('null', 'C:/proj/.dsh/gac/project.json'),
      /C:\/proj\/\.dsh\/gac\/project\.json/u,
    )
  })
})

describe('isHighRiskPath', () => {
  const paths = ['src/boot/**', 'src/auth/**']

  it('匹配已声明的高风险子树', () => {
    assert.equal(isHighRiskPath('src/auth/login.c', paths), true)
  })

  it('匹配高风险目录本身', () => {
    assert.equal(isHighRiskPath('src/boot', paths), true)
  })

  it('对大小写不敏感，且与写作用域闸门同一口径', () => {
    assert.equal(isHighRiskPath('SRC/AUTH/LOGIN.C', paths), true)
  })

  it('即便前缀相似，也不匹配无关代码', () => {
    assert.equal(isHighRiskPath('src/authz/helper.c', paths), false)
  })

  it('工程未声明高风险路径时为 false', () => {
    assert.equal(isHighRiskPath('src/boot/main.c', []), false)
  })
})

describe('resolveExecutionMode —— 升级闸门', () => {
  it('低风险声明原样保留', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: '删掉一个配置字段',
      target_paths: ['config/app.json'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'direct_edit')
    assert.equal(verdict.escalated, false)
    assert.equal(verdict.risk, 'low')
  })

  it('目标落在高风险路径时要求评估且不自动升级', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: '调整一个常量',
      target_paths: ['src/auth/token.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'direct_edit')
    assert.equal(verdict.escalated, false)
    assert.equal(verdict.assessment_required, true)
    assert.equal(verdict.code, 'GAC_PROCESS_ESCALATION_REQUIRED')
    assert.match(verdict.reason, /src\/auth\/token\.c/u)
  })

  it('按语义影响升级，而不是按文件数', () => {
    // 只有一个文件，仍是高风险。大纲明确指出文件数量从来不是判据（单个认证策略文件也
    // 可以是高风险）。
    const verdict = resolveExecutionMode({
      declared_mode: 'standard_task',
      reason: '单文件认证改动',
      target_paths: ['src/boot/main.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'direct_edit')
  })

  it('记下不可逆性，但不凭空造出一次升级', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'standard_task',
      reason: '编写一次迁移',
      target_paths: ['src/db/schema.sql'],
      irreversible: true,
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'direct_edit')
    assert.match(verdict.reason, /IRREVERSIBLE/u)
  })

  it('记下歧义，但不凭空造出一次升级', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: '调整一处取值',
      target_paths: ['config/app.json'],
      ambiguous: true,
      adapter: adapter(),
    })
    assert.match(verdict.reason, /AMBIGUOUS/u)
  })

  it('已是高风险的声明不再升级', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'high_risk_task',
      reason: '重做认证逻辑',
      target_paths: ['src/auth/token.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.escalated, false)
  })

  it('拒绝词表外的模式，而不是退回到某个默认值', () => {
    assert.throws(
      () => resolveExecutionMode({
        declared_mode: 'quick_fix',
        target_paths: [],
        adapter: adapter(),
      }),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('没有适配器时拒绝运行，而不是假定低风险', () => {
    assert.throws(
      () => resolveExecutionMode({ declared_mode: 'direct_edit', target_paths: [] }),
      ProjectAdapterError,
    )
  })
})

describe('模式 / 风险表', () => {
  it('每档风险映射到唯一一个模式，且能映射回来', () => {
    for (const risk of ['low', 'medium', 'high']) {
      assert.equal(modeToRisk(modeForRisk(risk)), risk)
    }
  })

  it('模式按流程成本从低到高排序', () => {
    assert.equal(modeRank('read_only'), 0)
    assert.ok(modeRank('direct_edit') < modeRank('standard_task'))
    assert.ok(modeRank('standard_task') < modeRank('high_risk_task'))
  })

  it('拒绝未知风险，而不是猜一个', () => {
    assert.throws(() => modeForRisk('severe'), ProjectAdapterError)
  })

  it('不建任务记录的模式恰好是 read_only 与 direct_edit', () => {
    // E2E-1 说「删一个配置字段 → DIRECT_EDIT → 无任务、无子 Agent」。这条断言的落点就是这份
    // 名单：它多一项，某个模式就会悄悄不再建任务记录；它少一项，本该直接做完的小改动会被
    // 套上一整套流程仪式（适配计划 §33 的「流程放大」）。
    assert.deepEqual([...NON_TASK_MODES], ['read_only', 'direct_edit'])
    for (const mode of NON_TASK_MODES) {
      assert.ok(EXECUTION_MODES.includes(mode), `${mode} 必须是执行模式阶梯里的一级`)
    }
    for (const mode of ['standard_task', 'high_risk_task']) {
      assert.equal(NON_TASK_MODES.includes(mode), false, `${mode} 必须留下任务记录`)
    }
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
        reason: '测试',
        adapter: governed(),
      })
      assert.equal(resolved.mode, mode === 'read_only' ? mode : 'direct_edit', `${mode} 声明不得自我批准`)
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

  it('read_only 命中高风险路径仍保持只读', () => {
    // 只看不改也可能踩到高风险面；升级规则不因模式便宜而放宽。
    const resolved = resolveExecutionMode({
      declared_mode: 'read_only',
      reason: '读一个高风险文件',
      target_paths: ['src/auth/session.c'],
      adapter: governed(),
    })
    assert.equal(resolved.mode, 'read_only')
    assert.equal(resolved.escalated, false)
  })
})

describe('没有工程事实泄漏进通用运行时', () => {
  it('库源码不提及任何适配器里的能力或工程名', async () => {
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
    assert.ok(files.length > 0, 'lib 源码应当存在')

    for (const file of files) {
      const text = (await readFile(join(libDir, file), 'utf8')).toLowerCase()
      const source = stripComments(text)
      for (const word of forbidden) {
        assert.equal(
          source.includes(word),
          false,
          `${file} 在注释之外提到了工程专属词 "${word}"`,
        )
      }
    }
  })

  it('执行模式词表是封闭的', () => {
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
