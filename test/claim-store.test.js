/**
 * 写占用声明存储测试。
 *
 * 冲突保证真正落脚的地方就是存储，所以要紧的测试是单实例单元测试会漏掉的
 * 那些：
 *
 *  - 两个「相互独立」的存储实例（模拟两个会话，或两个进程）必须通过文件
 *    系统看见彼此的占用声明；
 *  - 对一个并不持有该占用声明的会话，释放必须被拒绝，否则一次伪造的声明就
 *    能释放另一位写者的守卫；
 *  - 由一个已离场会话持有的占用声明必须停止阻塞任何人。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { ClaimStore, CLAIMS_RELATIVE_DIR } from '../lib/claim-store.js'

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时工程根目录，测试集结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-claims-'))
  scratchRoots.push(root)
  return root
}

/**
 * 一个架在某个根目录之上的存储，其存活会话集合可控。
 *
 * 不传 `live` 参数时，判定函数上报的存活状态是「未知」，这是保守姿态：占用
 * 声明被保留。更早的版本默认一个空的存活集合，于是每次 acquire 调用都把先前的
 * 占用声明当作孤儿删掉，冲突检测就被悄悄禁用了 —— 测试因为错误的理由通过，
 * 而它们本该抓住的那个缺陷活了下来。
 *
 * @param {string} root
 * @param {string[]} [live] - 被视为存活的会话 id；省略表示「未知」。
 * @returns {{store: ClaimStore, setLive: (ids: string[]|undefined) => void}}
 */
function storeAt(root, live) {
  let liveSessions = live
  const store = new ClaimStore({ root, liveSessions: () => liveSessions })
  return { store, setLive: (ids) => { liveSessions = ids } }
}

/** 一个会话的作用域声明。 */
function declaration(sessionId, scope, overrides = {}) {
  return {
    session_id: sessionId,
    task_id: 'REQ-1',
    node_id: 'T1',
    write_scope: scope,
    ...overrides,
  }
}

describe('acquiring a claim', () => {
  it('writes one claim file per session', () => {
    const root = scratch()
    const { store } = storeAt(root)
    const result = store.acquire(declaration('s-1', ['src/']))
    assert.equal(result.acquired, true)
    assert.equal(result.claim.session_id, 's-1')
    const files = readdirSync(join(root, ...CLAIMS_RELATIVE_DIR.split('/')))
    assert.equal(files.length, 1)
  })

  it('reports the holder when the scope is already taken', () => {
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/'], { task_id: 'REQ-1', node_id: 'T1' }))
    const result = store.acquire(declaration('s-2', ['src/deep/a.c'], { task_id: 'REQ-2', node_id: 'T2' }))
    assert.equal(result.acquired, false)
    assert.equal(result.conflict.claim.task_id, 'REQ-1')
    assert.equal(result.conflict.claimed, 'src/')
  })

  it('lets a second session take a disjoint scope', () => {
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/']))
    const result = store.acquire(declaration('s-2', ['test/']))
    assert.equal(result.acquired, true)
  })

  it('does not let a session collide with its own earlier claim', () => {
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/']))
    // 重新声明同一个作用域正是一个任务推进的方式；它绝不能自己阻塞自己。
    assert.equal(store.acquire(declaration('s-1', ['src/'], { node_id: 'T2' })).acquired, true)
  })
})

describe('two independent stores see each other through the filesystem', () => {
  it('blocks a colliding declaration made by a separate instance', () => {
    // 模拟两个会话，或同一个检出上的两个进程。一份内存中的注册表会通过
    // 单存储测试，却会在这个测试上失败。
    const root = scratch()
    const first = storeAt(root).store
    const second = storeAt(root).store

    assert.equal(first.acquire(declaration('s-1', ['src/'])).acquired, true)
    const blocked = second.acquire(declaration('s-2', ['src/a.c']))
    assert.equal(blocked.acquired, false)
    assert.equal(blocked.conflict.claim.session_id, 's-1')
  })

  it('sees a release made by the other instance', () => {
    const root = scratch()
    const first = storeAt(root).store
    const second = storeAt(root).store

    first.acquire(declaration('s-1', ['src/']))
    assert.equal(second.acquire(declaration('s-2', ['src/a.c'])).acquired, false)
    first.release('s-1')
    assert.equal(second.acquire(declaration('s-2', ['src/a.c'])).acquired, true)
  })
})

