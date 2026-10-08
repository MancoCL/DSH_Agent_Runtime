/**
 * 本地 GAC 插件两阶段验收与发布。
 *
 * 日常必须安装不可变的本地 tarball；只有显式开始源码验收，才能暂时将 profile 链向工作树。
 * 不改变 Host Session Log、不触碰非目标 Profile；运行中的 DSH 不允许修改插件依赖。
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const DEFAULT_ROOT = resolve(dirname(SELF), '..')
export const PACKAGE_NAME = 'dsh-gac-runtime'

export class DeployError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DeployError'
    this.code = code
  }
}

const fail = (code, message) => { throw new DeployError(code, message) }
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const normalized = (path) => resolve(path).replace(/\\/gu, '/')
const packageSpec = (path) => 'file:' + normalized(path)
const linkSpec = (path) => 'link:' + normalized(path)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')

export function dependencyOf(profile) {
  const pkg = readJson(join(profile, 'package.json'))
  if (!pkg.dependencies || typeof pkg.dependencies[PACKAGE_NAME] !== 'string'
    || !pkg.dsh?.profile?.bundles?.includes(PACKAGE_NAME)) {
    fail('GAC_DEPLOY_NOT_INSTALLED', '目标 Profile 尚未完整注册 GAC Bundle，拒绝修改')
  }
  return pkg.dependencies[PACKAGE_NAME]
}

export function replaceDependency(profile, dependency) {
  const file = join(profile, 'package.json')
  const pkg = readJson(file)
  dependencyOf(profile)
  pkg.dependencies[PACKAGE_NAME] = dependency
  writeJson(file, pkg)
}

/** 只读取本插件在 pnpm lock 的 specifier，不解析或改写其他依赖。 */
export function lockSpecifier(profile) {
  const lock = join(profile, 'pnpm-lock.yaml')
  if (!existsSync(lock)) return undefined
  const match = /^ {6}dsh-gac-runtime:\r?\n {8}specifier: ([^\r\n]+)/mu.exec(readFileSync(lock, 'utf8'))
  return match?.[1]?.trim()
}

function actualPath(profile) {
  try {
    return realpathSync(join(profile, 'node_modules', PACKAGE_NAME))
  } catch {
    return undefined
  }
}

export function inspectDeployment({ profile, root, stateFile }) {
  const spec = dependencyOf(profile)
  const lockSpec = lockSpecifier(profile)
  const actual = actualPath(profile)
  const state = existsSync(stateFile) ? readJson(stateFile) : undefined
  const isSource = actual !== undefined && samePath(actual, root)
  return { spec, lockSpec, actual, isSource, state }
}

function runningPids(dshHome) {
  const file = join(dshHome, '.harness.pid')
  if (!existsSync(file)) return []
  const candidates = readFileSync(file, 'utf8').split(/\s+/u)
    .map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0)
  return candidates.filter((pid) => {
    try { process.kill(pid, 0); return true } catch (error) {
      // EPERM 不代表进程已退出。
      return error?.code === 'EPERM'
    }
  })
}

function assertStopped(dshHome, processChecker) {
  const pids = processChecker(dshHome)
  if (pids.length) {
    fail('GAC_DEPLOY_HOST_RUNNING',
      'DSH 仍在运行（PID ' + pids.join(', ') + '）。请完全退出宿主后再执行切换；本命令不提供 --force。')
  }
}

function defaultCommand(command, cwd) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function checkSource(root, exec) {
  const diff = exec('git status --porcelain --untracked-files=normal', root).trim()
  if (diff) fail('GAC_DEPLOY_DIRTY', '源码有未提交的修改；先提交并通过回归，再验收当前版本')
  const commit = exec('git rev-parse HEAD', root).trim()
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail('GAC_DEPLOY_GIT', '无法取得当前 Git HEAD')
  exec('npm test', root)
  return commit
}

function reify(profile, exec) {
  // 使用包管理器统一更新 lockfile 与 node_modules，禁止手动创建 Junction 造成三处来源漂移。
  exec('pnpm install --offline --ignore-scripts --no-frozen-lockfile', profile)
}

