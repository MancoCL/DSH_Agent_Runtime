/**
 * 哪些工具调用会写入哪些路径。
 *
 * @module dsh-gac-runtime/tool-targets
 *
 * 本模块回答一个问题——「这次工具调用会碰到哪些文件？」——并且它依据的是工具的
 * *已声明参数*，而绝不是它的名字或描述文本。有两个后果是刻意为之的：
 *
 *  1. 分类是一张封闭的表，外加一个显式的未知情形。这张表不认识的工具**不会**被
 *     假定为安全。扩宽运行时绝不能悄悄扩宽它的权限（架构大纲 §20、§22），因此
 *     无法识别的工具会被报告为 `unknown`，由调用方决定。
 *
 *  2. shell 执行器（`pwsh`、`bash`）被归类为 `shell`，而不是 `write`，并且不产出
 *     任何路径。这是对适配计划 §7 所确立的 DSH 边界的如实陈述：工具管道上的守卫
 *     看不到埋在命令字符串里的重定向目标。把它们报告为「无目标」而不是凭空发明
 *     一套解析，就会让本模块声称一个它无法提供的保证。
 *
 * 对 `shell` 和 `unknown`，调用方绝不能把空的目标列表当作无害的证明；见
 * `classifyCall`，它把结论命名出来，这样下游读者就不必从一个空数组去推断。
 */

/**
 * 会修改文件的工具，映射到承载路径的参数名。
 *
 * 只要某个工具族的任一拼写为人所知，`file_path` 和 `path` 就会都被列出。列出一个
 * 给定工具并不使用的名字毫无代价（该参数只是不存在而已）；漏掉一个却会丢失对该
 * 工具的强制执行，而那才是代价高昂的方向。
 */
const WRITE_TOOLS = Object.freeze({
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace: ['file_path', 'path'],
  apply_patch: ['file_path', 'path'],
  create_file: ['file_path', 'path'],
  delete_file: ['file_path', 'path'],
  move_file: ['file_path', 'path', 'destination', 'to'],
})

/**
 * 不碰任何文件的工具，列出来是为了让未知情形仍然有意义。
 *
 * `gac_scope` 属于这里，而它当初的缺席是一个真实的缺陷：一个无法被检视或释放的
 * 作用域是个陷阱，而守卫偏偏拒绝了那个能够释放它的工具。它只会改动内存中的注册表，
 * 因此没有任何文件系统影响需要管束。
 *
 * 任何加进这里的工具都在断言「它不能写入」，这比「它是只读的」这个说法更强——
 * 一个能修改文件的工具绝不能被列进来，不管它的名字看起来多无害。
 */
const READ_TOOLS = Object.freeze([
  'read',
  'glob',
  'grep',
  'read_image',
  'list_dir',
  'search',
  'web_fetch',
  'web_search',
  'ask_user_question',
  'todo_write',
  'list_agents',
  'job_list',
  'job_output',
  // GAC 自己的作用域工具：只改动内存中的注册表，从不碰文件。
  'gac_scope',
])

/** 执行命令字符串、因而能隐形写入的工具。 */
const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'shell', 'run_terminal'])

/** 一次已分类调用可能携带的结论。 */
export const CALL_KINDS = Object.freeze({
  WRITE: 'write',
  READ: 'read',
  SHELL: 'shell',
  UNKNOWN: 'unknown',
})

/**
 * 把一个已声明参数强制转换为路径字符串。
 *
 * 非字符串会被丢弃而不是字符串化：对对象做 `${value}` 会得到 "[object Object]"，
 * 它随后会被规范化并当作一个路径来比较——这是一个悄悄错误的答案，而不是一处
 * 可见的缺口。
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function asPath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 从一次工具调用中提取每一个路径参数。
 *
 * @param {string} name - 注册表所知道的工具名。
 * @param {unknown} args - 已解析的参数对象。
 * @returns {string[]} 已声明的路径，按参数声明顺序。
 */
export function extractPaths(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const keys = WRITE_TOOLS[name]
  if (keys === undefined) return []
  const found = []
  for (const key of keys) {
    const value = asPath(args[key])
    if (value !== undefined && !found.includes(value)) found.push(value)
  }
  return found
}

/**
 * 对一次工具调用进行分类。
 *
 * @param {string} name - 工具名。
 * @param {unknown} args - 已解析的参数。
 * @returns {{
 *   kind: string,
 *   name: string,
 *   paths: readonly string[],
 *   guarded: boolean,
 *   reason?: string
 * }}
 *   `guarded` 说明写作用域检查是否能有意义地施加：只有 `write` 调用携带守卫
 *   可以检视的路径。`shell` 与 `unknown` 被显式标记为不受守卫，调用方应当把这一
 *   缺口暴露出来，而不是把它掩盖过去。
 */
export function classifyCall(name, args) {
  const toolName = typeof name === 'string' ? name : ''

  if (WRITE_TOOLS[toolName] !== undefined) {
    const paths = extractPaths(toolName, args)
    if (paths.length === 0) {
      // 一个已知的写工具却没有可用的路径参数。如果上游某层重命名了字段，这个
      // 分支就会走到；把它当作无害，恰恰是本模块存在所要防止的那种悄悄扩宽失败。
      return {
        kind: CALL_KINDS.WRITE,
        name: toolName,
        paths: [],
        guarded: false,
        reason: `tool "${toolName}" is a write tool but carried no readable path argument`,
      }
    }
    return { kind: CALL_KINDS.WRITE, name: toolName, paths, guarded: true }
  }

  if (SHELL_TOOLS.includes(toolName)) {
    return {
      kind: CALL_KINDS.SHELL,
      name: toolName,
      paths: [],
      guarded: false,
      reason:
        `tool "${toolName}" runs a command string; a redirection or generator `
        + 'target inside it is not visible to a tool-pipeline guard',
    }
  }

  if (READ_TOOLS.includes(toolName)) {
    return { kind: CALL_KINDS.READ, name: toolName, paths: [], guarded: false }
  }

  return {
    kind: CALL_KINDS.UNKNOWN,
    name: toolName,
    paths: [],
    guarded: false,
    reason: `tool "${toolName}" is not in the known table, so its write behaviour is unknown`,
  }
}

/**
 * 本模块所识别的工具名，供测试和诊断视图使用。
 *
 * @returns {{write: readonly string[], read: readonly string[], shell: readonly string[]}}
 */
export function knownTools() {
  return {
    write: Object.keys(WRITE_TOOLS),
    read: [...READ_TOOLS],
    shell: [...SHELL_TOOLS],
  }
}
