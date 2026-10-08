/**
 * 本地包隔离：只验证模拟 Profile，不修改 DSH 真实安装。
 */
import assert from 'node:assert/strict'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DeployError, inspectDeployment, runDeployment } from '../scripts/plugin-deploy.js'
import { runSwitch } from '../scripts/plugin-switch.js'

const dirs = []
const sha = 'abcdef1234567890abcdef1234567890abcdef12'
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'gac-deploy-'))
  dirs.push(base)
  const root = join(base, 'source')
  const dshHome = join(base, '.dsh')
  const profile = join(dshHome, 'profiles', 'core-test')
  const modulePath = join(profile, 'node_modules', 'dsh-gac-runtime')
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'lib', 'index.js'), 'export const version = 1\n')
  writeFileSync(join(root, 'assets', 'ENGINEERING_POLICY.md'), 'policy')
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: gac-runtime\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-gac-runtime', version: '0.1.0' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-gac-runtime': 'file:old-release.tgz', another: '^1.0.0' },
    dsh: { profile: { bundles: ['dsh-gac-runtime', 'another'] } },
  }, null, 2))
  writeFileSync(join(profile, 'pnpm-lock.yaml'),
    'importers:\\n  .:\\n    dependencies:\\n      dsh-gac-runtime:\\n        specifier: file:old-release.tgz\\n')
  // 刻意模拟本机遇到的漂移：package.json 写 tarball，但真实 node_modules 仍指向源码。
  symlinkSync(root, modulePath, 'junction')

  const calls = []
  const lines = []
  const runner = (cmd, cwd) => {
    calls.push([cmd, cwd])
    if (cmd.startsWith('git status')) return ''
    if (cmd.startsWith('git rev-parse')) return sha + '\n'
    if (cmd === 'npm test') return 'test PASS'
    if (cmd.startsWith('npm pack')) {
      const destination = /--pack-destination "([^"]+)"/u.exec(cmd)?.[1]
      assert.ok(destination, '打包必须使用独立 staging 目录')
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'dsh-gac-runtime-0.1.0.tgz'), 'fake-archive')
      return JSON.stringify([{
        filename: 'dsh-gac-runtime-0.1.0.tgz', version: '0.1.0',
        files: [{ path: 'lib/index.js' }, { path: 'assets/ENGINEERING_POLICY.md' },
          { path: 'cordis.patch.yml' }],
      }])
    }
    if (cmd.startsWith('pnpm install')) {
      const spec = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
        .dependencies['dsh-gac-runtime']
      rmSync(modulePath, { recursive: true, force: true })
      writeFileSync(join(profile, 'pnpm-lock.yaml'),
        'importers:\n  .:\n    dependencies:\n      dsh-gac-runtime:\n        specifier: ' + spec + '\n')
      if (spec.startsWith('link:')) {
        symlinkSync(root, modulePath, 'junction')
      } else {
        const installed = join(profile, 'node_modules', '.pnpm', 'installed-' + calls.length)
        cpSync(root, installed, { recursive: true })
        symlinkSync(installed, modulePath, 'junction')
      }
      return ''
    }
    throw Error('unexpected shell call ' + cmd)
  }
  const opts = { root, profile, dshHome, command: runner, processChecker: () => [], log: (s) => lines.push(s) }
  return { root, profile, dshHome, modulePath, opts, lines, calls }
}

function checkCode(expected, action) {
  assert.throws(action, (error) => error instanceof DeployError && error.code === expected)
}

