/**
 * 插件开关脚本测试。
 *
 * 变换是纯函数，因此这里可以逐条验：只在目标块里动手、注释与其余字节原样保留、幂等、有歧义时
 * 拒绝改。**所有用例都在临时文件上跑**：这个脚本的真实作用对象是 profile 的最后一层，一次跑偏
 * 会改到本机正在用的配置，所以测试绝不碰真文件，也绝不改 `process.env`。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  PLUGIN_ID,
  SWITCH_CODES,
  SwitchError,
  patchCandidates,
  readPluginState,
  resolvePatchFile,
  runSwitch,
  setPluginDisabled,
} from '../scripts/plugin-switch.js'

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/**
 * 一份像真实 patch 那样的多插件配置。
 *
 * 里面有别的插件条目，是为了让「只动目标块」这条断言有意义——只在单条目文件上测，改坏别人的
 * 配置也看不出来。
 *
 * @param {string} disabledLine
 * @returns {string}
 */
function patch(disabledLine = `  disabled: true      # 默认关闭（AGENTS.md §0）`) {
  return [
    '# profile 的最后一层',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: opencode-go',
    `- id: ${PLUGIN_ID}`,
    disabledLine,
    '- id: hmr',
    '  name: "@deepseek-ai/dsh-hmr"',
    '  config:',
    '    root:',
    '      - D:/WorkSpace/99_Others/02_UserProject/Agent_Runtime',
    '',
  ].join('\n')
}

/**
 * 一个临时 patch 文件。
 *
 * @param {string} [text]
 * @returns {string}
 */
function scratchPatch(text = patch()) {
  const root = mkdtempSync(join(tmpdir(), 'gac-switch-'))
  scratchRoots.push(root)
  const file = join(root, 'cordis.patch.yml')
  writeFileSync(file, text, 'utf8')
  return file
}

describe('readPluginState —— 现在到底开着没有', () => {
  it('读得出现在是关着的', () => {
    const state = readPluginState(patch())
    assert.equal(state.disabled, true)
    assert.equal(state.line, 7)
  })

  it('读得出现在是开着的', () => {
    const state = readPluginState(patch('  disabled: false'))
    assert.equal(state.disabled, false)
  })

  it('没有 disabled 行等于默认启用', () => {
    // YAML 与 Cordis 的共同语义，不是本模块的发明：没关就是开着。
    const state = readPluginState(patch(undefined).replace('  disabled: true      # 默认关闭（AGENTS.md §0）\n', ''))
    assert.equal(state.disabled, false)
    assert.equal(state.line, undefined)
  })

  it('这个 profile 里没装本插件时明确报错', () => {
    assert.throws(
      () => readPluginState('- id: hmr\n  name: x\n'),
      (error) => error instanceof SwitchError && error.code === SWITCH_CODES.ENTRY_MISSING,
    )
  })

  it('两条同 id 的条目时拒绝猜', () => {
    const doubled = `- id: ${PLUGIN_ID}\n  disabled: true\n- id: ${PLUGIN_ID}\n  disabled: false\n`
    assert.throws(
      () => readPluginState(doubled),
      (error) => error.code === SWITCH_CODES.AMBIGUOUS && error.detail.lines.length === 2,
    )
  })
})

