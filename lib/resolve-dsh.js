/**
 * 从链接式安装的插件内部解析 DSH 包。
 *
 * @module dsh-gac-runtime/resolve-dsh
 *
 * 按本地路径安装进 DSH profile 的插件是被链接的，不是被复制的，所以
 * 它保留着自己的 `node_modules`——其中并不包含 `@deepseek-ai/*`。
 * 因此从这里裸导入那些包会失败，尽管从每一个随 DSH 出厂的
 * 插件里都能成功。
 *
 * 解决办法是从一个*确实*看得见它们的位置去解析。那个位置
 * 究竟是哪里，结果是与环境相关的，而本模块身上带着
 * 两次搞错留下的伤疤：
 *
 *  1. 一个猜出来的锚点（`$DSH_HOME/profiles/package.json`）在
 *     开发者 shell 里解析成功、在宿主里失败，于是插件加载起来后工具
 *     悄悄缺席。那个文件并不存在——`profiles/` 是一个容器，
 *     不是包。
 *  2. 修正后的列表仍然没命中，因为它锚定到了并不存在的
 *     清单文件上。真正管用的位置是一个 **profile 目录**：
 *     Node 从它向上遍历，找到被提升的
 *     `profiles/node_modules/@deepseek-ai/*`。
 *
 * 因此：锚点是真实文件，靠发现而非假定得来，并按最贴近进程的
 * 排在前面。`createRequire` 只需要一条存在的路径；
 * 该文件不必是清单文件。
 *
 * 内嵌一份 `defineTool` 的副本可以绕开这一切，但这个方案被否决了：
 * 值得复用的是运行时自身的参数校验，而内嵌的副本
 * 会与它悄悄漂移开。
 */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 拼接路径片段，并保留第一个片段的分隔符风格。
 *
 * 避免为了拼接而 import `node:path`，同时让 Windows 盘符路径保持
 * `existsSync` 所期望的形式。
 *
 * @param {...string} parts
 * @returns {string}
 */
function join(...parts) {
  const [first, ...rest] = parts
  const separator = first.includes('\\') ? '\\' : '/'
  return [first.replace(/[\\/]+$/u, ''), ...rest.map((p) => p.replace(/^[\\/]+|[\\/]+$/gu, ''))]
    .filter((part) => part !== '')
    .join(separator)
}

/**
 * 某个父目录下的直接子目录名，以及列举失败时失败的原因。
 *
 * 之所以把原因返回而不是把它吞掉，是因为一次失败的列举会悄悄
 * 抹掉所有 profile 锚点，看起来与「不存在任何 profile」一模一样——
 * 这种不透明性已经让这项工作多花了两轮调试。
 *
 * @param {string} parent
 * @returns {{names: string[], error?: string}}
 */
function directoriesIn(parent) {
  try {
    const names = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
    return { names }
  } catch (error) {
    return {
      names: [],
      error: error instanceof Error ? (error.code ?? error.message) : String(error),
    }
  }
}

/**
 * DSH 主目录，取自 harness 所设置的环境变量。
 *
 * @returns {string|undefined}
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  const userHome = process.env.USERPROFILE ?? process.env.HOME
  return userHome === undefined || userHome === '' ? undefined : join(userHome, '.dsh')
}

/**
 * 可以充当 `createRequire` origin 的候选文件，以及该列表是
 * 如何推导出来的。
 *
 * 之所以导出，是因为解析失败要靠锚点列表来诊断，而
 * 每次这里出问题，错的都是这个列表。
 *
 * @returns {{anchors: string[], notes: string[]}}
 */
export function anchorReport() {
  const anchors = []
  const notes = []

  // 正在运行的可执行文件。这是关于本进程的一个事实，不过在装了
  // 系统 Node 的机器上，它离 harness 安装位置很远——这正是
  // 它不能是唯一锚点的原因。
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    anchors.push(process.execPath)
  }

  // 插件旁边。只有当插件就住在 harness 内部时才够得着 harness。
  try {
    anchors.push(join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'))
  } catch {
    notes.push('插件 URL 没有对应的文件系统目录')
  }

  const home = dshHome()
  if (home === undefined) {
    notes.push('DSH_HOME、USERPROFILE 和 HOME 都没有设置')
  } else {
    notes.push(`dsh 主目录解析为 ${home}`)
    // 管用的锚点是 profile **目录**：Node 从它向上遍历到
    // 被提升的 profiles/node_modules。锚定到 `profiles/package.json`
    // 曾假定存在一个并不存在的清单文件。
    const profilesDir = join(home, 'profiles')
    const { names, error } = directoriesIn(profilesDir)
    if (error !== undefined) {
      notes.push(`无法列举 ${profilesDir}：${error}`)
    } else {
      notes.push(`profiles 目录下有 ${names.length} 个条目：${names.join(', ') || '（无）'}`)
    }
    for (const profile of names) {
      anchors.push(join(profilesDir, profile, 'package.json'))
    }
    // 一次被提升的安装，旁边没有任何 profile。
    anchors.push(join(profilesDir, 'package.json'))
    anchors.push(join(home, 'package.json'))
  }

  // 从源码检出启动的 harness。
  try {
    anchors.push(join(process.cwd(), 'package.json'))
  } catch {
    notes.push('当前工作目录不可用')
  }

  return { anchors: [...new Set(anchors)], notes }
}

