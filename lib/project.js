/**
 * Project Adapter: the per-project facts that the universal runtime must not
 * hardcode.
 *
 * @module dsh-gac-runtime/project
 *
 * The architecture outline (§14, §15, §50) keeps project identity, the
 * capability vocabulary, high-risk paths and engineering rules OUT of the
 * runtime and IN the project. This module is that seam, and it is deliberately
 * boring: read one JSON file, validate it against a closed set, and hand back a
 * frozen object. No project name, path or capability word appears in this
 * file — `test/project.test.js` asserts exactly that, because a project fact
 * leaking into the runtime is the failure mode this whole layer exists to
 * prevent.
 *
 * THE ONE INTERESTING FUNCTION IS resolveExecutionMode
 * ---------------------------------------------------
 * The outline (§5, §6) says the execution mode is a *semantic* judgement that
 * the runtime cannot make, so the model declares it — but a declaration must
 * not be self-certifying, or "start at the lowest sufficient level" becomes
 * "claim the lowest level". So the mode is declared by the model and then
 * cross-checked against the one thing code can check: whether any target path
 * falls in a project-declared high-risk path.
 *
 * Note what this function does NOT do: it never parses the requirement text
 * for keywords. The predecessor runtime banned naive text scanning in its own
 * policy (a `text_gate_rule`), and keyword-matching an intent is exactly the
 * kind of plausible-looking gate that fails open on the phrasing it did not
 * anticipate.
 */

import { createWriteScope } from './write-scope.js'

/** Execution modes, lowest sufficient process level first. */
export const EXECUTION_MODES = Object.freeze([
  'read_only',
  'direct_edit',
  'standard_task',
  'high_risk_task',
])

/** Declaration targets an execution mode may be escalated from. */
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high'])

/** Modes that must NOT appear in a formal task record (outline §5.1, §5.2). */
export const NON_TASK_MODES = Object.freeze(['read_only', 'direct_edit'])

/**
 * Mode a risk level maps to. Presence of this table is the whole reason the
 * mode is one decision rather than two: the risk resolver and the mode
 * selector read the same rows.
 */
const RISK_TO_MODE = Object.freeze({
  low: 'direct_edit',
  medium: 'standard_task',
  high: 'high_risk_task',
})

/** Structured codes, so callers branch on a code and not on a message. */
export const PROJECT_CODES = Object.freeze({
  MISSING: 'GAC_PROJECT_ADAPTER_MISSING',
  INVALID: 'GAC_PROJECT_ADAPTER_INVALID',
  ESCALATION_REQUIRED: 'GAC_PROCESS_ESCALATION_REQUIRED',
  UNKNOWN_MODE: 'GAC_UNKNOWN_EXECUTION_MODE',
  UNKNOWN_CAPABILITY: 'GAC_UNKNOWN_CAPABILITY',
})

/**
 * Thrown for a malformed or missing adapter. Carries a stable `code` so the
 * coordinator can branch without parsing the message.
 */
export class ProjectAdapterError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'ProjectAdapterError'
    this.code = code
  }
}

/**
 * Validate and freeze one raw adapter object.
 *
 * Unknown top-level keys are rejected rather than ignored: a silently dropped
 * `risk.high_risk_paths` typo would disable the escalation gate while still
 * looking configured, which is the worst possible failure for a policy file.
 *
 * @param {unknown} raw - parsed JSON.
 * @param {string} source - path the object came from, for error messages.
 * @returns {Readonly<object>} the frozen adapter.
 * @throws {ProjectAdapterError}
 */
