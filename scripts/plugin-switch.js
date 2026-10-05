/**
 * 本插件在 profile 里的开关。
 *
 * @module dsh-gac-runtime/plugin-switch
 *
 * 为什么需要它
 * ------------
 * 本仓库**开发的就是这个插件**，而它一旦启用，HMR 会把每一笔对 `lib/*.js` 的写入热重载进模型
 * 自己正在用的宿主进程。两种失败方向都会把模型关在门外（写作用域闸门失败即拒绝、提示段落的
 * provider 抛错），而且没有可用的工具来收拾。因此本项目的约定是：**默认关闭，只在需要实测时
 * 打开，测完关回去**（见 AGENTS.md §0）。
 *
 * 那条约定的落点是一行 YAML。手工改它有三个坑，脚本把它们各挡一处：
 *
 *  1. **文件在仓库之外**，路径随 profile 而变。所以路径靠发现（`DSH_PROFILE_DIR`、`DSH_HOME`
 *     + `DSH_PROFILE`、`--file`），并在失败时把试过的每个位置与原因都列出来——只报一句「找不到」
 *     曾把一次排查引向错误的方向（同一个教训见 `lib/resolve-dsh.js`）。
 *  2. **改动必须只碰目标块**。这份 patch 是 profile 的最后一层，里面还有别的插件配置；按行替换
 *     整个文件是危险的。所以变换只在 `- id: gac-runtime` 那个块里动手，其余字节原样保留。
 *  3. **开关状态要能被读出来**。默认关闭之后，「现在到底开着没有」不能靠记忆——`status` 就是
 *     为这个问题存在的。
 *
 * 变换与 I/O 分开：`setPluginDisabled` 是纯函数，因此本模块的每条分支都能在没有 DSH 的机器上
 * 被穷尽测试；CLI 只负责解析路径、读写文件、报告结果。
 *
 *     node scripts/plugin-switch.js status
 *     node scripts/plugin-switch.js on
 *     node scripts/plugin-switch.js off
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

/** 本插件在 patch 里的 id。 */
export const PLUGIN_ID = 'gac-runtime'

/** patch 文件名。 */
export const PATCH_FILE = 'cordis.patch.yml'

/** 结构化错误码，便于调用方与测试分支。 */
export const SWITCH_CODES = Object.freeze({
  FILE_MISSING: 'GAC_SWITCH_FILE_MISSING',
  ENTRY_MISSING: 'GAC_SWITCH_ENTRY_MISSING',
  AMBIGUOUS: 'GAC_SWITCH_ENTRY_AMBIGUOUS',
  MALFORMED: 'GAC_SWITCH_MALFORMED',
})

/**
 * 结构化开关错误。
 */
export class SwitchError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'SwitchError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 拼接路径片段，保留第一个片段的分隔符风格。
 *
 * 与 `lib/resolve-dsh.js` 里那个同名函数同一形状：本模块要能在没有 DSH 的机器上跑，因此不为了
 * 拼接去 import `node:path`。
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
 * 一个块的范围：从 `- id: <id>` 那一行起，到下一个顶层条目之前。
 *
 * 顶层条目的判据是「行首的 `- `」——patch 是一个 YAML 数组，每个元素都这么起头。
 *
 * @param {string[]} lines
 * @param {string} id
 * @returns {{start: number, end: number}|undefined}
 */
function findEntry(lines, id) {
  const matches = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*-\s+id\s*:\s*/u.test(lines[index]) && lines[index].includes(id)) {
      matches.push(index)
    }
  }
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    // 两条同 id 的条目意味着「开关到底改哪一条」没有答案。猜一条会让一次改动落在谁也没预期
    // 的地方，而这份文件是 profile 的最后一层。
    throw new SwitchError(
      `patch 里有 ${matches.length} 条 id 含 ${id} 的条目（第 ${matches.map((n) => n + 1).join('、')} 行），`
      + '无法判断该改哪一条；请先手工合并它们',
      SWITCH_CODES.AMBIGUOUS,
      { lines: matches.map((n) => n + 1) },
    )
  }
  const start = matches[0]
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*-\s/u.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

