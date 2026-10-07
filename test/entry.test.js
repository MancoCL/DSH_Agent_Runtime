/**
 * 模块加载冒烟测试。
 *
 * 它们的存在源于一次真实失败：`lib/index.js` 曾在传给 `ctx.effect` 的生成器里含有
 * `await`，而那是*语法*错误。所有单元测试都通过了，因为它们都没有导入入口点——插件
 * 加载静默失败，而先前已加载的版本继续运行，于是 profile 看起来一切正常。
 *
 * 这些断言刻意做得很浅：每个模块都能解析、入口点导出了 Cordis 要求的形状、入口不在
 * 模块作用域导入 DSH 包（在那里做裸导入会在加载时抛错，早于任何插件代码能说明原因）。
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/**
 * lib/ 中的每个模块，靠发现而非列举。
 *
 * 这里刻意不写死清单：写死的清单会在新增模块时静默漏掉它——而本文件存在的全部理由
 * 就是「没被导入的模块没人检查」。发现式列举让「新增了模块但忘了加进来」不可能发生。
 *
 * @returns {Promise<string[]>} 模块文件名，已排序。
 */
async function discoverModules() {
  const entries = await readdir(libDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort()
}

const modules = await discoverModules()

describe('lib/ 里确实有模块可被发现', () => {
  it('发现到不止一个模块', () => {
    assert.ok(modules.length > 1, `期望 ${libDir} 里有模块，实际只找到 ${modules.length} 个`)
  })
})

describe('lib/ 里每个模块都能解析并导入', () => {
  for (const file of modules) {
    it(`导入 lib/${file}`, async () => {
      const loaded = await import(`../lib/${file}`)
      assert.equal(typeof loaded, 'object')
    })
  }
})

describe('入口点满足 Cordis 插件契约', () => {
  it('导出 name、inject 与 apply', async () => {
    const entry = await import('../lib/index.js')
    assert.equal(typeof entry.name, 'string')
    assert.ok(entry.name.length > 0)
    assert.ok(Array.isArray(entry.inject))
    assert.equal(typeof entry.apply, 'function')
  })

  it('声明守卫真正读取的服务', async () => {
    const entry = await import('../lib/index.js')
    // 守卫通过 `sessions` 解析会话的 cwd，并通过 `tools` 进行拦截。声明得更少会让插件
    // 加载进一个它无法履职的组合里。
    assert.deepEqual([...entry.inject].sort(), ['sessions', 'tools'])
  })

  it('apply 可以被 await，因为它在注册之前先解析包', async () => {
    const entry = await import('../lib/index.js')
    // 正是异步函数让 DSH 包的解析发生在 effect 主体之前——后者是一个生成器，不能含有
    // `await`。
    assert.equal(entry.apply.constructor.name, 'AsyncFunction')
  })
})

describe('入口点把 DSH 导入推迟到调用时', () => {
  it('没有对裸 @deepseek-ai 包的静态导入', async () => {
    const source = await readFile(join(libDir, 'index.js'), 'utf8')
    // 在模块作用域做裸导入会在加载器求值该模块时抛错，而这发生在 `apply` 能上报可诊断
    // 原因之前。顶层只允许从相对路径导入的值。
    const staticBareImports = [...source.matchAll(/^import[^;]*?from\s+'(@deepseek-ai\/[^']+)'/gmu)]
    assert.deepEqual(staticBareImports.map((m) => m[1]), [])
  })
})

describe('子会话的引入方式 —— 判据变更（见 docs/ADR-0001-子会话执行载体.md）', () => {
  /**
   * 把注释剥掉，只留代码。
   *
   * 这些断言问的是「代码怎么用子会话」，而注释里提一句某个名字（例如说明宿主的 Team 工具是
   * 作用域内注册的）并不是调用。早先直接对源码做词面扫描，于是那样一条注释会把测试弄红——
   * **红得没有道理**，而一条会因为没道理地红而被删掉的测试，比没有测试更糟。
   *
   * @param {string} source
   * @returns {string}
   */
  function stripComments(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '')
      .replace(/([^:'"])\/\/.*$/gmu, '$1')
  }

  /** 读一遍 lib/ 的代码（注释已剥）。 */
  async function libSources() {
    const entries = []
    for (const file of await readdir(libDir)) {
      if (!file.endsWith('.js')) continue
      entries.push({ file, source: stripComments(await readFile(join(libDir, file), 'utf8')) })
    }
    return entries
  }

  it('判据变更说明：原先的「零子 Agent」断言已作废，改成只约束引入方式', async () => {
    // 这条断言本身**不再**要求「一个子会话都不能有」。原先那条是为逼出一次自觉的架构决定而写的，
    // 当时的结论是「独立上下文用 `ctx.llm.stream` 就够」。这个结论被推翻了：`llm.stream` 给不了
    // 独立 session identity、独立工具面、独立写作用域与结构化结果，而这四样正是「独立验证」的实质
    // （ADR-0001 §5）。**这是判据变更，不是把测试删掉让门变绿**——所以这里改成断言引入方式。
    const sources = await libSources()
    const childUsers = sources.filter(({ source }) => /\bsubagents\b|\bagents\.create\b/u.test(source))
    assert.ok(
      childUsers.length > 0,
      '按 ADR-0001，节点执行应当走原生子会话；一条都没有说明这条接缝又断开了',
    )
  })

  it('子会话只能经服务接缝取得，不 import DSH 的子会话包', async () => {
    // 注入而非 import：这条接缝可能不在（本机就可能），缺席时要能优雅降级，而不是让插件加载失败。
    // 检查分两步：① 没有任何文件 import 它的包；② **取接缝的那一处**必须是 `ctx.inject` / `ctx.get`
    // ——而不是要求每个提到它的文件都自己取一次（执行者模块是经参数拿到它的，那正是接缝的正确形状）。
    const sources = await libSources()
    const importers = sources
      .filter(({ source }) => /from\s+['"]@deepseek-ai\/dsh-subagent/u.test(source))
      .map(({ file }) => file)
    assert.deepEqual(importers, [], '子会话的包不要 import')

    const seamSites = sources.filter(({ source }) =>
      /inject\(\[[^\]]*['"]subagents['"]/u.test(source) || /get\??\.\(['"]subagents['"]\)/u.test(source))
    assert.ok(seamSites.length > 0, '必须有一处经 ctx.inject / ctx.get 取 subagents')
  })

  it('不引入 Agent Teams 依赖 —— 它不在 profile 的解析集里，且不是执行基座', async () => {
    // Team 与原生子会话是同一个基座上的两个消费者，但它的看板没有 mode / 写作用域 / 证据 / 验证计划
    // / 风险升级，两套任务模型必然漂移（ADR-0001 §3 D3）。这里把它钉成结构性约束。
    //
    // **判据变更说明**：这条原先要求「任何文件都不许出现这些名字」。收口阶段 `lib/role-tools.js` 必须
    // **点名**它们，才能把它们从子会话工具面里收掉——点名拒绝与把执行基座建在上面是两回事，前者正是
    // 这条约束要的执行方式。所以判据从「谁提到」收紧到「谁拿它当依赖」：只有那一处拒绝名单可以提到
    // 这些名字，且它不许 import 那个包、不许注册任何工具。
    const allowlist = new Set(['role-tools.js'])
    const sources = await libSources()
    const offenders = sources
      .filter(({ file, source }) => !allowlist.has(file)
        && /agentTeams|spawn_teammate|team_task_|dsh-experimental-agent-team/u.test(source))
      .map(({ file }) => file)
    assert.deepEqual(offenders, [], '不要把执行基座建在 Agent Teams 上')

    const policy = sources.find(({ file }) => file === 'role-tools.js')
    assert.ok(policy !== undefined, '点名委派工具的拒绝名单模块应当存在')
    assert.doesNotMatch(policy.source, /agent-team/u, '拒绝名单不 import 那个包')
    assert.doesNotMatch(policy.source, /\.register\s*\(/u, '拒绝名单不注册工具')
  })
})

describe('resolve-dsh', () => {
  it('未知包退化为 undefined，而不是抛错', async () => {
    const { resolveDshPackage } = await import('../lib/resolve-dsh.js')
    assert.equal(resolveDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('在本机找到 DSH 运行时，或如实报告没找到', async () => {
    const { resolveDshPackage } = await import('../lib/resolve-dsh.js')
    const resolved = resolveDshPackage('@deepseek-ai/dsh-tools')
    // 不把它当作硬性要求来断言：没有安装 DSH 的贡献者仍应能跑单元测试套件。当它确实
    // 解析成功时，必须解析到一个真实路径。
    if (resolved !== undefined) {
      assert.match(resolved, /dsh-tools/u)
    }
  })
})