export function validateProjectAdapter(raw, source = '<memory>') {
  const fail = (detail) => {
    throw new ProjectAdapterError(
      `project adapter at ${source} is invalid: ${detail}`,
      PROJECT_CODES.INVALID,
    )
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('top level must be a JSON object')
  }

  const allowedKeys = new Set([
    'schema_version',
    'project',
    'capabilities',
    'executors',
    'risk',
    'authority',
    'engineering',
    'memory',
    'checkpoint',
  ])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`unknown top-level key "${key}"`)
  }

  const project = raw.project
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    fail('"project" must be an object')
  }
  if (typeof project.id !== 'string' || project.id.trim() === '') {
    fail('"project.id" must be a non-empty string')
  }

  const capabilities = raw.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string' || c === '')) {
    fail('"capabilities" must be an array of non-empty strings')
  }

  const executors = raw.executors ?? {}
  if (executors === null || typeof executors !== 'object' || Array.isArray(executors)) {
    fail('"executors" must be an object mapping capability to executor list')
  }
  for (const [capability, names] of Object.entries(executors)) {
    if (!capabilities.includes(capability)) {
      fail(`"executors" names capability "${capability}" which is not in "capabilities"`)
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n === '')) {
      fail(`"executors.${capability}" must be an array of non-empty strings`)
    }
  }

  const risk = raw.risk ?? {}
  if (risk === null || typeof risk !== 'object' || Array.isArray(risk)) {
    fail('"risk" must be an object')
  }
  const highRiskPaths = risk.high_risk_paths ?? []
  if (!Array.isArray(highRiskPaths) || highRiskPaths.some((p) => typeof p !== 'string' || p === '')) {
    fail('"risk.high_risk_paths" must be an array of non-empty strings')
  }
  if (risk.default_level !== undefined && !RISK_LEVELS.includes(risk.default_level)) {
    fail(`"risk.default_level" must be one of ${RISK_LEVELS.join(', ')}`)
  }

  const memory = raw.memory ?? {}
  if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
    fail('"memory" must be an object')
  }
  const allowedMemoryScopes = ['current_project', 'global_reusable', 'foreign_project', 'unknown']
  const allowScopes = memory.allow ?? ['current_project', 'global_reusable']
  if (!Array.isArray(allowScopes) || allowScopes.some((s) => !allowedMemoryScopes.includes(s))) {
    fail(`"memory.allow" entries must be within ${allowedMemoryScopes.join(', ')}`)
  }

  return Object.freeze({
    schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : 1,
    project: Object.freeze({ id: project.id, title: project.title ?? project.id }),
    capabilities: Object.freeze([...capabilities]),
    executors: Object.freeze(
      Object.fromEntries(
        Object.entries(executors).map(([k, v]) => [k, Object.freeze([...v])]),
      ),
    ),
    risk: Object.freeze({
      high_risk_paths: Object.freeze([...highRiskPaths]),
      default_level: risk.default_level ?? 'low',
    }),
    engineering: Object.freeze({ ...(raw.engineering ?? {}) }),
    memory: Object.freeze({
      allow: Object.freeze([...allowScopes]),
      deny_as_project_fact: Object.freeze([...(memory.deny_as_project_fact ?? ['foreign_project', 'unknown'])]),
    }),
    authority: Object.freeze({ ...(raw.authority ?? {}) }),
    checkpoint: Object.freeze({ ...(raw.checkpoint ?? {}) }),
  })
}

/**
 * Load a project adapter from an already-read JSON string.
 *
 * Kept separate from filesystem access so the module stays testable and so the
 * caller (lib/index.js) owns the `ctx.fs` read — the runtime must not grow a
 * second way to reach the disk.
 *
 * @param {string} text - raw JSON text.
 * @param {string} [source]
 * @returns {Readonly<object>}
 * @throws {ProjectAdapterError}
 */
export function loadProjectAdapterFromText(text, source = '<memory>') {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ProjectAdapterError(
      `project adapter at ${source} is not valid JSON: ${detail}`,
      PROJECT_CODES.INVALID,
    )
  }
  return validateProjectAdapter(parsed, source)
}

/**
 * Does one candidate path fall in a project-declared high-risk path?
 *
 * Matching reuses the write-scope matcher rather than reimplementing path
 * comparison, so `SRC/BOOT.C` and `src/boot.c` cannot disagree between the
 * escalation gate and the write gate.
 *
 * @param {string} candidate - path to test.
 * @param {readonly string[]} highRiskPaths - project-declared patterns.
 * @param {{foldCase?: boolean}} [options]
 * @returns {boolean}
 */
export function isHighRiskPath(candidate, highRiskPaths, options = {}) {
  if (!Array.isArray(highRiskPaths) || highRiskPaths.length === 0) return false
  return createWriteScope(highRiskPaths, options).allows(candidate)
}

