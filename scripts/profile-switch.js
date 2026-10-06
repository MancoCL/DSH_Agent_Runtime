/**
 * 切换桌面应用使用的 DSH profile。
 *
 * @module dsh-gac-runtime/scripts/profile-switch
 *
 * 为什么需要它
 * ------------
 * 桌面应用把「用哪个 profile」存在自己的设置文件里（`%APPDATA%\dsh-tauri\.store.dat` 的
 * `setting.active_profile`），启动时按它拉起 `dsh web`。也就是说：**切换 profile = 改那个键 +
 * 重启应用**，没有别的入口（应用界面里有没有选择器取决于它的版本，而命令行 `dsh <名字>` 起的是
 * 另一个宿主，不是切当前这个）。
 *
 * 为什么必须「应用已退出」才动它
 * --------------------------
 * 那个文件是应用**在内存里持有、退出时回写**的。应用还开着的时候改，退出时会被覆写成原值——
 * 于是「我改了」与「根本没改」在表面上完全一样。所以本脚本默认**拒绝**在宿主进程还活着时动手，
 * 除非显式 `--force`（那时它至少会把这一点说清楚）。
 *
 * 三条保命性质
 * ------------
 *  1. **先备份再写**（`<store>.bak-<时间戳>`），并支持 `restore` 回滚到最近一份备份。
 *  2. **先校验目标 profile 真的存在**（`$DSH_HOME/profiles/<名字>/package.json`）——写一个拼错的
 *     名字会让应用下次启动时找不到 profile，而那时的表现是「应用起不来」，不是「设置错了」。
 *  3. **默认干跑**：`use` 要带 `--apply` 才真的写。改用户的应用设置这种事，不该一条命令就发生。
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 设置文件在 Windows 上的相对位置（`%APPDATA%` 之下）。 */
const STORE_RELATIVE_PATH = 'dsh-tauri/.store.dat'

/** 结构化错误码。 */
export const PROFILE_SWITCH_CODES = Object.freeze({
  STORE_NOT_FOUND: 'GAC_STORE_NOT_FOUND',
  STORE_MALFORMED: 'GAC_STORE_MALFORMED',
  PROFILE_MISSING: 'GAC_PROFILE_MISSING',
  APP_RUNNING: 'GAC_APP_STILL_RUNNING',
  NOTHING_TO_RESTORE: 'GAC_NOTHING_TO_RESTORE',
})

/** 切换失败。 */
export class ProfileSwitchError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'ProfileSwitchError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 拼接路径片段，保留第一段的分隔符风格。
 *
 * @param {...string} parts
 * @returns {string}
 */
function join2(...parts) {
  const [first, ...rest] = parts
  const separator = first.includes('\\') ? '\\' : '/'
  return [first.replace(/[\\/]+$/u, ''), ...rest.map((p) => p.replace(/^[\\/]+|[\\/]+$/gu, ''))]
    .filter((part) => part !== '')
    .join(separator)
}

/**
 * 设置文件的候选位置。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [explicit]
 * @returns {string[]}
 */
export function storeCandidates(env = process.env, explicit) {
  const candidates = []
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  const configured = env.DSH_TAURI_STORE
  if (typeof configured === 'string' && configured !== '') candidates.push(configured)
  const appData = env.APPDATA
  if (typeof appData === 'string' && appData !== '') candidates.push(join2(appData, STORE_RELATIVE_PATH))
  const home = env.USERPROFILE ?? env.HOME
  if (typeof home === 'string' && home !== '') {
    candidates.push(join2(home, 'AppData', 'Roaming', STORE_RELATIVE_PATH))
  }
  return [...new Set(candidates)]
}

/**
 * 找出实际存在的设置文件。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [explicit]
 * @returns {string}
 * @throws {ProfileSwitchError}
 */
export function resolveStoreFile(env = process.env, explicit) {
  const candidates = storeCandidates(env, explicit)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new ProfileSwitchError(
    `找不到桌面应用的设置文件。试过：${candidates.join('；') || '（没有任何候选路径）'}`,
    PROFILE_SWITCH_CODES.STORE_NOT_FOUND,
    { candidates },
  )
}

/**
 * 读出设置文件里的当前 profile。
 *
 * @param {string} text
 * @returns {{profile: string|undefined, store: object}}
 * @throws {ProfileSwitchError}
 */
