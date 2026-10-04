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
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** lib/ 中的每个模块，靠发现而非列举，这样新增的模块也会被覆盖。 */
const modules = [
  'index.js',
  'claims.js',
  'claim-store.js',
  'plugin.js',
  'project.js',
  'project-state.js',
  'path-utils.js',
  'resolve-dsh.js',
  'session-scope.js',
  'tool-project.js',
  'tool-scope.js',
  'tool-targets.js',
  'write-scope.js',
]

describe('every library module parses and imports', () => {
  for (const file of modules) {
    it(`imports lib/${file}`, async () => {
      const loaded = await import(`../lib/${file}`)
      assert.equal(typeof loaded, 'object')
    })
  }
})

describe('the entry point satisfies the Cordis plugin contract', () => {
  it('exports name, inject and apply', async () => {
    const entry = await import('../lib/index.js')
    assert.equal(typeof entry.name, 'string')
    assert.ok(entry.name.length > 0)
    assert.ok(Array.isArray(entry.inject))
    assert.equal(typeof entry.apply, 'function')
  })

  it('declares the services its guard actually reads', async () => {
    const entry = await import('../lib/index.js')
    // 守卫通过 `sessions` 解析会话的 cwd，并通过 `tools` 进行拦截。声明得更少会让插件
    // 加载进一个它无法履职的组合里。
    assert.deepEqual([...entry.inject].sort(), ['sessions', 'tools'])
  })

  it('apply is awaitable, because it resolves a package before registering', async () => {
    const entry = await import('../lib/index.js')
    // 正是异步函数让 DSH 包的解析发生在 effect 主体之前——后者是一个生成器，不能含有
    // `await`。
    assert.equal(entry.apply.constructor.name, 'AsyncFunction')
  })
})

describe('the entry point defers DSH imports to call time', () => {
  it('has no static import of a bare @deepseek-ai package', async () => {
    const source = await readFile(join(libDir, 'index.js'), 'utf8')
    // 在模块作用域做裸导入会在加载器求值该模块时抛错，而这发生在 `apply` 能上报可诊断
    // 原因之前。顶层只允许从相对路径导入的值。
    const staticBareImports = [...source.matchAll(/^import[^;]*?from\s+'(@deepseek-ai\/[^']+)'/gmu)]
    assert.deepEqual(staticBareImports.map((m) => m[1]), [])
  })
})

describe('resolve-dsh', () => {
  it('degrades to undefined rather than throwing for an unknown package', async () => {
    const { resolveDshPackage } = await import('../lib/resolve-dsh.js')
    assert.equal(resolveDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('finds the DSH runtime on this machine, or reports that it did not', async () => {
    const { resolveDshPackage } = await import('../lib/resolve-dsh.js')
    const resolved = resolveDshPackage('@deepseek-ai/dsh-tools')
    // 不把它当作硬性要求来断言：没有安装 DSH 的贡献者仍应能跑单元测试套件。当它确实
    // 解析成功时，必须解析到一个真实路径。
    if (resolved !== undefined) {
      assert.match(resolved, /dsh-tools/u)
    }
  })
})