/**
 * Resolve the declared execution mode against project-defined risk.
 *
 * @param {object} input
 * @param {string} input.declared_mode - mode the model declared.
 * @param {string} [input.reason] - the model's stated basis.
 * @param {readonly string[]} [input.target_paths] - paths the work will touch.
 * @param {Readonly<object>} input.adapter - validated project adapter.
 * @param {boolean} [input.irreversible] - caller-observed irreversibility.
 * @param {boolean} [input.ambiguous] - caller-observed requirement ambiguity.
 * @param {{foldCase?: boolean}} [options]
 * @returns {{
 *   mode: string,
 *   declared_mode: string,
 *   escalated: boolean,
 *   escalated_from?: string,
 *   risk: string,
 *   reason: string,
 *   code?: string
 * }}
 * @throws {ProjectAdapterError} on an unknown declared mode.
 */
export function resolveExecutionMode(input, options = {}) {
  const { declared_mode: declaredMode, adapter } = input
  if (adapter === undefined) {
    throw new ProjectAdapterError('resolveExecutionMode requires a validated adapter', PROJECT_CODES.INVALID)
  }
  if (!EXECUTION_MODES.includes(declaredMode)) {
    throw new ProjectAdapterError(
      `unknown execution mode "${declaredMode}"; expected one of ${EXECUTION_MODES.join(', ')}`,
      PROJECT_CODES.UNKNOWN_MODE,
    )
  }

  const targets = input.target_paths ?? []
  const offending = targets.filter((path) =>
    isHighRiskPath(path, adapter.risk.high_risk_paths, options))

  // A high-risk path forces the top tier regardless of what was declared. This
  // is the outline's §5/§6 gate: semantic impact decides, file count never does.
  if (offending.length > 0 && declaredMode !== 'high_risk_task') {
    return {
      mode: 'high_risk_task',
      declared_mode: declaredMode,
      escalated: true,
      escalated_from: declaredMode,
      risk: 'high',
      reason:
        `declared ${declaredMode}, but ${offending.length} target path(s) fall in a `
        + `project-declared high-risk path: ${offending.join(', ')}`,
      code: PROJECT_CODES.ESCALATION_REQUIRED,
    }
  }

  const risk = modeToRisk(declaredMode)

  // Irreversibility and ambiguity are recorded, not auto-escalated: the model
  // may legitimately handle an ambiguous requirement with a cheap process when
  // the change is small and reversible. Surfacing the fact keeps the decision
  // auditable without letting code invent a policy the project never declared.
  const flags = []
  if (input.irreversible === true) flags.push('IRREVERSIBLE')
  if (input.ambiguous === true) flags.push('AMBIGUOUS')

  const suffix = flags.length > 0 ? ` [${flags.join('+')}]` : ''
  return {
    mode: declaredMode,
    declared_mode: declaredMode,
    escalated: false,
    risk,
    reason: `${input.reason ?? 'no basis recorded'}${suffix}`,
  }
}

/**
 * The risk level a mode implies. The inverse of {@link modeForRisk}, defined
 * from the same table so the two can never disagree.
 *
 * @param {string} mode
 * @returns {string}
 */
export function modeToRisk(mode) {
  for (const [risk, mapped] of Object.entries(RISK_TO_MODE)) {
    if (mapped === mode) return risk
  }
  throw new ProjectAdapterError(`unknown execution mode "${mode}"`, PROJECT_CODES.UNKNOWN_MODE)
}

/**
 * The mode a risk level maps to. Exported so the coordinator and the model-facing
 * prompt read one table instead of two.
 *
 * @param {string} risk
 * @returns {string}
 */
export function modeForRisk(risk) {
  const mode = RISK_TO_MODE[risk]
  if (mode === undefined) {
    throw new ProjectAdapterError(
      `unknown risk level "${risk}"; expected one of ${RISK_LEVELS.join(', ')}`,
      PROJECT_CODES.INVALID,
    )
  }
  return mode
}

/**
 * Order two modes by process weight. Used for escalation checks
 * (`escalated_from` must be strictly lower than `mode`).
 *
 * @param {string} mode
 * @returns {number}
 */
export function modeRank(mode) {
  const index = EXECUTION_MODES.indexOf(mode)
  if (index === -1) {
    throw new ProjectAdapterError(`unknown execution mode "${mode}"`, PROJECT_CODES.UNKNOWN_MODE)
  }
  return index
}
