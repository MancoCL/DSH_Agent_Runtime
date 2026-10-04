/**
 * GAC 写作用域的严格路径包含判定。
 *
 * @module dsh-gac-runtime/write-scope
 *
 * 为什么本模块是纯函数且独立自足
 * --------------------------------------
 * 这就是架构大纲（§21、§56）点名的安全边界：
 *
 *     「便捷别名绝不能泄漏进安全边界。」
 *
 * 在运行时，*候选*路径来自文件系统提供方（`ctx.fs.resolve`，它已经折叠了
 * 符号链接与真实路径），而工程边界由 `ctx.fs.contains` 回答。但那个*决策 ——
 * 这个候选路径是否落在已声明的写作用域之内* —— 必须只有一份实现，且不依赖
 * DSH 就能测试，因为第二份只活在 ABI 内部的实现会悄悄与本实现漂移。
 *
 * 所以：规范化与包含判定在这里是纯函数，由 test/write-scope.test.js 覆盖，
 * 而 lib/index.js 只是一个薄薄的调用方。
 *
 * 承载语义的几条约定（每一条都是前身 Python 运行时里的真实缺陷 —— 见
 * ~/.claude/workflow/README.md 的「口径」一节）：
 *
 *  1. 作用域 `mod.c` 的含义**恰恰**是 `./mod.c`。
 *     它**不**表示 `src/mod.c`，也**不**表示 `other/mod.c`。
 *     裸文件名本身就是作用域，从来不是别名。
 *
 *  2. 在 Windows 上 `SRC/MOD.C` 与 `src/mod.c` 是同一个文件。
 *     只折叠写法而不折叠大小写，会让它下面的每一道守卫都能被一次按键绕过。
 *
 *  3. `*` 与 `**` 都跨越目录分隔符，与 `fnmatch` 一致。
 *     这有意把 `src/*` 放宽到覆盖 `src/sub/a.c`。保留它是为了行为兼容：
 *     过宽的作用域收窄的是*允许*写入的范围，所以它在保守方向上是安全的。
 *     不要在没重读第 (2) 条的情况下把它「修正」成 `*` 遇分隔符即停的语义。
 */

/** 作用域中可识别的 glob 元字符。 */
const GLOB_CHARS = /[*?[\]]/u

/**
 * 折叠大小写，除非被明确要求不要折叠。
 *
 * Windows 与 macOS 的默认文件系统不区分大小写，所以 `src/x.c` 与 `SRC/X.C`
 * 是同一个文件。我们默认折叠（在严格一侧失败即拒绝）；了解得更多的调用方
 * 可以选择不折叠。注意，比文件系统*更*激进地折叠，对目录式作用域只会让
 * 作用域更严格，而对精确文件作用域，它挡住了大小写变体的绕过 —— 这正是
 * 我们希望自己出错时偏向的方向。
 *
 * @param {string} value
 * @param {boolean} foldCase
 * @returns {string}
 */
function fold(value, foldCase) {
  return foldCase ? value.toLowerCase() : value
}

/**
 * 为比较而规范化一个路径：统一分隔符、解析 `.` 与 `..` 段，并去掉末尾的
 * 分隔符（根除外）。
 *
 * `..` 是按字面词法解析的。这是有意的：拿真实文件系统去解析它，会让安全
 * 决策依赖 I/O，而字面词法解析*没能折叠*一次穿越，是安全的错误方向
 * （它给出一个不匹配的路径，于是写入被拒绝）。
 *
 * @param {string} raw - 书写形式的路径（作用域或候选）。
 * @param {{foldCase?: boolean}} [options]
 * @returns {string} 规范化后的路径，`\` 已替换为 `/`。
 * @throws {TypeError} 当 `raw` 不是非空字符串时。
 */
