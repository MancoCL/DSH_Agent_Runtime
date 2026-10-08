/**
 * 访谈循环与接口契约测试。
 *
 * 这两者互为前提：访谈收敛出的东西正是契约要冻结的内容，而契约是并行编写功能代码与测试
 * 代码能够成立的前提。所以最要紧的断言是两条：访谈**不能只以模型的自我评估结束**，契约
 * **不能在动手之后才补**。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONTRACT_CODES,
  ContractError,
  compileContract,
  contractId,
  deepFreezeContract,
  findUncoveredCriteria,
  freezeContract,
  sameContract,
} from '../lib/contract.js'
import {
  GRILLING_CODES,
  GrillingError,
  MAX_ROUNDS_GUARD,
  freezeRequirement,
  isRequirementFrozen,
  proposeConvergence,
  recordRound,
  requirementId,
  startGrilling,
  summarize,
} from '../lib/grilling.js'

/** 一轮正常的访谈。 */
function round(overrides = {}) {
  return {
    focus: '范围',
    questions: [
      { id: 'Q1', question: '这个改动影响哪些文件？', answer: '只有 src/a.c' },
      { id: 'Q2', question: '需要兼容旧行为吗？', answer: '不需要' },
    ],
    ...overrides,
  }
}

/**
 * 问完并请用户确认的访谈。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function confirmedGrilling(overrides = {}) {
  let state = startGrilling({ task_id: 'REQ-1', requirement: '改一个字段' })
  state = recordRound(state, round())
  state = proposeConvergence(state)
  return freezeRequirement(state, {
    confirmation: '可以，就按这个做',
    acceptance_criteria: ['AC1', 'AC2'],
    ...overrides,
  })
}

describe('需求身份：改写即换身份，设计才有「推导自哪一版」可言', () => {
  it('冻结的需求有内容寻址的 id，未冻结的没有', () => {
    assert.equal(requirementId(startGrilling({ task_id: 'REQ-1' })), undefined)
    assert.match(requirementId(confirmedGrilling()), /^requirement-[0-9a-f]{8}$/u)
  })

  it('多一条验收标准，需求身份就变', () => {
    const before = requirementId(confirmedGrilling())
    const after = requirementId(confirmedGrilling({ acceptance_criteria: ['AC1', 'AC2', 'AC3'] }))
    assert.notEqual(before, after)
  })

  it('确认原话变了，需求身份也变（用户改了口径就是改了口径）', () => {
    assert.notEqual(requirementId(confirmedGrilling()), requirementId(confirmedGrilling({ confirmation: '再想想' })))
  })

  it('验收标准的顺序不影响身份', () => {
    assert.equal(
      requirementId(confirmedGrilling({ acceptance_criteria: ['AC1', 'AC2'] })),
      requirementId(confirmedGrilling({ acceptance_criteria: ['AC2', 'AC1'] })),
    )
  })
})

describe('访谈循环', () => {
  it('新建时什么都没问过', () => {
    const state = startGrilling({ task_id: 'REQ-1' })
    const view = summarize(state)
    assert.equal(view.rounds, 0)
    assert.equal(view.frozen, false)
    assert.equal(isRequirementFrozen(state), false)
  })

  it('一轮访谈同时记下问题与答复', () => {
    let state = startGrilling({ task_id: 'REQ-1' })
    state = recordRound(state, round())
    const view = summarize(state)
    assert.equal(view.rounds, 1)
    assert.equal(view.questions_asked, 2)
  })

  it('拒绝没有问题的一轮：它不带来信息，只增加轮数', () => {
    const state = startGrilling({ task_id: 'REQ-1' })
    assert.throws(
      () => recordRound(state, { questions: [] }),
      (error) => error.code === GRILLING_CODES.EMPTY_ROUND,
    )
  })

  it('拒绝缺少答复的一问，并说明「不知道」也是一条答复', () => {
    // 答案缺失与「用户说不知道」是两件事：前者是漏记，后者是一条真实结论。
    const state = startGrilling({ task_id: 'REQ-1' })
    assert.throws(
      () => recordRound(state, { questions: [{ id: 'Q1', question: '影响哪些文件？' }] }),
      (error) => {
        assert.equal(error.code, GRILLING_CODES.MALFORMED)
        assert.match(error.message, /不知道/u)
        return true
      },
    )
  })

  it('把「不知道」当作真实答复记下，并统计为未决', () => {
    let state = startGrilling({ task_id: 'REQ-1' })
    state = recordRound(state, {
      questions: [
        { id: 'Q1', question: '需要兼容吗？', answer: '不知道' },
        { id: 'Q2', question: '影响哪些文件？', answer: 'src/a.c' },
      ],
    })
    const view = summarize(state)
    assert.deepEqual(view.unresolved.map((entry) => entry.id), ['Q1'])
  })

  it('多轮累积，且每轮记下自己的序号', () => {
    let state = startGrilling({ task_id: 'REQ-1' })
    state = recordRound(state, round())
    state = recordRound(state, round({ focus: '边界' }))
    assert.equal(state.rounds.length, 2)
    assert.deepEqual(state.rounds.map((entry) => entry.index), [1, 2])
  })

  it('一轮都没问就提出收敛会被拒', () => {
    // 需求在被问过之前不可能是完整的。
    assert.throws(
      () => proposeConvergence(startGrilling({ task_id: 'REQ-1' })),
      (error) => error.code === GRILLING_CODES.NOT_CONVERGED,
    )
  })

  it('提出收敛不等于结束：还没有用户确认就不能冻结', () => {
    // 这是整段流程里唯一区分「模型以为懂了」与「用户确认懂了」的动作。
    let state = startGrilling({ task_id: 'REQ-1' })
    state = recordRound(state, round())
    state = proposeConvergence(state)
    assert.throws(
      () => freezeRequirement(state, { confirmation: '   ' }),
      (error) => {
        assert.equal(error.code, GRILLING_CODES.NOT_CONFIRMED)
        assert.match(error.message, /自我评估不足以/u)
        return true
      },
    )
  })

  it('没有提出收敛就冻结会被拒', () => {
    let state = startGrilling({ task_id: 'REQ-1' })
    state = recordRound(state, round())
    assert.throws(
      () => freezeRequirement(state, { confirmation: '可以' }),
      (error) => error.code === GRILLING_CODES.NOT_CONVERGED,
    )
  })

  it('用户确认后冻结，并留下确认原话', () => {
    const state = confirmedGrilling()
    assert.equal(isRequirementFrozen(state), true)
    assert.equal(state.confirmation, '可以，就按这个做')
    assert.deepEqual([...state.acceptance_criteria], ['AC1', 'AC2'])
  })

  it('冻结之后不能再追加轮次', () => {
    const state = confirmedGrilling()
    assert.throws(
      () => recordRound(state, round()),
      (error) => error.code === GRILLING_CODES.ALREADY_FROZEN,
    )
  })

  it('冻结之后不能再冻结一次', () => {
    const state = confirmedGrilling()
    assert.throws(
      () => freezeRequirement(state, { confirmation: '再一次' }),
      (error) => error.code === GRILLING_CODES.ALREADY_FROZEN,
    )
  })

  it('轮数上限只作失控保护，不表达「问到这里就够了」', () => {
    let state = startGrilling({ task_id: 'REQ-1' })
    for (let index = 0; index < MAX_ROUNDS_GUARD; index += 1) {
      state = recordRound(state, round())
    }
    assert.throws(
      () => recordRound(state, round()),
      (error) => error.code === GRILLING_CODES.NOT_CONVERGED,
    )
  })

  it('缺少 task_id 时拒绝新建', () => {
    assert.throws(() => startGrilling({ task_id: '' }), GrillingError)
  })
})

/** 一份两操作的契约。 */
function contract(overrides = {}) {
  return compileContract({
    name: 'parseConfig',
    operations: [
      {
        name: 'parseConfig',
        signature: 'parseConfig(text: string): Config',
        behavior: '解析失败时抛出 ConfigError；空文本返回空配置而不是抛错。',
        errors: ['ConfigError'],
        covers: ['AC1'],
      },
      {
        name: 'serializeConfig',
        signature: 'serializeConfig(config: Config): string',
        behavior: '输出的键顺序稳定，便于逐字节比较。',
        covers: ['AC2'],
      },
    ],
    ...overrides,
  })
}

