/**
 * 第三方安装面测试。
 *
 * 这里测的不是运行时行为，而是「别人从 GitHub 装上本插件」所依赖的声明：
 * 示例适配器必须真的通过校验器，`files` 声明的每一项必须真实存在，运行时要用的
 * 入口与 bundle 补丁必须落在 `files` 覆盖范围内——否则 `pnpm add`/`npm pack` 出来的包
 * 会缺文件，装上即坏。
 *
 * 另外两条是发布面性质，不是风格问题：
 *  - DSH 对 git 来源的插件会走 pnpm，而 pnpm 默认拦下依赖的构建脚本。一旦这里出现
 *    `prepare`/`postinstall`，安装方就必须先在 Profile 的 pnpm-workspace.yaml 里放行
 *    allowBuilds 才能装上，所以本插件承诺不含安装期脚本。
 *  - `evaluatePluginCompatibility` 是硬门槛：peer 声明不满足时 DSH 会拒绝安装并回滚，
 *    或在启动时把整个 bundle 跳进 skippedBundles。因此 peer 只能限定在宿主自带的
 *    `@deepseek-ai/dsh*` 包上，并标记 optional，避免 pnpm 去公网拉宿主包。
 *  - npm 与 GitHub 两条路径共用同一份清单，但 npm 发布多三道门：`private` 为真会被
 *    `npm publish` 直接拒绝、包名与 bundle 名不一致会让 Profile 解析不到要加载的层、
 *    `publishConfig` 指向镜像源则根本发布不上去（npmmirror 是只读镜像）。下面单独断言。
 */
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { loadProjectAdapterFromText } from '../lib/project.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** 安装期构建脚本：出现任何一个都会让安装方需要额外放行 allowBuilds。 */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']

