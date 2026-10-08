/**
 * 开源仓库边界：本机私有配置、凭据、运行记录不能因新文件名进入公开提交。
 * 测试实际 Git 忽略行为，而不只检查 .gitignore 是否含有某行文本。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

describe('开源仓库的私有文件边界', () => {
  it('本地运行数据和常见凭据默认不可被 Git 新增', () => {
    for (const path of [
      '.dsh/gac/project.json',
      '.dsh/gac/events/events.jsonl',
      '.dsh/gac/future-state.json',
      '.acl-recovery/backup.json',
      '.env',
      '.env.local',
      '.npmrc',
      '.pypirc',
      'private.key',
      'cert.pem',
      'id_rsa',
      'credentials.json',
      'config/service-account-prod.json',
      'dist/release.tgz',
      'coverage/lcov.info',
      '.cache/debug.json',
      'tmp/debug.json',
    ]) {
      assert.equal(git('check-ignore', '--no-index', '-q', '--', path).status, 0, `未忽略私有路径：${path}`)
    }
  })

  it('示例配置、源码、文档仍能进入 Git', () => {
    for (const path of ['.env.example', 'examples/gac-project.json', 'lib/index.js', 'README.md']) {
      assert.equal(git('check-ignore', '--no-index', '-q', '--', path).status, 1, `误忽略公开文件：${path}`)
    }
  })

  it('本工程运行配置不再被 Git 跟踪', () => {
    assert.equal(git('ls-files', '--error-unmatch', '--', '.dsh/gac/project.json').status, 1)
  })

  it('GitHub 使用完整历史的 Gitleaks 自动扫描', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'secret-scan.yml'), 'utf8')
    assert.match(workflow, /gitleaks\/gitleaks-action@v3/u)
    assert.match(workflow, /fetch-depth:\s*0/u)
    assert.match(workflow, /pull_request:/u)
    assert.match(workflow, /push:/u)
  })
})
