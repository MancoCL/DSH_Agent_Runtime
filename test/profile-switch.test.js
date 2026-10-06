/**
 * profile 切换脚本：只动一个键、先备份、默认干跑、宿主活着时拒绝。
 *
 * 这个脚本改的是**用户的应用设置**（`%APPDATA%\dsh-tauri\.store.dat`），所以它的每一条保命性质
 * 都要有测试钉着：改动范围只有一个键、写之前先备份、不写的时候真的什么都没写、宿主还活着时拒绝
 * （那种情况下应用退出会覆写，改与没改在表面上一样）。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  PROFILE_SWITCH_CODES,
  ProfileSwitchError,
  inspectProfile,
  latestBackup,
  readActiveProfile,
  runProfileSwitch,
  setActiveProfile,
} from '../scripts/profile-switch.js'

const roots = []

/**
 * 一个临时目录（测试结束清理）。
 *
 * @returns {string}
 */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'gac-profile-switch-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结果。
    }
  }
})

/** 一份形状与真实设置文件一致的样本。 */
const STORE = JSON.stringify({
  setting: { active_profile: 'core-020', port: 3080, language: 'zh' },
  window_state: { width: 1920 },
}, null, 2)

/**
 * 造一个假的 DSH_HOME（含若干 profile 与一个 pid 文件）。
 *
 * @param {object} [options]
 * @param {number} [options.pid] - 写进 `.harness.pid` 的进程号。
 * @returns {{env: object, home: string}}
 */
function fakeHome({ pid } = {}) {
  const home = scratch()
  for (const name of ['core-020', 'gac-verify']) {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `{"name":"${name}"}\n`)
  }
  if (pid !== undefined) writeFileSync(join(home, '.harness.pid'), `${pid}\n`)
  return { env: { DSH_HOME: home, APPDATA: join(home, 'appdata') }, home }
}

/**
 * 造一个设置文件。
 *
 * @param {string} text
 * @returns {string}
 */