/**
 * 读出某个块当前的开关状态。
 *
 * 没写 `disabled:` 就等于没关——这是 YAML 与 Cordis 的共同语义，不是本模块的发明。
 *
 * @param {string} text - patch 全文。
 * @param {string} [id] - 插件 id。
 * @returns {{disabled: boolean, line: number|undefined}}
 * @throws {SwitchError}
 */
export function readPluginState(text, id = PLUGIN_ID) {
  const lines = String(text ?? '').split('\n')
  const entry = findEntry(lines, id)
  if (entry === undefined) {
    throw new SwitchError(
      `patch 里没有 id 为 ${id} 的条目：本插件在这个 profile 里没有登记`,
      SWITCH_CODES.ENTRY_MISSING,
      { id },
    )
  }
  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const match = /^\s*disabled\s*:\s*(\S*)/u.exec(lines[index])
    if (match === null) continue
    return { disabled: match[1] !== 'false', line: index + 1 }
  }
  return { disabled: false, line: undefined }
}

/**
 * 把某个块的开关设成给定值，其余字节原样保留。
 *
 * @param {string} text - patch 全文。
 * @param {boolean} disabled - 目标状态。
 * @param {object} [options]
 * @param {string} [options.id] - 插件 id。
 * @param {string} [options.comment] - 需要新插入 `disabled:` 行时附在后面的注释。
 * @returns {{text: string, changed: boolean, line: number}}
 * @throws {SwitchError}
 */
export function setPluginDisabled(text, disabled, options = {}) {
  const id = options.id ?? PLUGIN_ID
  const source = String(text ?? '')
  const lines = source.split('\n')
  const entry = findEntry(lines, id)
  if (entry === undefined) {
    throw new SwitchError(
      `patch 里没有 id 为 ${id} 的条目，因此没有开关可改。`
      + '本插件要先装进这个 profile（plugin_manager 的 install_bundle）才会出现在这里',
      SWITCH_CODES.ENTRY_MISSING,
      { id },
    )
  }

  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const match = /^(\s*)disabled\s*:\s*(\S*)(.*)$/u.exec(lines[index])
    if (match === null) continue
    const [, indent, current, tail] = match
    const next = `${indent}disabled: ${disabled}${tail}`
    if (next === lines[index]) return { text: source, changed: false, line: index + 1 }
    lines[index] = next
    return { text: lines.join('\n'), changed: true, line: index + 1 }
  }

  // 块里没有这一行：插在 id 行的紧后面，与 Cordis 的其它条目同一个缩进风格。
  const indent = `${/^(\s*)/u.exec(lines[entry.start])[1]}  `
  const comment = options.comment === undefined ? '' : `      # ${options.comment}`
  lines.splice(entry.start + 1, 0, `${indent}disabled: ${disabled}${comment}`)
  return { text: lines.join('\n'), changed: true, line: entry.start + 2 }
}

/**
 * 找到这份 patch 的候选位置，以及每个位置是怎么来的。
 *
 * 返回候选而不是直接读，是为了让「找不到」这件事能被诊断：只报一句「找不到文件」无法区分
 * 「环境变量没设」「profile 目录不存在」与「这个 profile 没装本插件」。
 *
 * @param {object} [env]
 * @param {string} [explicit] - `--file` 给出的路径。
 * @returns {{candidates: string[], notes: string[]}}
 */
