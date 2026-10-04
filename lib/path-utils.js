/**
 * 插件桥共享的小型路径辅助函数。
 *
 * @module dsh-gac-runtime/path-utils
 *
 * `lib/write-scope.js` 负责包含判定。本模块负责 DSH 桥在调用包含判定之前需要
 * 弄清的两个小问题：「这个路径是绝对路径吗？」以及「如果是，就把工程根前缀
 * 去掉」。它们被分出来，是为了让安全原语不沾宿主的形状，也是为了让
 * `lib/write-scope.js` 能在完全不知道盘符为何物的情况下被测试。
 */

import { normalizePath } from './write-scope.js'

/**
 * 转成本平台文件系统 API 期待的写法。
 *
 * 插件内部一律用 `/` 分隔（因为写范围匹配器与包含判定都在这个约定上），只在真正调用文件
 * 系统前转一次。定义在这里而不是各处自己写：转义规则只该有一个定义处，否则总有一处会漏，
 * 而漏掉的那处会以「文件找不到」的形式出现，与真正的缺失难以区分。
 *
 * @param {string} path
 * @returns {string}
 */
export function toNativePath(path) {
  return process.platform === 'win32' ? path.replace(/\//gu, '\\') : path
}

/**
 * 在我们运行的所有平台上，这是一个有根的路径吗？
 *
 * Windows 盘符路径、POSIX 根与 UNC 根都会被识别。这一检查刻意只做语法判断：
 * 它发生在任何一次文件系统往返之前，而这里答错会退化成「当作相对路径处理」，
 * 在包含判定中这就是失败即拒绝（保守方向）。
 *
 * @param {string} candidate
 * @returns {boolean}
 */
export function isAbsolutePath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  const unified = candidate.replace(/\\/gu, '/')
  return unified.startsWith('/')
    || unified.startsWith('//')
    || /^[A-Za-z]:\//u.test(unified)
}

/**
 * 从绝对候选路径上剥掉工程根前缀。
 *
 * 当候选路径不在根内时原样返回，这样一个逃出工程的路径就无法被洗成
 * 作用域相对路径，进而匹配上它本该错过的那个作用域。
 *
 * @param {string} candidate - 书写形式的路径。
 * @param {string} root - 工程根，绝对路径。
 * @param {{foldCase?: boolean}} [options]
 * @returns {string} 相对于 `root` 的路径，或原样返回的 `candidate`。
 */
export function relativize(candidate, root, options = {}) {
  const normalizedCandidate = normalizePath(candidate, options)
  const normalizedRoot = normalizePath(root, options).replace(/\/+$/u, '')
  if (normalizedRoot === '') return normalizedCandidate
  if (normalizedCandidate === normalizedRoot) return '.'
  if (normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    return normalizedCandidate.slice(normalizedRoot.length + 1)
  }
  return normalizedCandidate
}

/**
 * 尽力从会话的工作目录推出工程根。
 *
 * 会话头上带有一个绝对的 `cwd`；除非工程适配器另有说法，GAC 就把它当作工程根。
 * 返回 `undefined` 而不是给出一个猜测，是为了让调用方保持诚实：没有根时，
 * 包含判定比较的是原始路径，而拒绝仍然是安全的结果。
 *
 * @param {unknown} cwd
 * @returns {string|undefined}
 */
export function projectRootFromCwd(cwd) {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim()
  if (trimmed === '' || !isAbsolutePath(trimmed)) return undefined
  return trimmed.replace(/\\/gu, '/')
}
