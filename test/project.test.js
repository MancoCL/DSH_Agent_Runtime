/**
 * Project Adapter tests.
 *
 * Two properties matter here and are asserted directly:
 *
 *  1. The universal runtime contains no project facts (architecture outline
 *     §2.4, §15, §50). The "no project facts leak" suite reads the library
 *     sources and fails if a project-specific word appears in them.
 *  2. A declared execution mode is cross-checked against project-declared
 *     high-risk paths, so "start at the lowest sufficient level" cannot become
 *     "claim the lowest level" (outline §5, §6, §7).
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  EXECUTION_MODES,
  ProjectAdapterError,
  isHighRiskPath,
  loadProjectAdapterFromText,
  modeForRisk,
  modeRank,
  modeToRisk,
  resolveExecutionMode,
  validateProjectAdapter,
} from '../lib/project.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** A minimal valid adapter, stood up per-test so mutations cannot leak. */
function adapter(overrides = {}) {
  return validateProjectAdapter({
    schema_version: 1,
    project: { id: 'example-project', title: 'Example' },
    capabilities: ['implementation', 'verification'],
    executors: {
      implementation: ['builder'],
      verification: ['verifier'],
    },
    risk: { high_risk_paths: ['src/boot/**', 'src/auth/**'], default_level: 'low' },
    ...overrides,
  })
}

describe('validateProjectAdapter — accepts a well-formed adapter', () => {
  it('freezes the result so later mutation cannot change policy', () => {
    const parsed = adapter()
    assert.equal(Object.isFrozen(parsed), true)
    assert.equal(Object.isFrozen(parsed.risk.high_risk_paths), true)
    assert.throws(() => {
      parsed.risk.high_risk_paths.push('src/evil.c')
    }, TypeError)
  })

  it('defaults memory scope to the outline §13 allow-list', () => {
    const parsed = adapter()
    assert.deepEqual([...parsed.memory.allow], ['current_project', 'global_reusable'])
    assert.deepEqual([...parsed.memory.deny_as_project_fact], ['foreign_project', 'unknown'])
  })
})

describe('validateProjectAdapter — refuses malformed input', () => {
  const cases = [
    ['a non-object top level', []],
    ['a missing project id', { project: {} }],
    ['an unknown top-level key', { project: { id: 'p' }, typo_section: {} }],
    ['a capability not declared before use', {
      project: { id: 'p' },
      capabilities: ['implementation'],
      executors: { review: ['r'] },
    }],
    ['a non-array high_risk_paths', {
      project: { id: 'p' },
      risk: { high_risk_paths: 'src/' },
    }],
    ['an out-of-vocabulary risk level', {
      project: { id: 'p' },
      risk: { high_risk_paths: [], default_level: 'catastrophic' },
    }],
    ['an out-of-vocabulary memory scope', {
      project: { id: 'p' },
      memory: { allow: ['somewhere_else'] },
    }],
  ]

  for (const [label, raw] of cases) {
    it(`refuses ${label}`, () => {
      assert.throws(() => validateProjectAdapter(raw), ProjectAdapterError)
    })
  }

  it('carries a stable code so callers need not parse the message', () => {
    try {
      validateProjectAdapter({ project: {} })
      assert.fail('expected a throw')
    } catch (error) {
      assert.equal(error.code, 'GAC_PROJECT_ADAPTER_INVALID')
    }
  })
})

describe('loadProjectAdapterFromText', () => {
  it('reports malformed JSON as an adapter error, not a SyntaxError', () => {
    assert.throws(
      () => loadProjectAdapterFromText('{ not json', 'project.json'),
      (error) => error instanceof ProjectAdapterError && /not valid JSON/u.test(error.message),
    )
  })

  it('names the source path in the error, so a bad file is findable', () => {
    assert.throws(
      () => loadProjectAdapterFromText('null', 'C:/proj/.dsh/gac/project.json'),
      /C:\/proj\/\.dsh\/gac\/project\.json/u,
    )
  })
})

describe('isHighRiskPath', () => {
  const paths = ['src/boot/**', 'src/auth/**']

  it('matches a declared high-risk subtree', () => {
    assert.equal(isHighRiskPath('src/auth/login.c', paths), true)
  })

  it('matches the high-risk directory itself', () => {
    assert.equal(isHighRiskPath('src/boot', paths), true)
  })

  it('is case-insensitive on the same footing as the write gate', () => {
    assert.equal(isHighRiskPath('SRC/AUTH/LOGIN.C', paths), true)
  })

  it('does not match unrelated code, even with a similar prefix', () => {
    assert.equal(isHighRiskPath('src/authz/helper.c', paths), false)
  })

  it('is false when the project declares no high-risk paths', () => {
    assert.equal(isHighRiskPath('src/boot/main.c', []), false)
  })
})

