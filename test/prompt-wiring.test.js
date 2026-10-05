/**
 * 入口接线的测试：系统提示段落**真的**被挂上去了吗。
 *
 * 为什么这一条必须存在
 * ------------------------
 * 段落的文本逻辑有自己的单元测试（`test/prompt-section.test.js`），但「入口有没有把它注册到
 * `systemPrompt` 上」只能在入口这一层验。而挂不上去的失败是**完全静默**的：插件照常加载、
 * 门禁照常生效、工具照常可用，只是模型又回到了「只能靠被拒绝来发现边界」的状态——正是这段
 * 代码要消灭的那件事。本仓库吃过同类的亏：`gac_metrics` 漏了 `output`，五个工具一个都没注册
 * 上，而当时的测试全绿。
 *
 * 这里用假 ctx，不用真 harness：真 harness 只能在宿主进程里跑，而宿主进程正是本插件自身
 * 运行的地方。假 ctx 只实现 `apply()` 真正触碰到的那些接缝，接缝少一处就会被下面第一个测试
 * 发现（它会抛错，而不是悄悄跳过）。
 *
 * 报告写进临时 `DSH_HOME`
 * --------------------------
 * 本文件会驱动真实的 `apply()`，而 `apply()` 会往加载报告里追加记录。若让它写进真实报告，
 * 审计轨迹里就会多出几行从没发生过的插件加载，而下一个人正是靠那份报告判断插件到底加载了
 * 几次。代价是：临时 DSH_HOME 里没有 profile 锚点，DSH 包解析不到，于是工具注册会如实报
 * 'unavailable'——本条测试断言的是段落，工具注册有它自己的测试与真实报告。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from '../lib/prompt-section.js'

const tempHome = mkdtempSync(join(tmpdir(), 'gac-wiring-home-'))
process.env.DSH_HOME = tempHome

const projectRoot = mkdtempSync(join(tmpdir(), 'gac-wiring-project-'))
const PROJECT_ID = 'wiring-demo'
mkdirSync(join(projectRoot, '.dsh', 'gac'), { recursive: true })
writeFileSync(
  join(projectRoot, '.dsh', 'gac', 'project.json'),
  JSON.stringify({ project: { id: PROJECT_ID, title: 'Wiring demo' } }),
  'utf8',
)

const { apply } = await import('../lib/index.js')

/** 本文件里所有会话共用的 id。 */
const SESSION_ID = 'session-wiring'

/**
 * 一个够用的假 ctx。
 *
 * `effect` 会把 `apply()` 传进来的生成器跑一遍：里面逐个 `yield` 的正是监听器注册与销毁器，
 * 不跑就等于把闸门装在了空气里。
 *
 * @param {object} [options]
 * @param {boolean} [options.provideSystemPrompt] - 依赖是否就绪；false 用来验证「提示缺席时闸门仍在」。
 * @param {string} [options.sessionCwd] - 本会话的工作目录，工程根由它推出。
 * @returns {{ctx: object, seen: {injections: object[], sections: object[], listeners: object[], tools: object[], disposers: Function[]}}}
 */
function createFakeContext({ provideSystemPrompt = true, sessionCwd } = {}) {
  const seen = { injections: [], sections: [], listeners: [], tools: [], disposers: [] }
  const disposer = () => {}
  const ctx = {
    sessions: {
      get: (id) => (id === SESSION_ID && sessionCwd !== undefined ? { header: { cwd: sessionCwd } } : undefined),
      list: () => [],
      registerMessageProjection: () => disposer,
    },
    tools: { register: (definition) => { seen.tools.push(definition); return disposer } },
    on: (event, listener, options) => {
      seen.listeners.push({ event, listener, options })
      return disposer
    },
    effect: (body) => {
      for (const yielded of body()) {
        if (typeof yielded === 'function') seen.disposers.push(yielded)
      }
      return disposer
    },
    inject: (deps, callback) => {
      seen.injections.push({ deps, callback })
      if (provideSystemPrompt) {
        callback({
          systemPrompt: {
            section: (section) => { seen.sections.push(section); return disposer },
          },
        })
      }
      return disposer
    },
    llm: undefined,
  }
  return { ctx, seen }
}