/**
 * 可以充当 `createRequire` origin 的文件，最可靠的排在最前。
 *
 * @returns {string[]}
 */
export function candidateAnchors() {
  return anchorReport().anchors
}

/**
 * 解析一个包，并报告试过的每个锚点以及各自失败的原因。
 *
 * 以返回值给出而不是打日志，是为了让调用方能往自己的报告里放进
 * 一条可诊断的原因，而不是一句没用的「无法解析」。
 *
 * @param {string} specifier - 例如 `@deepseek-ai/dsh-tools`。
 * @param {string[]} [anchors] - 覆盖默认值，用于测试。
 * @returns {{resolved?: string, attempts: {anchor: string, reason: string}[]}}
 */
export function resolveWithDiagnostics(specifier, anchors = candidateAnchors()) {
  const attempts = []
  for (const anchor of anchors) {
    // 磁盘上不存在的锚点无法充当 origin。把这一情况与「origin 存在但
    // 缺少该包」分开记录很重要：两者指向不同的问题，而把它们
    // 混为一谈，曾让这个会话白跑了一轮方向错误的调试。
    if (!existsSync(anchor)) {
      attempts.push({ anchor, reason: '锚点不存在' })
      continue
    }
    try {
      const require = createRequire(anchor)
      return { resolved: require.resolve(specifier), attempts }
    } catch (error) {
      attempts.push({
        anchor,
        reason: error instanceof Error ? (error.code ?? error.message) : String(error),
      })
    }
  }
  return { attempts }
}

/**
 * 把一个 DSH 包解析为绝对路径。
 *
 * @param {string} specifier
 * @returns {string|undefined}
 */
export function resolveDshPackage(specifier) {
  return resolveWithDiagnostics(specifier).resolved
}

/**
 * 解释一次失败的解析：锚点列表是如何推导出来的、试过哪些锚点，
 * 以及各自为何失败。
 *
 * @param {string} specifier
 * @returns {string}
 */
export function describeResolutionFailure(specifier) {
  const { anchors, notes } = anchorReport()
  const { attempts } = resolveWithDiagnostics(specifier, anchors)
  const derivation = notes.length > 0 ? `${notes.join('；')}。` : ''
  if (attempts.length === 0) {
    return `没有可用于 ${specifier} 的解析锚点。${derivation}`
  }
  const detail = attempts
    .map(({ anchor, reason }) => `${anchor} [${reason}]`)
    .join('; ')
  return `${derivation}无法解析 ${specifier}；试过的锚点有：${detail}`
}

/**
 * 按名字 import 一个 DSH 包，从 DSH 运行时解析。
 *
 * 返回 `undefined` 而不是抛错，以便调用方降级处理：一个无法 import
 * 可选辅助模块的插件，仍应装上它的守卫，因为守卫才是
 * 要紧的那部分。
 *
 * 解析出的路径必须在 import 之前转换成 `file:` URL：在 Windows 上
 * 默认的 ESM 加载器会以一个裸盘符路径报出
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` 而拒绝它。这是一个真实的缺陷——解析成功了，
 * import 却悄悄什么也没返回，调用方把它报成「无法
 * 解析」，于是又白跑了一轮方向错误的调试。
 *
 * 一次成功的 import 仍可能毫无用处（在某种奇特的加载器下，
 * 模块可以求值为 `null`），所以调用方必须检查自己需要的那种形状，
 * 而不能相信一个为真的 import 结果。
 *
 * @param {string} specifier
 * @returns {Promise<any|undefined>}
 */
export async function importDshPackage(specifier) {
  const resolved = resolveDshPackage(specifier)
  if (resolved === undefined) return undefined
  try {
    return (await import(pathToFileURL(resolved).href)) ?? undefined
  } catch {
    return undefined
  }
}
