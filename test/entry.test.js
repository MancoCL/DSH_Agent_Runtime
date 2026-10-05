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

describe('零子 Agent —— E2E-1 的第三条断言', () => {
  /**
   * 把注释剥掉，只留代码。
   *
   * 这条断言问的是「有没有子 Agent **调用**」，而注释里提一句某个工具的名字（例如说明某个宿主把
   * Team 那几个工具注册进了 agent 自己的层）并不是调用。早先直接对源码做词面扫描，于是那样一条
   * 注释会把测试弄红——**红得没有道理**，而一条会因为没道理地红而被删掉的测试，比没有测试更糟。
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

  it('lib/ 的代码里没有任何子 Agent 调用（注释不算）', async () => {
    // E2E-1 要求「零子 Agent 调用」，而这条性质此前只是没人写过而已——没人写过与「不会写」
    // 是两件事。适配计划 §3.2 说得很清楚：需要独立上下文时用 `ctx.llm.stream`（进程内的一次
    // 模型调用），只有需要独立会话、独立工作目录时才轮到子 Agent。因此这里断言的是**这个决定
    // 被钉住了**：一旦有人真的调用它，这条测试会红，而那时该先回答「为什么需要独立会话」——
    // 那是一个架构决定，不该顺手做掉。
    const offenders = []
    for (const file of await readdir(libDir)) {
      if (!file.endsWith('.js')) continue
      const source = stripComments(await readFile(join(libDir, file), 'utf8'))
      if (/subagents?\b/u.test(source)) offenders.push(file)
    }
    assert.deepEqual(offenders, [], '引入子 Agent 之前先回答：为什么进程内模型调用不够')
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