describe('接口契约', () => {
  it('接受一份完整契约并冻结它', () => {
    const frozen = contract()
    assert.equal(frozen.operations.length, 2)
    assert.equal(Object.isFrozen(frozen), true)
    assert.throws(() => { frozen.operations.push({}) }, TypeError)
  })

  it('拒绝空契约：没有约定正是并行写测试会出问题的那种状态', () => {
    assert.throws(
      () => compileContract({ name: 'x', operations: [] }),
      (error) => error.code === CONTRACT_CODES.MALFORMED,
    )
  })

  it('拒绝没有名字的契约', () => {
    assert.throws(() => compileContract({ operations: [{ name: 'a', signature: 'a()', behavior: 'b' }] }), ContractError)
  })

  it('拒绝重复的操作名', () => {
    assert.throws(
      () => compileContract({ name: 'x', operations: [
        { name: 'a', signature: 'a()', behavior: 'b' },
        { name: 'a', signature: 'a(x)', behavior: 'c' },
      ] }),
      /重复/u,
    )
  })

  it('拒绝缺少 behavior 的操作，并说明为什么签名不够', () => {
    // 只有签名时「它返回什么」仍要靠猜，而猜出来的期望正是两边对不上的地方。
    assert.throws(
      () => compileContract({ name: 'x', operations: [{ name: 'a', signature: 'a()' }] }),
      (error) => {
        assert.equal(error.code, CONTRACT_CODES.MALFORMED)
        assert.match(error.message, /只能靠猜/u)
        return true
      },
    )
  })

  it('拒绝缺少 signature 的操作', () => {
    assert.throws(
      () => compileContract({ name: 'x', operations: [{ name: 'a', behavior: 'b' }] }),
      /signature/u,
    )
  })

  it('给了 covers 就当场核对覆盖', () => {
    assert.throws(
      () => compileContract({
        name: 'x',
        covers: ['AC1', 'AC2', 'AC3'],
        operations: [{ name: 'a', signature: 'a()', behavior: 'b', covers: ['AC1'] }],
      }),
      (error) => {
        assert.equal(error.code, CONTRACT_CODES.NOT_COVERED)
        assert.deepEqual(error.detail.uncovered, ['AC2', 'AC3'])
        return true
      },
    )
  })

  it('找出没有被任何操作覆盖的验收标准', () => {
    const frozen = contract()
    assert.deepEqual(findUncoveredCriteria(frozen, ['AC1', 'AC9']), ['AC9'])
  })

  it('同一份契约给出同一个 id', () => {
    assert.equal(contractId(contract()), contractId(contract()))
  })

  it('行为约定被改写时 id 随之改变', () => {
    const changed = contract({
      operations: [
        { name: 'parseConfig', signature: 'parseConfig(text: string): Config', behavior: '改成静默返回 null', covers: ['AC1'] },
        { name: 'serializeConfig', signature: 'serializeConfig(config: Config): string', behavior: 'b', covers: ['AC2'] },
      ],
    })
    assert.notEqual(contractId(contract()), contractId(changed))
  })

  it('id 与操作声明顺序无关', () => {
    const reordered = compileContract({
      name: 'parseConfig',
      operations: [
        { name: 'serializeConfig', signature: 'serializeConfig(config: Config): string', behavior: '输出的键顺序稳定，便于逐字节比较。', covers: ['AC2'] },
        { name: 'parseConfig', signature: 'parseConfig(text: string): Config', behavior: '解析失败时抛出 ConfigError；空文本返回空配置而不是抛错。', errors: ['ConfigError'], covers: ['AC1'] },
      ],
    })
    assert.equal(contractId(contract()), contractId(reordered))
  })

  it('sameContract 比较的是内容而不是对象身份', () => {
    assert.equal(sameContract(contract(), contract()), true)
  })
})