describe('release authorisation', () => {
  it('refuses to release a claim on behalf of another session', () => {
    // 前身运行时把这一点记为真实缺陷：一个指名了别人 dispatch id 的结果，
    // 能在对方的工作仍在飞行中时释放他们的守卫。
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/']))
    assert.equal(store.release('s-1', 's-2'), false)
    assert.equal(store.get('s-1') !== undefined, true, 'the claim must survive a forged release')
  })

  it('releases for the session that holds it', () => {
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/']))
    assert.equal(store.release('s-1', 's-1'), true)
    assert.equal(store.get('s-1'), undefined)
  })
})

describe('orphaned claims', () => {
  it('does not prune while liveness is unknown', () => {
    // 没有宿主对存活会话的视角时，一条陈旧的占用声明会被保留：阻塞一位写者
    // 是可恢复的，两位写者落在同一个文件上则不是。年龄从不会被当作死亡。
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/']))
    assert.deepEqual(store.orphans(), [])
  })

  it('reports a claim whose session has departed as an orphan', () => {
    const root = scratch()
    const { store, setLive } = storeAt(root, ['s-1'])
    store.acquire(declaration('s-1', ['src/']))
    assert.deepEqual(store.orphans(), [])
    setLive([])
    assert.equal(store.orphans().length, 1)
  })

  it('prunes an orphan before judging a conflict, so a dead session stops blocking', () => {
    const root = scratch()
    const { store, setLive } = storeAt(root, ['s-1'])
    store.acquire(declaration('s-1', ['src/']))
    setLive([])
    const result = store.acquire(declaration('s-2', ['src/a.c']))
    assert.equal(result.acquired, true)
  })

  it('never prunes a live session’s claim', () => {
    const root = scratch()
    const { store, setLive } = storeAt(root, ['s-1'])
    store.acquire(declaration('s-1', ['src/']))
    setLive(['s-1', 's-2'])
    assert.deepEqual(store.pruneOrphans(), { removed: [], failed: [] })
    assert.equal(store.get('s-1') !== undefined, true)
  })

  it('does not let a known-live session’s claim be pruned by another session acquiring', () => {
    // 那个真正要紧的回归：一个未知或空的存活集合，绝不能读成「现有的持有者
    // 已经死了」。
    const root = scratch()
    const { store, setLive } = storeAt(root, ['s-1'])
    store.acquire(declaration('s-1', ['src/']))
    setLive(['s-1'])
    store.acquire(declaration('s-2', ['test/']))
    assert.equal(store.get('s-1') !== undefined, true, 'the live holder must keep its claim')
  })

  it('treats a failing liveness predicate as “keep everything”, not “all dead”', () => {
    const root = scratch()
    const store = new ClaimStore({
      root,
      liveSessions: () => { throw new Error('session store unavailable') },
    })
    store.acquire(declaration('s-1', ['src/']))
    assert.deepEqual(store.orphans(), [])
  })
})