export function normalizePath(raw, options = {}) {
  const foldCase = options.foldCase !== false
  if (typeof raw !== 'string') {
    throw new TypeError(`write-scope: path must be a string, received ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TypeError('write-scope: path must not be empty')
  }

  // 末尾分隔符只在一处有意义：「这是一个目录作用域」。
  // 它会由 normalizeScope 重新接上，所以这里先去掉。
  const unified = trimmed.replace(/\\/gu, '/')
  const isAbsolute = unified.startsWith('/') || /^[A-Za-z]:\//u.test(unified)

  const segments = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // 能弹掉前一段时就弹掉；否则保留这个 `..`，好让一次穿出作用域的
      // 穿越永远不会碰巧匹配上。
      const previous = segments.at(-1)
      if (previous !== undefined && previous !== '..') segments.pop()
      else if (!isAbsolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }

  const joined = segments.join('/')
  const body = isAbsolute ? `/${joined}` : joined
  return fold(body, foldCase)
}

/**
 * 规范化一个作用域条目。
 *
 * 返回描述符而不是字符串，是因为调用方必须能区分「目录作用域」（覆盖一棵
 * 子树）与「精确文件作用域」（覆盖一个路径）—— 抹平这一区分，正是一个裸
 * 文件名别名泄漏进边界的途径。
 *
 * @param {string} raw
 * @param {{foldCase?: boolean}} [options]
 * @returns {{raw: string, kind: 'dir'|'file'|'glob', value: string, prefixSegments?: string[]}}
 * @throws {TypeError} 当作用域为空或不是字符串时。
 */
export function normalizeScope(raw, options = {}) {
  const foldCase = options.foldCase !== false
  if (typeof raw !== 'string') {
    throw new TypeError(`write-scope: scope must be a string, received ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TypeError('write-scope: scope must not be empty')
  }

  const unified = trimmed.replace(/\\/gu, '/')
  // `src/**` 与 `src/` 都表示「src 这棵子树」。
  const ancestorSuffix = /\/\*\*$/u
  const isAncestorForm = ancestorSuffix.test(unified) || unified.endsWith('/')
  const withoutSuffix = unified.replace(/\/\*\*$/u, '')

  if (!GLOB_CHARS.test(withoutSuffix)) {
    const belongsHere = isAncestorForm && withoutSuffix !== ''
    const normalized = belongsHere
      ? normalizePath(withoutSuffix, options)
      : normalizePath(unified, options)
    return {
      raw: trimmed,
      kind: belongsHere ? 'dir' : 'file',
      value: normalized,
    }
  }

  // glob 作用域。按字面词法规范化非 glob 的路径前缀，然后原样保留
  // 剩下的模式片段。
  const segments = withoutSuffix.split('/')
  const literalSegments = []
  let index = 0
  for (; index < segments.length; index += 1) {
    if (GLOB_CHARS.test(segments[index])) break
    literalSegments.push(segments[index])
  }
  const literalPrefix = literalSegments.join('/')
  const normalizedPrefix = literalPrefix === ''
    ? ''
    : normalizePath(literalPrefix, options)
  const patternTail = segments.slice(index)
  const pattern = [...(normalizedPrefix === '' ? [] : normalizedPrefix.split('/')), ...patternTail]
    .join('/')
  const folded = fold(pattern, foldCase)

  return {
    raw: trimmed,
    kind: 'glob',
    value: folded,
    prefixSegments: pattern.split('/'),
  }
}

/**
 * 把一个 glob 片段列表展开成正则表达式。
 *
 * `*` 与 `**` 都跨分隔符匹配（见文件头第 3 点）；
 * `?` 匹配一个字符；`[...]` 是字符类。
 *
 * @param {string[]} segments
 * @returns {RegExp}
 */
function globToRegExp(segments) {
  let source = '^'
  segments.forEach((segment, position) => {
    if (position > 0) source += '/'
    if (segment === '**') {
      // `a/**/b` 也必须匹配 `a/b`，所以当双星夹在另外两个片段之间时，
      // 要把那个分隔符吃掉。
      if (position > 0) source = source.slice(0, -1)
      source += position === 0 ? '.*' : '(?:/.*)?'
      return
    }
    let inner = ''
    for (let i = 0; i < segment.length; i += 1) {
      const character = segment[i]
      if (character === '*') {
        inner += '.*'
      } else if (character === '?') {
        inner += '.'
      } else if (character === '[') {
        const close = segment.indexOf(']', i + 1)
        if (close === -1) {
          inner += '\\['
        } else {
          inner += segment.slice(i, close + 1)
          i = close
        }
      } else {
        inner += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      }
    }
    source += inner
  })
  return new RegExp(`${source}$`, 'u')
}

/**
 * 一个已规范化的候选路径是否落在一个已规范化的作用域之内？
 *
 * 两个入参都必须已经规范化（相同的大小写折叠、相同的分隔符）—— 调用方应当
 * 经由 {@link createWriteScope} 而不是直接调用本函数，这样规范化就不会在
 * 某一侧被忘记。
 *
 * @param {string} candidate - 已规范化的相对或绝对路径。
 * @param {{kind: string, value: string, prefixSegments?: string[]}} scope
 * @returns {boolean}
 */
function containsNormalized(candidate, scope) {
  if (scope.kind === 'dir') {
    return candidate === scope.value || candidate.startsWith(`${scope.value}/`)
  }
  if (scope.kind === 'file') {
    return candidate === scope.value
  }
  return globToRegExp(scope.prefixSegments).test(candidate)
}

/**
 * 把一份已声明的写作用域编译成可复用的匹配器。
 *
 * 匹配器回答「这个节点可以写这个路径吗？」，并在拒绝时说明已存在哪些作用域，
 * 好让模型能自我纠正而不是靠猜。这段说明不是装饰：一个模型无法据此行动的
 * 拒绝会变成重试循环，其代价高于它拦下的那次写入。
 *
 * @param {readonly string[]} scopes - 已声明的写作用域条目。
 * @param {{foldCase?: boolean, rootPrefix?: string}} [options]
 *   `rootPrefix` 是规范化后的工程根前缀，会从以绝对路径形式到来的候选中
 *   剥掉。
 * @returns {{
 *   scopes: readonly object[],
 *   allows: (candidate: string) => boolean,
 *   explain: (candidate: string) => {allowed: boolean, candidate: string, reason?: string}
 * }}
 * @throws {TypeError} 当 `scopes` 不是数组时。
 */
export function createWriteScope(scopes, options = {}) {
  if (!Array.isArray(scopes)) {
    throw new TypeError('write-scope: scopes must be an array of path strings')
  }
  const foldCase = options.foldCase !== false
  const normalizedScopes = scopes.map((scope) => normalizeScope(scope, { foldCase }))
  const rootPrefix = options.rootPrefix === undefined
    ? undefined
    : normalizePath(options.rootPrefix, { foldCase }).replace(/\/$/u, '')

  const toCandidate = (candidate) => {
    const normalized = normalizePath(candidate, { foldCase })
    if (rootPrefix === undefined || rootPrefix === '') return normalized
    if (normalized === rootPrefix) return ''
    if (normalized.startsWith(`${rootPrefix}/`)) {
      return normalized.slice(rootPrefix.length + 1)
    }
    return normalized
  }

  const allows = (candidate) => {
    const normalized = toCandidate(candidate)
    return normalizedScopes.some((scope) => containsNormalized(normalized, scope))
  }

  const explain = (candidate) => {
    const normalized = toCandidate(candidate)
    if (normalizedScopes.some((scope) => containsNormalized(normalized, scope))) {
      return { allowed: true, candidate: normalized }
    }
    const declared = normalizedScopes.map((scope) => scope.raw)
    return {
      allowed: false,
      candidate: normalized,
      reason: declared.length === 0
        ? 'this node declares no write scope'
        : `declared write scope is [${declared.join(', ')}]`,
    }
  }

  return { scopes: normalizedScopes, allows, explain }
}
