/**
 * 包解析测试。
 *
 * 它们因一次真实故障而存在：锚点列表在开发者 shell 里解析正常，在宿主进程内却
 * 失败，于是插件加载时作用域工具静默缺席，只报了一句「不可解析」。因此这里测的是
 * 该策略的契约——锚点有序、原因各不相同、不抛错——而不是只测「在这台机器上能不能
 * 跑通」。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  candidateAnchors,
  describeResolutionFailure,
  importDshPackage,
  resolveDshPackage,
  resolveWithDiagnostics,
} from '../lib/resolve-dsh.js'

describe('candidateAnchors', () => {
  it('returns a de-duplicated, non-empty list', () => {
    const anchors = candidateAnchors()
    assert.ok(anchors.length > 0)
    assert.equal(new Set(anchors).size, anchors.length)
  })

  it('leads with this process, not with an environment variable', () => {
    // 以进程为依据的锚点是事实；环境变量则可能未设置。
    // 排序把确定的东西放在最前面。
    assert.equal(candidateAnchors()[0], process.execPath)
  })

  it('includes an anchor beside the plugin itself', () => {
    assert.ok(
      candidateAnchors().some((anchor) => anchor.endsWith('package.json') && anchor.includes('Agent_Runtime')),
      'expected the plugin directory to contribute an anchor',
    )
  })

  it('returns only absolute-looking paths', () => {
    for (const anchor of candidateAnchors()) {
      assert.match(anchor, /^([A-Za-z]:[\\/]|\/)/u, `anchor is not absolute: ${anchor}`)
    }
  })

  it('anchors to each profile directory, which is what reaches the hoisted modules', () => {
    // 这个列表就是为这次回归而存在的。可用的锚点是 profile 目录：Node 会从它向上
    // 走到 `profiles/node_modules/@deepseek-ai`。锚定到 `profiles/package.json`
    // 等于假设了一个并不存在的清单文件，于是每个锚点都落空，插件加载时连工具都没有。
    const home = process.env.DSH_HOME
      ?? (process.env.USERPROFILE ?? process.env.HOME)
    if (home === undefined) return

    const profilesDir = `${home.replace(/\\/gu, '/')}/profiles`.replace(/\//gu, '\\')
    const fromProfiles = candidateAnchors().filter((a) => a.startsWith(profilesDir))
    // 要么某个 profile 目录贡献了一个锚点，要么这台机器压根没有 profile——
    // 后一种情况下就没有什么可断言的了。
    const hasProfiles = fromProfiles.length > 0
    if (hasProfiles) {
      assert.ok(
        fromProfiles.some((anchor) => !anchor.endsWith('profiles\\package.json')),
        'expected an anchor inside a profile directory, not only profiles/package.json',
      )
    }
  })
})

describe('resolveWithDiagnostics', () => {
  it('resolves a real package from a real anchor', () => {
    const found = candidateAnchors().find((anchor) => {
      const { resolved } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [anchor])
      return resolved !== undefined
    })
    // 故意宽容：没装 DSH 的贡献者仍然能跑单元测试集。当它确实解析成功时，路径
    // 必须指向真实的包。
    if (found !== undefined) {
      const { resolved } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [found])
      assert.match(resolved, /dsh-tools/u)
    }
  })

  it('records a missing anchor distinctly from a package miss', () => {
    const missing = '/definitely/not/a/real/path/package.json'
    const { resolved, attempts } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [missing])
    assert.equal(resolved, undefined)
    assert.deepEqual(attempts, [{ anchor: missing, reason: 'anchor does not exist' }])
  })

  it('records why an existing anchor failed to satisfy the request', () => {
    // 一个真实存在、但与那个包毫无关系的文件：原因必须是一个模块解析错误码，
    // 而不是「锚点不存在」。
    const { resolved, attempts } = resolveWithDiagnostics(
      '@deepseek-ai/definitely-not-a-real-package',
      [process.execPath],
    )
    assert.equal(resolved, undefined)
    assert.equal(attempts.length, 1)
    assert.notEqual(attempts[0].reason, 'anchor does not exist')
  })

  it('never throws, whatever it is handed', () => {
    assert.doesNotThrow(() => resolveWithDiagnostics('@deepseek-ai/dsh-tools', []))
    assert.doesNotThrow(() => resolveWithDiagnostics('', [process.execPath]))
  })
})

describe('describeResolutionFailure', () => {
  it('names every anchor tried and its reason', () => {
    // 这就是落进加载报告里的那段字符串；只有一句「不可解析」曾把一次真实的排查
    // 引向了错误的方向。
    const message = describeResolutionFailure('@deepseek-ai/definitely-not-a-real-package')
    assert.match(message, /@deepseek-ai\/definitely-not-a-real-package/u)
    assert.match(message, /anchors tried/u)
    assert.match(message, /\[/u)
  })
})

describe('public helpers', () => {
  it('resolveDshPackage returns undefined rather than throwing', () => {
    assert.equal(resolveDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('importDshPackage returns undefined for an unresolvable package', async () => {
    assert.equal(await importDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('importDshPackage yields a usable defineTool when the runtime is present', async () => {
    const tools = await importDshPackage('@deepseek-ai/dsh-tools')
    if (tools !== undefined) {
      assert.equal(typeof tools.defineTool, 'function')
    }
  })
})