describe('本地插件开发/验收/发布隔离', () => {
  it('不因 package.json 声称 tarball 就忽略真实源码 Junction', () => {
    const f = fixture()
    const result = runDeployment(['status'], f.opts)
    assert.equal(result.isSource, true)
    assert.match(f.lines.join('\n'), /WARNING/u)
    assert.equal(f.calls.length, 0)
  })

  it('默认 dry-run、不允许没有明确验收确认就将源码指向 Profile', () => {
    const f = fixture()
    const before = readFileSync(join(f.profile, 'package.json'), 'utf8')
    assert.deepEqual(runDeployment(['validate'], f.opts), { command: 'validate', applied: false })
    checkCode('GAC_DEPLOY_CONFIRM_REQUIRED', () => runDeployment(['validate', '--apply'], f.opts))
    assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), before)
  })

  it('宿主仍运行时拒绝任何切换，不提供 force', () => {
    const f = fixture()
    f.opts.processChecker = () => [1234]
    checkCode('GAC_DEPLOY_HOST_RUNNING',
      () => runDeployment(['validate', '--apply', '--confirm-verify'], f.opts))
    assert.equal(f.calls.length, 0)
  })

  it('有工作树未提交变更时不能进入源码验收', () => {
    const f = fixture()
    f.opts.command = (cmd, cwd) => cmd.startsWith('git status') ? ' M lib/index.js\n' : ''
    checkCode('GAC_DEPLOY_DIRTY',
      () => runDeployment(['validate', '--apply', '--confirm-verify'], f.opts))
    assert.equal(inspectDeployment({
      profile: f.profile, root: f.root,
      stateFile: join(f.dshHome, 'gac-runtime-releases', 'core-test', 'validation.json'),
    }).state, undefined)
  })

  it('显式验收 → 有证据发布 → 实际模块路径脱离工作树', () => {
    const f = fixture()
    const start = runDeployment(['validate', '--apply', '--confirm-verify'], f.opts)
    assert.equal(start.commit, sha)
    assert.equal(resolve(realpathSync(f.modulePath)), resolve(f.root))
    checkCode('GAC_DEPLOY_NOT_APPROVED', () => runDeployment(['publish', '--apply'], f.opts))
    const published = runDeployment([
      'publish', '--apply', '--confirmed-pass', '--evidence', 'ev-live-123',
    ], f.opts)
    assert.equal(published.manifest.gitCommit, sha)
    assert.equal(published.manifest.evidence, 'ev-live-123')
    assert.ok(existsSync(published.manifest.file))
    assert.ok(existsSync(published.manifest.file + '.json'))
    assert.notEqual(resolve(realpathSync(f.modulePath)), resolve(f.root))
    const pkg = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    assert.ok(pkg.dependencies['dsh-gac-runtime'].startsWith('file:'))
    assert.equal(pkg.dependencies.another, '^1.0.0')
    const current = runDeployment(['status'], f.opts)
    assert.equal(current.state, undefined)
    assert.equal(current.isSource, false)
  })

  it('验收不通过时 restore 重新安装原依赖并清除验收态', () => {
    const f = fixture()
    runDeployment(['validate', '--apply', '--confirm-verify'], f.opts)
    runDeployment(['restore', '--apply'], f.opts)
    const pkg = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['dsh-gac-runtime'], 'file:old-release.tgz')
    assert.notEqual(resolve(realpathSync(f.modulePath)), resolve(f.root))
    checkCode('GAC_DEPLOY_NO_VALIDATION', () => runDeployment(['publish', '--apply', '--confirmed-pass', '--evidence', 'ev-1'], f.opts))
  })

  it('其他 Profile 没注册 Bundle 时拒绝修改', () => {
    const f = fixture()
    const path = join(f.profile, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.dsh.profile.bundles = []
    writeFileSync(path, JSON.stringify(pkg))
    checkCode('GAC_DEPLOY_NOT_INSTALLED', () => runDeployment(['status'], f.opts))
  })
})


it('旧 plugin:on 不得在依赖声明与真实工作区 Junction 冲突时启用', () => {
  const f = fixture()
  const patchFile = join(f.profile, 'cordis.patch.yml')
  const text = '- id: gac-runtime\n  disabled: true\n'
  writeFileSync(patchFile, text)
  const errors = []
  const args = ['on', '--file', patchFile]
  assert.equal(runSwitch(args, {
    env: { DSH_PROFILE_DIR: f.profile }, out: () => {},
    err: (s) => errors.push(s),
  }), 1)
  assert.match(errors.join('\n'), /禁止开启/u)
  assert.equal(readFileSync(patchFile, 'utf8'), text)

  // 安装成功的本地包在 Profile 内，才允许独立的 enable 开关。
  runDeployment(['validate', '--apply', '--confirm-verify'], f.opts)
  runDeployment(['publish', '--apply', '--confirmed-pass', '--evidence', 'ev-123'], f.opts)
  assert.equal(runSwitch(args, {
    env: { DSH_PROFILE_DIR: f.profile }, out: () => {}, err: (s) => errors.push(s),
  }), 0)
  assert.match(readFileSync(patchFile, 'utf8'), /disabled: false/u)
})


it('已安装的本地包若锁文件漂移，旧 plugin:on 也必须拒绝启用', () => {
  const f = fixture()
  runDeployment(['validate', '--apply', '--confirm-verify'], f.opts)
  runDeployment(['publish', '--apply', '--confirmed-pass', '--evidence', 'ev-456'], f.opts)
  const patchFile = join(f.profile, 'cordis.patch.yml')
  writeFileSync(patchFile, '- id: gac-runtime\n  disabled: true\n')
  writeFileSync(join(f.profile, 'pnpm-lock.yaml'),
    'importers:\n  .:\n    dependencies:\n      dsh-gac-runtime:\n        specifier: file:wrong.tgz\n')
  const errors = []
  assert.equal(runSwitch(['on', '--file', patchFile], {
    env: { DSH_PROFILE_DIR: f.profile }, out: () => {},
    err: (s) => errors.push(s),
  }), 1)
  assert.match(errors.join('\n'), /禁止开启/u)
  assert.match(readFileSync(patchFile, 'utf8'), /disabled: true/u)
  const state = runDeployment(['status'], f.opts)
  assert.notEqual(state.lockSpec, state.spec)
  assert.match(f.lines.join('\n'), /锁文件不一致/u)
})
