/**
 * Write-claim store tests.
 *
 * The store is where the collision guarantee actually lives, so the tests that
 * matter are the ones a single-instance unit test would miss:
 *
 *  - two INDEPENDENT store instances (modelling two sessions, or two processes)
 *    must see each other's claims through the filesystem;
 *  - release must be refused for a session that does not hold the claim, or a
 *    forged declaration could free another writer's guard;
 *  - a claim held by a departed session must stop blocking anyone.
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

/** A scratch project root, removed when the suite ends. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-claims-'))
  scratchRoots.push(root)
  return root
}

/**
 * A store over a root, with a controllable set of live sessions.
 *
 * With no `live` argument the predicate reports UNKNOWN liveness, which is the
 * conservative posture: claims are kept. An earlier version defaulted to an empty
 * live set, so every acquire call deleted the previous claim as an orphan and
 * collision detection was silently disabled — the tests passed for the wrong
 * reason and the bug they existed to catch survived.
 *
 * @param {string} root
 * @param {string[]} [live] - session ids considered alive; omit for "unknown".
 * @returns {{store: ClaimStore, setLive: (ids: string[]|undefined) => void}}
 */
function storeAt(root, live) {
  let liveSessions = live
  const store = new ClaimStore({ root, liveSessions: () => liveSessions })
  return { store, setLive: (ids) => { liveSessions = ids } }
}

/** A scope declaration for one session. */
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
    // Re-declaring the same scope is how a task advances; it must not self-block.
    assert.equal(store.acquire(declaration('s-1', ['src/'], { node_id: 'T2' })).acquired, true)
  })
})

describe('two independent stores see each other through the filesystem', () => {
  it('blocks a colliding declaration made by a separate instance', () => {
    // Models two sessions, or two processes over one checkout. An in-memory
    // registry would pass a single-store test and fail this one.
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
    // The predecessor runtime recorded this as a real defect: a result that
    // named someone else's dispatch id could free their guard while their work
    // was still in flight.
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
    // Without the host's view of live sessions, an old claim is kept: blocking a
    // writer is recoverable, two writers on one file is not. Age is never
    // treated as death.
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
    // The regression that mattered: an unknown or empty live set must never be
    // read as "the existing holder is dead".
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
    // Skipping it silently would drop protection for the paths it named while
    // the protection still looked present. It is also not deleted: an
    // unreadable claim is evidence.
    assert.equal(existsSync(broken), true)
  })

  it('reports a claim whose filename disagrees with its session_id', () => {
    const root = scratch()
    const { store } = storeAt(root)
    const directory = join(root, ...CLAIMS_RELATIVE_DIR.split('/'))
    store.acquire(declaration('s-1', ['src/']))
    // A file placed by hand must not be able to claim to be someone else.
    writeFileSync(join(directory, 's-forged.json'), JSON.stringify({
      dispatch_id: 'd', session_id: 's-someone-else', task_id: 'R', node_id: 'N',
      write_scope: ['src/'], created_at: 0, heartbeat_at: 0,
    }), 'utf8')
    const view = store.inspect()
    assert.equal(view.unreadable.some((entry) => /does not match/u.test(entry.reason)), true)
  })

  it('reports an unreadable claims directory rather than calling it empty', () => {
    // `list()` returning [] for a missing directory is correct — there are no
    // claims yet. What must not happen is treating a directory that EXISTS but
    // cannot be read as empty, because a writer would then proceed against
    // unknown holders.
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
    // The check is that the claim lands INSIDE the store directory and is
    // readable back under its own id. An earlier version of this test asserted
    // the absence of a sibling file, which was unreliable: that sibling path
    // resolves into the shared temp directory and could pre-exist for unrelated
    // reasons, making the test pass or fail on ambient state.
    const root = scratch()
    const { store } = storeAt(root)
    const hostile = '../../escape'
    store.acquire(declaration(hostile, ['src/']))

    const directory = join(root, ...CLAIMS_RELATIVE_DIR.split('/'))
    const files = readdirSync(directory)
    assert.equal(files.length, 1, 'exactly one file, inside the claims directory')
    // What matters is that no path SEPARATOR survives. A literal `..` substring
    // is harmless once separators are percent-encoded, so asserting its absence
    // would test the wrong property.
    assert.equal(/[\\/]/u.test(files[0]), false, `filename must not contain a separator: ${files[0]}`)
    // Lossless round trip: the original id survives encoding.
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