describe('入口把系统提示段落挂上 systemPrompt', () => {
  it('注册一个段落，名字、顺序与「不插值」都对', async () => {
    const { ctx, seen } = createFakeContext({ sessionCwd: projectRoot })
    await apply(ctx)

    // 断言的是**提示那一次**注入，而不是「注入总数」：插件还会用 `ctx.inject` 接一个可选的
    // 工作区观测源（`workspaceChanges`，见 lib/index.js），它以同样方式降级、与提示无关。
    // 原先这里断言的是总数，于是那条可选接缝一加进来这条测试就红了——它测的是接线方式，
    // 不是本文件声称要测的那件事。
    const promptInjections = seen.injections.filter((entry) => entry.deps.includes('systemPrompt'))
    assert.equal(promptInjections.length, 1, '应当恰好注入一次 systemPrompt')
    assert.deepEqual([...promptInjections[0].deps], ['systemPrompt'])
    assert.equal(seen.sections.length, 1, '应当恰好注册一个段落')

    const section = seen.sections[0]
    assert.equal(section.name, PROMPT_SECTION_NAME)
    assert.equal(section.order, PROMPT_SECTION_ORDER)
    // 文本是生成的：不插值是它的保命性质，见 lib/prompt-section.js 顶部。
    assert.equal(section.interpolate, false)
    assert.equal(typeof section.text, 'function')
  })

  it('段落对本会话渲染出真实工程的身份（走到盘上的适配器）', async () => {
    const { ctx, seen } = createFakeContext({ sessionCwd: projectRoot })
    await apply(ctx)
    const text = seen.sections[0].text({ agent: { session: { id: SESSION_ID } } })
    assert.match(text, new RegExp(PROJECT_ID, 'u'))
    assert.match(text, /gac_project/u)
  })

  it('没有会话（全局装配）时拿到空串，而不是异常', async () => {
    const { ctx, seen } = createFakeContext({ sessionCwd: projectRoot })
    await apply(ctx)
    const section = seen.sections[0]
    assert.equal(section.text(undefined), '')
    assert.equal(section.text({}), '')
    assert.equal(section.text({ agent: {} }), '')
  })

  it('加载报告里留下段落已注册的那一行——这是线上唯一的核验信号', async () => {
    const { ctx } = createFakeContext({ sessionCwd: projectRoot })
    await apply(ctx)
    const report = readFileSync(join(tempHome, 'gac-runtime-report.jsonl'), 'utf8')
    const registered = report
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === 'prompt-section-registered')
    // 本文件里前面几条测试也各自加载过一次插件，报告是追加写的，所以只断言「有过」。
    assert.ok(registered.length >= 1, `报告里没有 prompt-section-registered：${report}`)
    const last = registered[registered.length - 1]
    assert.equal(last.name, PROMPT_SECTION_NAME)
    assert.equal(last.order, PROMPT_SECTION_ORDER)
    assert.equal(last.interpolate, false)
  })
})

describe('提示服务缺席时，强制执行不受影响', () => {
  it('systemPrompt 一直不就绪：不注册段落，但写作用域闸门照样装上', async () => {
    const { ctx, seen } = createFakeContext({ provideSystemPrompt: false, sessionCwd: projectRoot })
    await apply(ctx)

    assert.deepEqual(seen.sections, [], '没有服务就不该有段落')
    // 反过来才是不允许的：少一段提示换来少一道强制。闸门必须与提示服务的可用性无关。
    assert.ok(
      seen.listeners.some((entry) => entry.event === 'tools/pre-execute'),
      '写作用域闸门必须仍然被安装',
    )
  })
})