describe('setPluginDisabled —— 只动目标块', () => {
  it('把开关打开，并保留同一行上的注释', () => {
    const result = setPluginDisabled(patch(), false)
    assert.equal(result.changed, true)
    assert.match(result.text, /  disabled: false      # 默认关闭（AGENTS\.md §0）/u)
  })

  it('只改目标块：别的插件条目一个字节都不动', () => {
    const before = patch()
    const after = setPluginDisabled(before, false).text
    const untouched = (text) => text.split('\n').filter((line) => !line.includes('disabled:'))
    assert.deepEqual(untouched(after), untouched(before))
    assert.equal(after.split('\n').length, before.split('\n').length)
  })

  it('幂等：本来就是目标状态时一个字节都不改', () => {
    const result = setPluginDisabled(patch('  disabled: true'), true)
    assert.equal(result.changed, false)
    assert.equal(result.text, patch('  disabled: true'))
  })

  it('块里没有 disabled 行时插一行，缩进与注释都对', () => {
    const without = patch().replace('  disabled: true      # 默认关闭（AGENTS.md §0）\n', '')
    const result = setPluginDisabled(without, true, { comment: '默认关闭（AGENTS.md §0）' })
    assert.equal(result.changed, true)
    assert.match(result.text, /- id: gac-runtime\n  disabled: true      # 默认关闭（AGENTS\.md §0）\n/u)
    // 插进去的那一行不能被塞到别的块里。
    assert.equal(readPluginState(result.text).disabled, true)
  })

  it('开关再关回来，回到原样', () => {
    const on = setPluginDisabled(patch(), false).text
    const off = setPluginDisabled(on, true).text
    assert.equal(off, patch())
  })

  it('没装本插件时拒绝改，并说明要先装', () => {
    assert.throws(
      () => setPluginDisabled('- id: hmr\n  name: x\n', false),
      (error) => error.code === SWITCH_CODES.ENTRY_MISSING && /install_bundle/u.test(error.message),
    )
  })

  it('可以指名别的 id（本模块不只服务自己）', () => {
    const result = setPluginDisabled('- id: other\n  disabled: true\n', false, { id: 'other' })
    assert.equal(result.text, '- id: other\n  disabled: false\n')
  })
})

describe('路径发现 —— 找不到要说清试过哪里', () => {
  it('--file 给出的路径排在最前', () => {
    const file = scratchPatch()
    assert.equal(resolvePatchFile({}, file), file)
  })

  it('DSH_PROFILE_DIR 是第二候选', () => {
    const root = mkdtempSync(join(tmpdir(), 'gac-switch-dir-'))
    scratchRoots.push(root)
    writeFileSync(join(root, 'cordis.patch.yml'), patch(), 'utf8')
    assert.equal(resolvePatchFile({ DSH_PROFILE_DIR: root }), join(root, 'cordis.patch.yml'))
  })

  it('DSH_HOME + DSH_PROFILE 是第三候选', () => {
    const home = mkdtempSync(join(tmpdir(), 'gac-switch-home-'))
    scratchRoots.push(home)
    const dir = join(home, 'profiles', 'core-020')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), patch(), 'utf8')
    assert.equal(resolvePatchFile({ DSH_HOME: home, DSH_PROFILE: 'core-020' }), join(dir, 'cordis.patch.yml'))
  })

  it('一个都不存在时把候选与各自失败的原因列出来', () => {
    // 只报一句「找不到」无法区分「环境变量没设」「profile 不存在」与「这个 profile 没装插件」。
    const missing = join(tmpdir(), 'gac-definitely-not-here', 'cordis.patch.yml')
    assert.throws(
      () => resolvePatchFile({ DSH_PROFILE_DIR: missing }, missing),
      (error) => error.code === SWITCH_CODES.FILE_MISSING
        && error.detail.candidates.length === 2
        && /DSH_PROFILE_DIR/u.test(error.message),
    )
  })

  it('候选列表去重，且说明每一项是怎么来的', () => {
    const { candidates, notes } = patchCandidates({
      DSH_PROFILE_DIR: 'D:/p/core-020',
      DSH_HOME: 'C:/Users/x/.dsh',
      DSH_PROFILE: 'core-020',
    }, 'D:/p/core-020/cordis.patch.yml')
    assert.equal(new Set(candidates).size, candidates.length)
    assert.ok(notes.some((note) => note.includes('--file')))
    assert.ok(notes.some((note) => note.includes('DSH_PROFILE_DIR')))
  })
})

describe('CLI —— 一次调用把事做完', () => {
  /**
   * 跑一次 CLI，收集输出。
   *
   * @param {string[]} argv
   * @returns {{code: number, out: string[], err: string[]}}
   */
  function cli(argv) {
    const out = []
    const err = []
    const code = runSwitch(argv, { out: (line) => out.push(line), err: (line) => err.push(line), env: {} })
    return { code, out, err }
  }

  it('status 报出当前状态，不写文件', () => {
    const file = scratchPatch()
    const before = readFileSync(file, 'utf8')
    const { code, out } = cli(['status', '--file', file])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /关闭/u)
    assert.equal(readFileSync(file, 'utf8'), before)
  })

  it('on 打开开关并写明「这段时间不要改 lib」', () => {
    const file = scratchPatch()
    const { code, out } = cli(['on', '--file', file])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /已开启/u)
    assert.match(out.join('\n'), /不要改 lib/u)
    assert.equal(readPluginState(readFileSync(file, 'utf8')).disabled, false)
  })

  it('off 关回去，并说明这是默认状态而不是故障', () => {
    const file = scratchPatch(patch('  disabled: false'))
    const { code, out } = cli(['off', '--file', file])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /默认状态/u)
    assert.equal(readPluginState(readFileSync(file, 'utf8')).disabled, true)
  })

  it('原本就是这个状态时说一句，而不是假装改了', () => {
    const file = scratchPatch()
    const { code, out } = cli(['off', '--file', file])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /原本就是这个状态/u)
  })

  it('省略动作时按 status 处理', () => {
    const file = scratchPatch()
    const { code, out } = cli(['--file', file])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /关闭/u)
  })

  it('动作拼错时报用法并返回非零', () => {
    const file = scratchPatch()
    const { code, err } = cli(['enabled', '--file', file])
    assert.equal(code, 1)
    assert.match(err.join('\n'), /用法/u)
  })

  it('文件不存在时返回非零，并把候选列出来', () => {
    const missing = join(tmpdir(), 'gac-nope', 'cordis.patch.yml')
    const { code, err } = cli(['status', '--file', missing])
    assert.equal(code, 1)
    assert.match(err.join('\n'), /试过的位置/u)
  })
})

describe('本仓库的约定与脚本一致', () => {
  it('脚本认的 id 就是本插件在 patch 里用的那个', () => {
    const own = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(own, new RegExp(`id:\\s*${PLUGIN_ID}`, 'u'))
  })
})