function storeFile(text = STORE) {
  const dir = join(scratch(), 'dsh-tauri')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/.store.dat`, text)
  return `${dir}/.store.dat`
}

/**
 * 收集日志行。
 *
 * @returns {{lines: string[], log: (line: string) => void}}
 */
function collector() {
  const lines = []
  return { lines, log: (line) => lines.push(line) }
}

describe('读与写：只动一个键', () => {
  it('读出当前的 profile', () => {
    assert.equal(readActiveProfile(STORE).profile, 'core-020')
  })

  it('不是合法 JSON 时报带码的错，而不是猜一个值', () => {
    assert.throws(
      () => readActiveProfile('{ 坏的'),
      (error) => error instanceof ProfileSwitchError && error.code === PROFILE_SWITCH_CODES.STORE_MALFORMED,
    )
  })

  it('改写只动 active_profile，其余键原样保留', () => {
    const after = JSON.parse(setActiveProfile(STORE, 'gac-verify'))
    assert.equal(after.setting.active_profile, 'gac-verify')
    assert.equal(after.setting.port, 3080)
    assert.equal(after.setting.language, 'zh')
    assert.equal(after.window_state.width, 1920)
  })

  it('没有 setting 对象时拒绝改写 —— 那不是本脚本认识的形状', () => {
    assert.throws(
      () => setActiveProfile('{"other":1}', 'gac-verify'),
      (error) => error instanceof ProfileSwitchError && error.code === PROFILE_SWITCH_CODES.STORE_MALFORMED,
    )
  })
})

describe('目标 profile 的校验：拼错的名字要在写之前被拒', () => {
  it('目录里有 package.json 才算存在', () => {
    const { env } = fakeHome()
    assert.equal(inspectProfile('gac-verify', env).exists, true)
    assert.equal(inspectProfile('no-such', env).exists, false)
  })
})

describe('命令行为', () => {
  it('status 只读，报告当前 profile、宿主状态与可用 profile', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const { lines, log } = collector()

    const code = runProfileSwitch(['status', '--file', file], { log, env })

    assert.equal(code, 0)
    assert.equal(lines.some((line) => line.includes('当前 profile：core-020')), true)
    assert.equal(lines.some((line) => line.includes('可用的 profile：core-020、gac-verify')), true)
  })

  it('use 默认干跑：一个字节都不写', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const before = readFileSync(file, 'utf8')
    const { lines, log } = collector()

    const code = runProfileSwitch(['use', 'gac-verify', '--file', file], { log, env })

    assert.equal(code, 0)
    assert.equal(readFileSync(file, 'utf8'), before, '干跑不该写文件')
    assert.equal(lines.some((line) => line.includes('干跑')), true)
  })

  it('use --apply 写入并留下备份', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const { lines, log } = collector()

    const code = runProfileSwitch(['use', 'gac-verify', '--apply', '--file', file], { log, env })

    assert.equal(code, 0)
    assert.equal(readActiveProfile(readFileSync(file, 'utf8')).profile, 'gac-verify')
    const backup = latestBackup(file)
    assert.notEqual(backup, undefined)
    assert.equal(readActiveProfile(readFileSync(backup, 'utf8')).profile, 'core-020', '备份里是原值')
    assert.equal(lines.some((line) => line.includes('已切换')), true)
  })

  it('已经是目标 profile 时什么都不做（幂等）', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile(JSON.stringify({ setting: { active_profile: 'gac-verify' } }, null, 2))
    const { lines, log } = collector()

    const code = runProfileSwitch(['use', 'gac-verify', '--apply', '--file', file], { log, env })

    assert.equal(code, 0)
    assert.equal(lines.some((line) => line.includes('什么都没改')), true)
    assert.equal(latestBackup(file), undefined, '没改就不该产生备份')
  })

  it('目标 profile 不存在时拒绝（写下去会让应用下次启动找不到 profile）', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const before = readFileSync(file, 'utf8')
    const { lines, log } = collector()

    const code = runProfileSwitch(['use', 'no-such', '--apply', '--file', file], { log, env })

    assert.equal(code, 1)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(lines.some((line) => line.includes('不存在')), true)
  })

  it('宿主还活着时拒绝 —— 那时改了会被应用退出覆写，等于没改', () => {
    const { env } = fakeHome({ pid: process.pid })
    const file = storeFile()
    const before = readFileSync(file, 'utf8')
    const { lines, log } = collector()

    const code = runProfileSwitch(['use', 'gac-verify', '--apply', '--file', file], { log, env })

    assert.equal(code, 1)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(lines.some((line) => line.includes('宿主进程还在')), true)
  })

  it('--force 时放行，但把风险说清楚', () => {
    const { env } = fakeHome({ pid: process.pid })
    const file = storeFile()
    const { log } = collector()

    const code = runProfileSwitch(['use', 'gac-verify', '--apply', '--force', '--file', file], { log, env })

    assert.equal(code, 0)
    assert.equal(readActiveProfile(readFileSync(file, 'utf8')).profile, 'gac-verify')
  })

  it('restore 从最近一份备份回滚', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const { log } = collector()
    runProfileSwitch(['use', 'gac-verify', '--apply', '--file', file], { log, env })

    const code = runProfileSwitch(['restore', '--apply', '--file', file], { log, env })

    assert.equal(code, 0)
    assert.equal(readActiveProfile(readFileSync(file, 'utf8')).profile, 'core-020')
  })

  it('没有备份时 restore 明确报错', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const { log } = collector()

    const code = runProfileSwitch(['restore', '--apply', '--file', file], { log, env })

    assert.equal(code, 1)
  })

  it('未知命令给出用法，而不是静默成功', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const { lines, log } = collector()

    const code = runProfileSwitch(['frobnicate', '--file', file], { log, env })

    assert.equal(code, 1)
    assert.equal(lines.some((line) => line.includes('可用：status / use / restore')), true)
  })

  it('找不到设置文件时把试过的路径都列出来', () => {
    const env = { DSH_HOME: scratch(), APPDATA: join(scratch(), 'nowhere') }
    const { lines, log } = collector()

    const code = runProfileSwitch(['status'], { log, env })

    assert.equal(code, 1)
    assert.equal(lines.some((line) => line.includes('找不到桌面应用的设置文件')), true)
    assert.equal(existsSync(join(env.APPDATA, 'dsh-tauri/.store.dat')), false)
  })
})

describe('备份的发现', () => {
  it('按名字排序取最新的一份', () => {
    const { env } = fakeHome({ pid: 999999 })
    const file = storeFile()
    const dir = file.replace(/[\\/][^\\/]+$/u, '')
    writeFileSync(`${dir}/.store.dat.bak-2026-01-01T00-00-00-000Z`, STORE)
    writeFileSync(`${dir}/.store.dat.bak-2026-06-01T00-00-00-000Z`, STORE)

    const newest = latestBackup(file)

    assert.equal(newest.endsWith('2026-06-01T00-00-00-000Z'), true)
    assert.equal(readdirSync(dir).filter((name) => name.includes('.bak-')).length, 2)
    assert.equal(env.DSH_HOME.length > 0, true)
  })
})