describe('unreadable claims are reported, not skipped', () => {
  it('reports a malformed claim file and keeps it on disk', () => {
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('s-1', ['src/']))
    const directory = join(root, ...CLAIMS_RELATIVE_DIR.split('/'))
    const broken = join(directory, 's-broken.json')
    writeFileSync(broken, '{ not json', 'utf8')

    const view = store.inspect()
    assert.equal(view.unreadable.length, 1)
    assert.match(view.unreadable[0].file, /s-broken\.json/u)
    // 悄悄跳过它，会让它所点名的那些路径失去保护，而保护看起来还在。它也
    // 不会被删除：一条读不出来的占用声明是证据。
    assert.equal(existsSync(broken), true)
  })

  it('reports a claim whose filename disagrees with its session_id', () => {
    const root = scratch()
    const { store } = storeAt(root)
    const directory = join(root, ...CLAIMS_RELATIVE_DIR.split('/'))
    store.acquire(declaration('s-1', ['src/']))
    // 一个手工放进去的文件，绝不能声称自己就是别人。
    writeFileSync(join(directory, 's-forged.json'), JSON.stringify({
      dispatch_id: 'd', session_id: 's-someone-else', task_id: 'R', node_id: 'N',
      write_scope: ['src/'], created_at: 0, heartbeat_at: 0,
    }), 'utf8')
    const view = store.inspect()
    assert.equal(view.unreadable.some((entry) => /does not match/u.test(entry.reason)), true)
  })

  it('reports an unreadable claims directory rather than calling it empty', () => {
    // 对不存在的目录，`list()` 返回 [] 是正确的 —— 那里还没有任何占用声明。
    // 绝不能发生的是：把一个「存在」却读不了的目录当作空目录，因为那样一位
    // 写者就会在持有者未知的情况下继续动手。
    const root = scratch()
    const asFile = join(root, 'not-a-directory')
    writeFileSync(asFile, 'x', 'utf8')
    const broken = new ClaimStore({ root: asFile, liveSessions: () => [] })
    assert.deepEqual(broken.list(), [])
    assert.equal(broken.unreadable.length, 1, 'an unreadable directory must be reported')
    assert.match(broken.inspect().unreadable[0].reason, /ENOTDIR|EEXIST|not a directory/iu)
  })

  it('treats a genuinely missing claims directory as empty, not as an error', () => {
    const root = scratch()
    const store = new ClaimStore({ root, liveSessions: () => [] })
    assert.deepEqual(store.list(), [])
    assert.deepEqual(store.unreadable, [])
  })
})

describe('filenames are safe', () => {
  it('keeps a crafted session id inside the claims directory', () => {
    // 检查的是占用声明落在存储目录「内部」，而且能按它自己的 id 读回来。
    // 这个测试更早的版本断言不存在一个同级文件，那并不可靠：那个同级路径会
    // 解析进共享的临时目录，可能因为无关的原因早已存在，于是测试的通过或
    // 失败取决于环境状态。
    const root = scratch()
    const { store } = storeAt(root)
    const hostile = '../../escape'
    store.acquire(declaration(hostile, ['src/']))

    const directory = join(root, ...CLAIMS_RELATIVE_DIR.split('/'))
    const files = readdirSync(directory)
    assert.equal(files.length, 1, 'exactly one file, inside the claims directory')
    // 要紧的是没有任何路径「分隔符」存活下来。一旦分隔符被百分号编码，字面
    // 的 `..` 子串就是无害的，所以断言它不存在，测的会是错误的性质。
    assert.equal(/[\\/]/u.test(files[0]), false, `filename must not contain a separator: ${files[0]}`)
    // 无损往返：原始 id 在编码之后仍然存活。
    assert.equal(store.get(hostile)?.session_id, hostile)
  })

  it('encodes a separator rather than dropping it', () => {
    const root = scratch()
    const { store } = storeAt(root)
    store.acquire(declaration('a/b', ['src/']))
    const directory = join(root, ...CLAIMS_RELATIVE_DIR.split('/'))
    const [file] = readdirSync(directory)
    assert.match(file, /^a%2Fb\.json$/u)
    assert.equal(store.get('a/b')?.session_id, 'a/b')
  })
})

describe('heartbeat', () => {
  it('refreshes an existing claim', () => {
    const root = scratch()
    let clock = 1000
    const store = new ClaimStore({ root, liveSessions: () => ['s-1'], now: () => clock })
    store.acquire(declaration('s-1', ['src/']))
    clock = 5000
    assert.equal(store.heartbeat('s-1'), true)
    assert.equal(store.get('s-1').heartbeat_at, 5000)
  })

  it('reports false when there is nothing to refresh', () => {
    const root = scratch()
    const { store } = storeAt(root)
    assert.equal(store.heartbeat('s-absent'), false)
  })
})

describe('store construction', () => {
  it('requires a project root', () => {
    assert.throws(() => new ClaimStore({}), TypeError)
    assert.throws(() => new ClaimStore({ root: '' }), TypeError)
  })
})