export function patchCandidates(env = process.env, explicit) {
  const candidates = []
  const notes = []
  if (typeof explicit === 'string' && explicit !== '') {
    candidates.push(explicit)
    notes.push('--file 指定的路径排在最前')
  }
  const profileDir = env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') {
    candidates.push(join(profileDir, PATCH_FILE))
    notes.push(`DSH_PROFILE_DIR = ${profileDir}`)
  } else {
    notes.push('DSH_PROFILE_DIR 没有设置')
  }
  const home = env.DSH_HOME ?? env.USERPROFILE ?? env.HOME
  const profile = env.DSH_PROFILE
  if (typeof home === 'string' && home !== '' && typeof profile === 'string' && profile !== '') {
    candidates.push(join(home, 'profiles', profile, PATCH_FILE))
    notes.push(`DSH_HOME/DSH_PROFILE = ${home} / ${profile}`)
  } else {
    notes.push('DSH_HOME 与 DSH_PROFILE 至少要有一个没设置')
  }
  if (typeof home === 'string' && home !== '') {
    // 兜底：本机有多个 profile 时，列出它们，好让调用方用 --file 指名一个。
    try {
      const profilesDir = join(home, 'profiles')
      const names = readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      notes.push(`本机 profile：${names.join('、') || '（无）'}`)
    } catch (error) {
      notes.push(`无法列举 profiles 目录：${error?.code ?? error}`)
    }
  }
  return { candidates: [...new Set(candidates)], notes }
}

/**
 * 解析出唯一一个存在的候选。
 *
 * @param {object} [env]
 * @param {string} [explicit]
 * @returns {string}
 * @throws {SwitchError}
 */
export function resolvePatchFile(env = process.env, explicit) {
  const { candidates, notes } = patchCandidates(env, explicit)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found !== undefined) return found
  throw new SwitchError(
    `找不到 ${PATCH_FILE}。${notes.join('；')}。试过的位置：`
    + `${candidates.length === 0 ? '（没有可用候选）' : candidates.join('; ')}`,
    SWITCH_CODES.FILE_MISSING,
    { candidates, notes },
  )
}

/**
 * 把一次开关动作讲成一句人能读的话。
 *
 * @param {string} action - `on` / `off` / `status`。
 * @param {{disabled: boolean, line: number|undefined}} state
 * @param {string} file
 * @returns {string}
 */
function describe(action, state, file) {
  const label = state.disabled ? '关闭（默认）' : '**开启**'
  const where = state.line === undefined ? '（没有 disabled 行，即默认启用）' : `（第 ${state.line} 行）`
  if (action === 'status') {
    return `${PLUGIN_ID} 在 ${file} 里当前是 ${label}${where}。`
  }
  return action === 'on'
    ? `${PLUGIN_ID} 已开启${where}：${file}。HMR 会立刻把它装进正在运行的宿主进程——`
      + '这段时间里**不要改 lib/*.js**，改完实测记得用 `npm run plugin:off` 关回去。'
    : `${PLUGIN_ID} 已关闭${where}：${file}。这是本项目的默认状态：门禁、提示段落与 gac_* 工具`
      + '都不在，那是刻意的，不是故障。'
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @param {object} [io]
 * @returns {number} 退出码。
 */
export function runSwitch(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  const env = io.env ?? process.env
  const args = [...argv]
  let explicit
  const fileFlag = args.findIndex((arg) => arg === '--file')
  if (fileFlag !== -1) {
    explicit = args[fileFlag + 1]
    args.splice(fileFlag, 2)
  }
  const action = args[0] ?? 'status'
  if (!['on', 'off', 'status'].includes(action)) {
    err(`用法：node scripts/plugin-switch.js [status|on|off] [--file <cordis.patch.yml>]`)
    err(`收到的是：${JSON.stringify(action)}`)
    return 1
  }

  let file
  try {
    file = resolvePatchFile(env, explicit)
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 1
  }

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    err(`读不出来 ${file}：${error?.code ?? error}`)
    return 1
  }

  try {
    if (action === 'status') {
      out(describe('status', readPluginState(text), file))
      return 0
    }
    const result = setPluginDisabled(text, action === 'off')
    if (result.changed) writeFileSync(file, result.text, 'utf8')
    out(describe(action, readPluginState(result.text), file))
    if (!result.changed) out('（原本就是这个状态，文件未改动。）')
    return 0
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

// 只有被当作脚本直接运行时才走 CLI：被测试 import 时不该有副作用。
if (process.argv[1] !== undefined && process.argv[1].replace(/\\/gu, '/').endsWith('/scripts/plugin-switch.js')) {
  process.exitCode = runSwitch(process.argv.slice(2))
}
