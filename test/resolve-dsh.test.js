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
  it('返回一个去重后的非空列表', () => {
    const anchors = candidateAnchors()
    assert.ok(anchors.length > 0)
    assert.equal(new Set(anchors).size, anchors.length)
  })

  it('以本进程打头，而不是以环境变量打头', () => {
    // 以进程为依据的锚点是事实；环境变量则可能未设置。
    // 排序把确定的东西放在最前面。
    assert.equal(candidateAnchors()[0], process.execPath)
  })

  it('包含一个就在插件旁边的锚点', () => {
    assert.ok(
      candidateAnchors().some((anchor) => anchor.endsWith('package.json') && anchor.includes('Agent_Runtime')),
      '插件目录应当贡献一个锚点',
    )
  })

  it('只返回看起来是绝对路径的路径', () => {
    for (const anchor of candidateAnchors()) {
      assert.match(anchor, /^([A-Za-z]:[\\/]|\/)/u, `锚点不是绝对路径: ${anchor}`)
    }
  })

  it('锚定到每一个 profile 目录，因为那才是够得着被提升模块的位置', () => {
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
        '应当有锚点落在某个 profile 目录之内，而不只是 profiles/package.json',
      )
    }
  })
})

describe('resolveWithDiagnostics', () => {
  it('从一个真实锚点解析出一个真实的包', () => {
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

  it('把锚点缺失与包未命中区分记录', () => {
    const missing = '/definitely/not/a/real/path/package.json'
    const { resolved, attempts } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [missing])
    assert.equal(resolved, undefined)
    assert.deepEqual(attempts, [{ anchor: missing, reason: '锚点不存在' }])
  })

  it('记录一个存在的锚点为何没能满足这次请求', () => {
    // 一个真实存在、但与那个包毫无关系的文件：原因必须是一个模块解析错误码，
    // 而不是「锚点不存在」。
    const { resolved, attempts } = resolveWithDiagnostics(
      '@deepseek-ai/definitely-not-a-real-package',
      [process.execPath],
    )
    assert.equal(resolved, undefined)
    assert.equal(attempts.length, 1)
    assert.notEqual(attempts[0].reason, '锚点不存在')
  })

  it('无论被交予什么，都绝不抛错', () => {
    assert.doesNotThrow(() => resolveWithDiagnostics('@deepseek-ai/dsh-tools', []))
    assert.doesNotThrow(() => resolveWithDiagnostics('', [process.execPath]))
  })
})

describe('describeResolutionFailure', () => {
  it('点名试过的每一个锚点及其原因', () => {
    // 这就是落进加载报告里的那段字符串；只有一句「不可解析」曾把一次真实的排查
    // 引向了错误的方向。
    const message = describeResolutionFailure('@deepseek-ai/definitely-not-a-real-package')
    assert.match(message, /@deepseek-ai\/definitely-not-a-real-package/u)
    assert.match(message, /试过的锚点/u)
    assert.match(message, /\[/u)
  })
})

describe('公开的辅助函数', () => {
  it('resolveDshPackage 返回 undefined，而不是抛错', () => {
    assert.equal(resolveDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('importDshPackage 对无法解析的包返回 undefined', async () => {
    assert.equal(await importDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('运行时在场时，importDshPackage 给出可用的 defineTool', async () => {
    const tools = await importDshPackage('@deepseek-ai/dsh-tools')
    if (tools !== undefined) {
      assert.equal(typeof tools.defineTool, 'function')
    }
  })
})