export function readActiveProfile(text) {
  let store
  try {
    store = JSON.parse(text)
  } catch (error) {
    throw new ProfileSwitchError(
      `设置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      PROFILE_SWITCH_CODES.STORE_MALFORMED,
    )
  }
  const profile = store?.setting?.active_profile
  return { profile: typeof profile === 'string' ? profile : undefined, store }
}

/**
 * 把设置文件里的 profile 换成另一个（纯变换，不碰磁盘）。
 *
 * 只动 `setting.active_profile` 一个键：这是用户的应用设置，其余键原样保留。
 *
 * @param {string} text
 * @param {string} profile
 * @returns {string} 新的文件文本。
 * @throws {ProfileSwitchError}
 */
export function setActiveProfile(text, profile) {
  const { store } = readActiveProfile(text)
  if (store.setting === null || typeof store.setting !== 'object' || Array.isArray(store.setting)) {
    throw new ProfileSwitchError(
      '设置文件里没有 "setting" 对象——这不是本脚本认识的形状，拒绝改写',
      PROFILE_SWITCH_CODES.STORE_MALFORMED,
    )
  }
  store.setting.active_profile = profile
  return `${JSON.stringify(store, null, 2)}\n`
}

/**
 * 目标 profile 是否真的存在。
 *
 * 判据是「目录里有 `package.json`」：那是 profile 的定义文件（树由它的 bundles 与 patch 组合）。
 * 只检查目录存在不够——一个空目录会让应用下次启动时找不到 profile。
 *
 * @param {string} profile
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{exists: boolean, dir: string}}
 */
export function inspectProfile(profile, env = process.env) {
  const home = env.DSH_HOME ?? (env.USERPROFILE === undefined ? undefined : join2(env.USERPROFILE, '.dsh'))
  const dir = home === undefined ? undefined : join2(home, 'profiles', profile)
  return {
    exists: dir !== undefined && existsSync(join2(dir, 'package.json')),
    dir: dir ?? '(DSH_HOME 未知)',
  }
}

/**
 * 宿主进程是否还活着。
 *
 * `$DSH_HOME/.harness.pid` 是宿主自己写的。它活着就意味着应用也活着——而那时改设置文件会被
 * 应用退出时覆写，于是「改了」与「没改」看起来一模一样。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{running: boolean, pid?: number}}
 */
export function harnessRunning(env = process.env) {
  const home = env.DSH_HOME ?? (env.USERPROFILE === undefined ? undefined : join2(env.USERPROFILE, '.dsh'))
  if (home === undefined) return { running: false }
  const path = join2(home, '.harness.pid')
  if (!existsSync(path)) return { running: false }
  let pid
  try {
    pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
  } catch {
    return { running: false }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { running: false }
  try {
    process.kill(pid, 0)
    return { running: true, pid }
  } catch {
    // 进程不存在（或没有权限看它）——两种情况都按「不阻塞」处理：真正的证据是应用会不会覆写，
    // 而这里只是尽力提醒。
    return { running: false }
  }
}

/**
 * 找最近的备份。
 *
 * @param {string} storeFile
 * @returns {string|undefined}
 */
export function latestBackup(storeFile) {
  const dir = storeFile.replace(/[\\/][^\\/]+$/u, '')
  const base = storeFile.replace(/.*[\\/]/u, '')
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const backups = names
    .filter((name) => name.startsWith(`${base}.bak-`))
    .sort()
  const newest = backups.at(-1)
  return newest === undefined ? undefined : join2(dir, newest)
}

/**
 * 命令实现。返回退出码，便于单测。
 *
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @param {object} [io]
 * @param {(line: string) => void} [io.log]
 * @param {NodeJS.ProcessEnv} [io.env]
 * @param {() => number} [io.now]
 * @returns {number}
 */
export function runProfileSwitch(argv, io = {}) {
  const log = io.log ?? ((line) => process.stdout.write(`${line}\n`))
  const env = io.env ?? process.env
  const now = io.now ?? (() => Date.now())
  const [command = 'status', ...rest] = argv
  const apply = rest.includes('--apply')
  const force = rest.includes('--force')
  const explicitIndex = rest.indexOf('--file')
  const explicit = explicitIndex === -1 ? undefined : rest[explicitIndex + 1]
  const positional = rest.filter((entry, index) => !entry.startsWith('--')
    && rest[index - 1] !== '--file')

  const guard = () => {
    const harness = harnessRunning(env)
    if (harness.running && !force) {
      throw new ProfileSwitchError(
        `宿主进程还在（pid ${harness.pid}）——应用退出时会覆写这个文件，所以现在改等于没改。`
          + '请先**退出应用**（不是关窗口：close_action 是 tray），再跑这条命令；'
          + '确实要在它活着时改，就加 --force。',
        PROFILE_SWITCH_CODES.APP_RUNNING,
        { pid: harness.pid },
      )
    }
  }

  try {
    const storeFile = resolveStoreFile(env, explicit)

    if (command === 'status') {
      const { profile } = readActiveProfile(readFileSync(storeFile, 'utf8'))
      const harness = harnessRunning(env)
      const target = profile === undefined ? undefined : inspectProfile(profile, env)
      log(`设置文件：${storeFile}`)
      log(`当前 profile：${profile ?? '(未设置)'}${target === undefined ? '' : `（${target.exists ? '存在' : `不存在：${target.dir}`}）`}`)
      log(`宿主进程：${harness.running ? `还在（pid ${harness.pid}）` : '不在'}`)
      const names = readdirSync(join2(env.DSH_HOME ?? '', 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        // 只列**真的是 profile** 的目录：判据与 `inspectProfile` 一致（有 `package.json`）。
        // 否则 `profiles/node_modules` 也会被列成一个「可用的 profile」——那会让人以为选它有意义。
        .filter((entry) => existsSync(join2(env.DSH_HOME ?? '', 'profiles', entry.name, 'package.json')))
        .map((entry) => entry.name)
      log(`可用的 profile：${names.join('、') || '(无)'}`)
      return 0
    }

    if (command === 'use') {
      const profile = positional[0]
      if (typeof profile !== 'string' || profile === '') {
        throw new ProfileSwitchError('用法：profile-switch.js use <profile> [--apply] [--force]', 'GAC_USAGE')
      }
      const target = inspectProfile(profile, env)
      if (!target.exists) {
        throw new ProfileSwitchError(
          `profile "${profile}" 不存在（找的是 ${target.dir}/package.json）——`
            + '写一个不存在的名字会让应用下次启动时找不到 profile',
          PROFILE_SWITCH_CODES.PROFILE_MISSING,
          { dir: target.dir },
        )
      }
      guard()
      const before = readFileSync(storeFile, 'utf8')
      const { profile: current } = readActiveProfile(before)
      if (current === profile) {
        log(`已经是 ${profile} 了，什么都没改。`)
        return 0
      }
      const after = setActiveProfile(before, profile)
      if (!apply) {
        log(`干跑：${current ?? '(未设置)'} → ${profile}（未写入）`)
        log('要真的写，加 --apply。')
        return 0
      }
      const backup = `${storeFile}.bak-${new Date(now()).toISOString().replace(/[:.]/gu, '-')}`
      copyFileSync(storeFile, backup)
      writeFileSync(storeFile, after, 'utf8')
      log(`已切换：${current ?? '(未设置)'} → ${profile}`)
      log(`备份：${backup}`)
      log('下一步：启动应用。')
      return 0
    }

    if (command === 'restore') {
      const backup = latestBackup(storeFile)
      if (backup === undefined) {
        throw new ProfileSwitchError('没有可用的备份', PROFILE_SWITCH_CODES.NOTHING_TO_RESTORE)
      }
      guard()
      const { profile } = readActiveProfile(readFileSync(backup, 'utf8'))
      if (!apply) {
        log(`干跑：从 ${backup} 恢复（其中的 profile 是 ${profile ?? '(未设置)'}），未写入。`)
        return 0
      }
      copyFileSync(backup, storeFile)
      log(`已恢复自 ${backup}（profile = ${profile ?? '(未设置)'}）`)
      return 0
    }

    throw new ProfileSwitchError(`未知命令 "${command}"；可用：status / use / restore`, 'GAC_USAGE')
  } catch (error) {
    if (error instanceof ProfileSwitchError) {
      log(`错误：${error.message}`)
      return 1
    }
    throw error
  }
}

if (process.argv[1] !== undefined && process.argv[1].replace(/\\/gu, '/').endsWith('/scripts/profile-switch.js')) {
  process.exitCode = runProfileSwitch(process.argv.slice(2))
}