function switchTo(profile, spec, expectedPath, exec, root, expectedFiles = []) {
  const before = dependencyOf(profile)
  replaceDependency(profile, spec)
  try {
    reify(profile, exec)
    const locked = lockSpecifier(profile)
    if (locked !== undefined && locked !== spec) {
      fail('GAC_DEPLOY_LOCK_MISMATCH', 'pnpm 安装后锁文件仍未与 Profile 依赖对齐：' + String(locked))
    }
    const actual = actualPath(profile)
    if (!actual || (expectedPath && !samePath(actual, expectedPath))
      || (!expectedPath && samePath(actual, root))) {
      fail('GAC_DEPLOY_TARGET_MISMATCH',
        '依赖已更新但真实 node_modules 落点不符合目标；拒绝报告成功：' + String(actual))
    }
    // 本地包发布除了检查路径，还要逐文件验证包管理器实际安装的字节。
    if (!expectedPath && spec.startsWith('file:')) {
      const modules = resolve(profile, 'node_modules').toLowerCase()
      const destination = resolve(actual).toLowerCase()
      if (!destination.startsWith(modules + '\\') && !destination.startsWith(modules + '/')) {
        fail('GAC_DEPLOY_UNPACKED_PATH', '本地包实际落点仍在 Profile 目录以外：' + actual)
      }
    }
    for (const file of expectedFiles) {
      const source = join(root, file)
      const installed = join(actual, file)
      if (!existsSync(source) || !existsSync(installed)
        || !readFileSync(source).equals(readFileSync(installed))) {
        fail('GAC_DEPLOY_INSTALLED_BYTES_MISMATCH', '实际安装的插件内容与验收源码不一致：' + file)
      }
    }
  } catch (cause) {
    // 尽力还原依赖并重新安装，不能只改回 package.json 却把工作树 Junction 留在盘上。
    replaceDependency(profile, before)
    try {
      reify(profile, exec)
      if (before !== linkSpec(root) && samePath(actualPath(profile) ?? root, root)) {
        fail('GAC_DEPLOY_ROLLBACK_SOURCE', '恢复安装后仍指向工作树')
      }
    } catch (rollbackError) {
      fail('GAC_DEPLOY_ROLLBACK_FAILED',
        '切换失败，且包管理器回滚也失败；请保持 DSH 关闭并检查 Profile：'
        + String(cause) + '; rollback=' + String(rollbackError))
    }
    throw cause
  }
}

function readState(file) {
  if (!existsSync(file)) fail('GAC_DEPLOY_NO_VALIDATION', '未进入源码验收阶段，不能发布或恢复')
  const state = readJson(file)
  if (state?.mode !== 'validation') fail('GAC_DEPLOY_STATE', '非法验收状态')
  return state
}

function optionsOf(argv) {
  const value = (name) => {
    const pos = argv.indexOf(name)
    return pos < 0 ? undefined : argv[pos + 1]
  }
  return {
    apply: argv.includes('--apply'),
    confirmVerify: argv.includes('--confirm-verify'),
    confirmedPass: argv.includes('--confirmed-pass'),
    evidence: value('--evidence'),
  }
}

/**
 * @param {string[]} argv CLI 参数
 * @param {object} [opts] 测试时可以注入隔离 Profile 与命令执行器
 */