describe('契约冻结', () => {
  it('首次冻结返回 frozen', () => {
    const result = freezeContract(contract(), undefined)
    assert.equal(result.status, 'frozen')
    assert.ok(result.id)
  })

  it('同一份契约重复冻结是幂等的', () => {
    const first = freezeContract(contract(), undefined)
    const again = freezeContract(contract(), first.contract)
    assert.equal(again.status, 'unchanged')
  })

  it('以另一份契约覆盖已冻结的会被拒，并解释代价', () => {
    // 冻结之后再改，等于让已经照它开工的两条分支对着一份不存在的约定干活。
    const first = freezeContract(contract(), undefined)
    const changed = contract({
      operations: [
        { name: 'parseConfig', signature: 'parseConfig(text: string): Config', behavior: '不一样了', covers: ['AC1'] },
        { name: 'serializeConfig', signature: 'serializeConfig(config: Config): string', behavior: 'b', covers: ['AC2'] },
      ],
    })
    assert.throws(
      () => freezeContract(changed, first.contract),
      (error) => {
        assert.equal(error.code, CONTRACT_CODES.ALREADY_FROZEN)
        assert.equal(error.detail.expected, first.id)
        assert.match(error.message, /对不上/u)
        return true
      },
    )
  })

  it('深冻结，连嵌套数组也改不动', () => {
    const frozen = deepFreezeContract({ ...contract() })
    assert.throws(() => { frozen.operations[0].errors.push('X') }, TypeError)
  })
})