describe('resolveExecutionMode — the escalation gate', () => {
  it('keeps a low-risk declaration as-is', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: 'remove one config field',
      target_paths: ['config/app.json'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'direct_edit')
    assert.equal(verdict.escalated, false)
    assert.equal(verdict.risk, 'low')
  })

  it('escalates direct_edit to high_risk_task when a target is a high-risk path', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: 'adjust one constant',
      target_paths: ['src/auth/token.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'high_risk_task')
    assert.equal(verdict.escalated, true)
    assert.equal(verdict.escalated_from, 'direct_edit')
    assert.equal(verdict.code, 'GAC_PROCESS_ESCALATION_REQUIRED')
    assert.match(verdict.reason, /src\/auth\/token\.c/u)
  })

  it('escalates by semantic impact, not by file count', () => {
    // One file, still high risk. The outline is explicit that file count is
    // never the criterion (a single auth policy file can be high risk).
    const verdict = resolveExecutionMode({
      declared_mode: 'standard_task',
      reason: 'single-file auth change',
      target_paths: ['src/boot/main.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'high_risk_task')
  })

  it('records irreversibility without inventing an escalation', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'standard_task',
      reason: 'write a migration',
      target_paths: ['src/db/schema.sql'],
      irreversible: true,
      adapter: adapter(),
    })
    assert.equal(verdict.mode, 'standard_task')
    assert.match(verdict.reason, /IRREVERSIBLE/u)
  })

  it('records ambiguity without inventing an escalation', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'direct_edit',
      reason: 'tweak a value',
      target_paths: ['config/app.json'],
      ambiguous: true,
      adapter: adapter(),
    })
    assert.match(verdict.reason, /AMBIGUOUS/u)
  })

  it('leaves an already-high-risk declaration unescalated', () => {
    const verdict = resolveExecutionMode({
      declared_mode: 'high_risk_task',
      reason: 'auth rework',
      target_paths: ['src/auth/token.c'],
      adapter: adapter(),
    })
    assert.equal(verdict.escalated, false)
  })

  it('rejects an out-of-vocabulary mode instead of defaulting to something', () => {
    assert.throws(
      () => resolveExecutionMode({
        declared_mode: 'quick_fix',
        target_paths: [],
        adapter: adapter(),
      }),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('refuses to run without an adapter, rather than assuming low risk', () => {
    assert.throws(
      () => resolveExecutionMode({ declared_mode: 'direct_edit', target_paths: [] }),
      ProjectAdapterError,
    )
  })
})

describe('mode / risk tables', () => {
  it('maps each risk to exactly one mode and back again', () => {
    for (const risk of ['low', 'medium', 'high']) {
      assert.equal(modeToRisk(modeForRisk(risk)), risk)
    }
  })

  it('orders modes from cheapest process to most ceremonious', () => {
    assert.equal(modeRank('read_only'), 0)
    assert.ok(modeRank('direct_edit') < modeRank('standard_task'))
    assert.ok(modeRank('standard_task') < modeRank('high_risk_task'))
  })

  it('rejects an unknown risk instead of guessing', () => {
    assert.throws(() => modeForRisk('severe'), ProjectAdapterError)
  })
})

describe('no project facts leak into the universal runtime', () => {
  it('the library sources name no capability or project from any adapter', async () => {
    // Words that belong to a *project*, never to the runtime. If one of these
    // ever appears in lib/, a project fact has been hardcoded and the
    // cross-project reuse goal (outline §1, §2.4) is broken.
    const forbidden = [
      'hardware-facts',
      'c-safety',
      'security-analysis',
      'stm32',
      'bootloader',
      'firmware',
    ]
    const files = (await readdir(libDir)).filter((name) => name.endsWith('.js'))
    assert.ok(files.length > 0, 'expected library sources to exist')

    for (const file of files) {
      const text = (await readFile(join(libDir, file), 'utf8')).toLowerCase()
      const source = stripComments(text)
      for (const word of forbidden) {
        assert.equal(
          source.includes(word),
          false,
          `${file} mentions project-specific "${word}" outside a comment`,
        )
      }
    }
  })

  it('the execution-mode vocabulary is closed', () => {
    assert.deepEqual([...EXECUTION_MODES], [
      'read_only',
      'direct_edit',
      'standard_task',
      'high_risk_task',
    ])
  })
})

/**
 * Remove block and line comments so the leak check tests code, not the
 * documentation that legitimately discusses project-shaped examples.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
}