export function runDeployment(argv, opts = {}) {
  const env = opts.env ?? process.env
  const root = resolve(opts.root ?? DEFAULT_ROOT)
  const profileArg = opts.profile ?? env.DSH_PROFILE_DIR
  if (!profileArg || !isAbsolute(profileArg)) {
    fail('GAC_DEPLOY_PROFILE_REQUIRED', '必须显式设置绝对路径 DSH_PROFILE_DIR，避免误改其他 Profile')
  }
  const profile = resolve(profileArg)
  const dshHome = resolve(opts.dshHome ?? env.DSH_HOME ?? join(profile, '..', '..'))
  const stateDir = join(dshHome, 'gac-runtime-releases', basename(profile))
  const stateFile = join(stateDir, 'validation.json')
  const exec = opts.command ?? defaultCommand
  const processChecker = opts.processChecker ?? runningPids
  const command = argv[0] ?? 'status'
  const flags = optionsOf(argv)
  const log = opts.log ?? console.log

  if (command === 'status') {
    const state = inspectDeployment({ profile, root, stateFile })
    log('Profile: ' + profile)
    log('package.json: ' + state.spec)
    log('pnpm-lock.yaml: ' + (state.lockSpec ?? '(not found)'))
    log('node_modules actual: ' + (state.actual ?? '(missing)'))
    if (state.lockSpec && state.lockSpec !== state.spec) log('WARNING: 依赖声明与 pnpm 锁文件不一致')
    log('mode: ' + (state.state ? 'VALIDATION' : 'NORMAL'))
    log('DSH running PIDs: ' + processChecker(dshHome).join(','))
    if (state.isSource) log('WARNING: 日常实际加载路径仍指向开发工作树；必须在退出宿主后完成隔离修复')
    if (state.actual && state.spec.startsWith('file:')) {
      const modules = resolve(profile, 'node_modules').toLowerCase()
      const actual = resolve(state.actual).toLowerCase()
      if (!actual.startsWith(modules + '\\') && !actual.startsWith(modules + '/')) {
        log('WARNING: 虽声明 file tarball，但实际加载目录不在 Profile node_modules 内')
      }
    }
    if (!state.state && !state.spec.startsWith('file:')) {
      log('WARNING: 日常配置不是不可变的本地安装包')
    }
    if (state.state) log('Validated source revision: ' + state.state.commit)
    return { command, ...state }
  }

  if (!['validate', 'publish', 'restore'].includes(command)) {
    fail('GAC_DEPLOY_USAGE', '用法：status | validate --apply --confirm-verify | publish --apply --confirmed-pass --evidence ID | restore --apply')
  }
  if (!flags.apply) {
    log('DRY RUN: ' + command + ' 不会更改 Profile；实际执行需要 --apply。')
    return { command, applied: false }
  }

  assertStopped(dshHome, processChecker)
  if (command === 'validate') {
    if (!flags.confirmVerify) {
      fail('GAC_DEPLOY_CONFIRM_REQUIRED', '必须明确指定 --confirm-verify 才能临时切换到源码')
    }
    if (existsSync(stateFile)) fail('GAC_DEPLOY_ALREADY_VALIDATING', '已有未结束的验收，先 publish 或 restore')
    const commit = checkSource(root, exec)
    const previousSpec = dependencyOf(profile)
    if (previousSpec === linkSpec(root)) fail('GAC_DEPLOY_SOURCE_SPEC', '当前已将源码声明为日常依赖，需先恢复本地包')
    mkdirSync(stateDir, { recursive: true })
    const state = { mode: 'validation', commit, previousSpec, profile, root,
      startedAt: new Date().toISOString() }
    // 先存恢复锚点；安装失败后依然能够恢复，而不是丢失原目标。
    writeJson(stateFile, state)
    try { switchTo(profile, linkSpec(root), root, exec, root) }
    catch (error) { throw error }
    log('SOURCE VALIDATION ACTIVE: ' + commit)
    log('请启动 DSH 做真实 E2E；期间禁止编辑当前工作树。通过后退出宿主，用 publish 显式发布。')
    return { command, applied: true, commit }
  }

  const state = readState(stateFile)
  if (!samePath(state.profile, profile) || !samePath(state.root, root)) {
    fail('GAC_DEPLOY_STATE_MISMATCH', '验收记录不属于当前 Profile 或当前工作树')
  }
  if (command === 'restore') {
    switchTo(profile, state.previousSpec, undefined, exec, root)
    rmSync(stateFile)
    log('已恢复验收前插件依赖，源码不再作为日常加载源。')
    return { command, applied: true }
  }

  if (!flags.confirmedPass || !flags.evidence || flags.evidence.startsWith('--')) {
    fail('GAC_DEPLOY_NOT_APPROVED',
      '发布必须显式提供 --confirmed-pass --evidence <真实验收记录号>，不能用单测冒充活体验收')
  }
  const commit = checkSource(root, exec)
  if (commit !== state.commit) {
    fail('GAC_DEPLOY_REVISION_CHANGED', '源码在验收后发生变更，必须重新进入源码验收阶段')
  }
  const source = inspectDeployment({ profile, root, stateFile })
  if (!source.isSource || source.spec !== linkSpec(root)) {
    fail('GAC_DEPLOY_NOT_SOURCE', '当前 Profile 未实际加载待验收工作树，不能发布为已验版本')
  }

  const packages = join(dshHome, 'packages')
  mkdirSync(packages, { recursive: true })
  // 固定 npm pack 默认文件名仅落在隔离临时目录，绝不覆盖旧的已验收安装包。
  const staging = mkdtempSync(join(packages, 'gac-pack-'))
  const meta = JSON.parse(exec('npm pack --ignore-scripts --json --pack-destination "' + staging + '"', root))[0]
  const required = ['lib/index.js', 'cordis.patch.yml', 'assets/ENGINEERING_POLICY.md']
  const included = new Set(meta.files.map((file) => file.path))
  if (required.some((f) => !included.has(f))) {
    fail('GAC_DEPLOY_PACKAGE_INCOMPLETE', '打包结果缺少 Runtime 入口、配置或工程质量资源')
  }
  const packed = join(staging, meta.filename)
  const target = join(packages, PACKAGE_NAME + '-' + meta.version + '-' + commit.slice(0, 12) + '.tgz')
  if (existsSync(target)) {
    fail('GAC_DEPLOY_RELEASE_EXISTS', '目标不可变本地包已存在，拒绝覆盖：' + target)
  }
  renameSync(packed, target)
  rmSync(staging, { recursive: true, force: true })
  const checksum = createHash('sha256').update(readFileSync(target)).digest('hex')
  const manifest = { package: PACKAGE_NAME, version: meta.version, gitCommit: commit,
    sha256: checksum, evidence: flags.evidence, file: target, createdAt: new Date().toISOString() }
  const manifestPath = target + '.json'
  writeJson(manifestPath, manifest)
  try {
    switchTo(profile, packageSpec(target), undefined, exec, root, meta.files.map((file) => file.path))
  } catch (error) {
    log('本地包已创建，但 Profile 安装失败。验收状态保留，请保持 DSH 关闭后处理：' + String(error))
    throw error
  }
  rmSync(stateFile)
  log('RELEASE INSTALLED: ' + target)
  log('SHA256: ' + checksum)
  log('当前 Profile 已脱离工作树；重启 DSH 后核实 plugin-loaded 和实际代码版本。')
  return { command, applied: true, manifest }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    runDeployment(process.argv.slice(2))
  } catch (error) {
    console.error((error?.code ?? 'GAC_DEPLOY_ERROR') + ': ' + (error?.message ?? String(error)))
    process.exitCode = 1
  }
}