/** `files` 里的目录条目覆盖其下所有文件；比较前统一去掉开头的 `./`。 */
function isCovered(relativePath, entries) {
  const target = relativePath.replace(/^\.\//u, '')
  return entries.some((entry) => {
    const prefix = entry.replace(/^\.\//u, '').replace(/\/$/u, '')
    return target === prefix || target.startsWith(`${prefix}/`)
  })
}

describe('第三方安装面', () => {
  it('示例适配器是一份可以直接复制的合法适配器', async () => {
    const text = await readFile(join(root, 'examples', 'gac-project.json'), 'utf8')
    const adapter = loadProjectAdapterFromText(text, 'examples/gac-project.json')
    assert.equal(typeof adapter.project.id, 'string')
    assert.ok(adapter.project.id.length > 0)
    assert.equal(Object.isFrozen(adapter), true)
  })

  it('files 里每一项都真实存在', () => {
    const entries = manifest.files ?? []
    assert.ok(entries.length > 0, 'files 不能为空，否则安装包只剩 package.json')
    for (const entry of entries) {
      assert.equal(existsSync(join(root, entry)), true, `files 声明的 ${entry} 不存在`)
    }
  })

  it('运行时入口与 bundle 补丁都被 files 覆盖', () => {
    const entries = manifest.files ?? []
    assert.equal(isCovered(manifest.main ?? '', entries), true, `入口 ${manifest.main} 未包含在 files 中`)

    const patch = manifest.dsh?.bundle?.patch
    assert.equal(typeof patch, 'string', 'dsh.bundle.patch 缺失，DSH 无法把本包装成 profile 层')
    assert.equal(existsSync(join(root, patch)), true, `bundle 补丁 ${patch} 不存在`)
    assert.equal(isCovered(patch, entries), true, `bundle 补丁 ${patch} 未包含在 files 中`)
  })

  it('dsh.bundle.patch 指向的是文件而不是目录', () => {
    const patch = join(root, manifest.dsh.bundle.patch)
    assert.equal(statSync(patch).isFile(), true, `${manifest.dsh.bundle.patch} 必须是补丁文件`)
  })

  it('没有安装期构建脚本，安装方不需要放行 allowBuilds', () => {
    for (const hook of INSTALL_HOOKS) {
      assert.equal(
        manifest.scripts?.[hook],
        undefined,
        `出现安装期脚本 ${hook}：git 来源的插件会因此在 pnpm 授权前装不上`,
      )
    }
  })

  it('peer 只声明宿主自带的包，且全部 optional', () => {
    const peers = Object.keys(manifest.peerDependencies ?? {})
    assert.ok(peers.length > 0, '缺少 peer 声明，版本不匹配时宿主不会给出可操作的提示')
    for (const name of peers) {
      assert.match(name, /^@deepseek-ai\/dsh(?:-|$)/u, `peer ${name} 不是 DSH 宿主包`)
      assert.equal(
        manifest.peerDependenciesMeta?.[name]?.optional,
        true,
        `peer ${name} 必须标 optional，否则 pnpm 会尝试从公网安装宿主包`,
      )
    }
  })

  it('描述仓库自身的发布元数据齐备', () => {
    assert.equal(typeof manifest.name, 'string')
    assert.equal(typeof manifest.version, 'string')
    assert.match(manifest.repository?.url ?? '', /MancoCL\/DSH_Agent_Runtime/u)
    assert.equal(manifest.dsh?.bundle !== undefined, true)
  })

  it('npm 发布面：包名与 bundle 同名、公开指向官方源', () => {
    assert.equal(
      manifest.name,
      'dsh-gac-runtime',
      'npm 包名必须与 bundle 名一致，Profile 依赖、cordis.patch.yml 与卸载命令都按它解析',
    )
    assert.notEqual(manifest.private, true, 'private 为真时 npm publish 会被直接拒绝，别人也就装不到')
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, `版本号 ${manifest.version} 必须能被 npm 作为正式版本发布`)
    assert.equal(manifest.publishConfig?.access, 'public', '非 scope 包也必须显式公开，避免发布成受限包')
    assert.equal(
      manifest.publishConfig?.registry,
      'https://registry.npmjs.org/',
      '发布上游只能是 npm 官方源；npmmirror 是只读镜像，由它自动同步',
    )
  })

  it('npm 发布面：只发布运行时需要的文件', () => {
    const entries = manifest.files ?? []
    for (const directory of ['test', 'scripts', '.dsh', 'examples']) {
      assert.equal(
        entries.some((entry) => entry === directory || entry.startsWith(`${directory}/`)),
        directory === 'examples',
        `${directory} 进发布包会改变别人安装到的内容，必须显式决定`,
      )
    }
  })

  it('npm 发布面：不包含本机数据或内部开发文档', () => {
    const entries = manifest.files ?? []
    for (const denied of ['.dsh', '.acl-recovery', 'docs', 'AGENTS.md', 'test', 'scripts']) {
      assert.equal(isCovered(denied, entries), false, `不应将 ${denied} 放入 npm 安装包`)
    }
    for (const required of ['lib/index.js', 'assets/ENGINEERING_POLICY.md', 'examples/gac-project.json', 'README.md']) {
      assert.equal(isCovered(required, entries), true, `npm 包缺少 ${required}`)
    }
  })

  it('npm 发布面：OIDC workflow 不带凭据，且强制版本号与标签一致', async () => {
    const workflowPath = join(root, '.github', 'workflows', 'publish-npm.yml')
    assert.equal(
      existsSync(workflowPath),
      true,
      '缺少 .github/workflows/publish-npm.yml：npm trust github 登记的就是这个文件名',
    )
    const text = await readFile(workflowPath, 'utf8')
    assert.match(text, /workflow_dispatch/u, '发布必须手动触发，不能在每次 push 时发布')
    assert.match(text, /id-token:\s*write/u, 'OIDC 发布必须声明 id-token: write，否则 npm 会退回要求 token/OTP')
    assert.match(
      text,
      /registry-url:\s*'?https:\/\/registry\.npmjs\.org'?/u,
      '发布上游只能是 npm 官方源；npmmirror 是只读镜像',
    )
    assert.match(text, /npm trust github/u, '注释里要留维护者登记 Trusted Publisher 的命令，否则没人知道怎么配')
    assert.doesNotMatch(text, /_authToken|NODE_AUTH_TOKEN|secrets\./u, '发布凭据不得进入仓库或 CI 变量')
  })
})
