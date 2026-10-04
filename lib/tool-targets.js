/**
 * Which tool calls write which paths.
 *
 * @module dsh-gac-runtime/tool-targets
 *
 * This module answers one question — "what files would this tool call touch?"
 * — and it answers it from the tool's *declared arguments*, never from its
 * name or its description text. Two consequences are deliberate:
 *
 *  1. The classification is a closed table plus an explicit unknown case.
 *     A tool this table does not know is NOT assumed safe. Widening a runtime
 *     must never silently widen its authority (outline §20, §22), so an
 *     unrecognised tool is reported as `unknown` and the caller decides.
 *
 *  2. Shell executors (`pwsh`, `bash`) are classified as `shell`, not as
 *     `write`, and yield NO paths. That is a truthful statement of the DSH
 *     boundary established in the adaptation plan §7: a guard on the tool
 *     pipeline cannot see a redirection target buried in a command string.
 *     Reporting them as "no targets" rather than inventing a parse would let
 *     this module claim a guarantee it cannot provide.
 *
 * The caller must not treat an empty target list as proof of harmlessness for
 * `shell` and `unknown`; see `classifyCall`, which names the verdict so no
 * downstream reader has to infer it from an empty array.
 */

/**
 * Tools that mutate files, mapped to the argument names that carry a path.
 *
 * Both `file_path` and `path` are listed wherever a tool family is known to
 * use either spelling. Listing a name a given tool does not use costs nothing
 * (the argument is simply absent); omitting one loses enforcement for that
 * tool, which is the expensive direction.
 */
const WRITE_TOOLS = Object.freeze({
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace: ['file_path', 'path'],
  apply_patch: ['file_path', 'path'],
  create_file: ['file_path', 'path'],
  delete_file: ['file_path', 'path'],
  move_file: ['file_path', 'path', 'destination', 'to'],
})

/**
 * Tools that touch no file, listed so the unknown case stays meaningful.
 *
 * `gac_scope` belongs here and its absence was a real defect: a scope that
 * cannot be inspected or released is a trap, and the guard refused the one tool
 * able to release it. It only ever mutates an in-memory registry, so it has no
 * filesystem effect to police.
 *
 * Any tool added here is asserting "this cannot write", which is a stronger
 * claim than "this is read-only" — a tool that can modify files must never be
 * listed, however harmless its name looks.
 */
const READ_TOOLS = Object.freeze([
  'read',
  'glob',
  'grep',
  'read_image',
  'list_dir',
  'search',
  'web_fetch',
  'web_search',
  'ask_user_question',
  'todo_write',
  'list_agents',
  'job_list',
  'job_output',
  // GAC's own scope tool: mutates an in-memory registry, never a file.
  'gac_scope',
])

/** Tools that execute a command string and can therefore write invisibly. */
const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'shell', 'run_terminal'])

/** Verdicts a classified call can carry. */
export const CALL_KINDS = Object.freeze({
  WRITE: 'write',
  READ: 'read',
  SHELL: 'shell',
  UNKNOWN: 'unknown',
})

/**
 * Coerce one declared argument into a path string.
 *
 * Non-strings are dropped rather than stringified: `${value}` on an object
 * yields "[object Object]", which would then be normalised and compared as if
 * it were a path — a silently wrong answer instead of a visible gap.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function asPath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Extract every path argument from one tool call.
 *
 * @param {string} name - the tool name as the registry knows it.
 * @param {unknown} args - the parsed arguments object.
 * @returns {string[]} declared paths, in argument-declaration order.
 */
export function extractPaths(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const keys = WRITE_TOOLS[name]
  if (keys === undefined) return []
  const found = []
  for (const key of keys) {
    const value = asPath(args[key])
    if (value !== undefined && !found.includes(value)) found.push(value)
  }
  return found
}

/**
 * Classify one tool call.
 *
 * @param {string} name - the tool name.
 * @param {unknown} args - the parsed arguments.
 * @returns {{
 *   kind: string,
 *   name: string,
 *   paths: readonly string[],
 *   guarded: boolean,
 *   reason?: string
 * }}
 *   `guarded` says whether a write-scope check can be meaningfully applied:
 *   only `write` calls carry a path a guard can inspect. `shell` and `unknown`
 *   are explicitly un-guarded, and the caller is expected to surface that gap
 *   rather than paper over it.
 */
export function classifyCall(name, args) {
  const toolName = typeof name === 'string' ? name : ''

  if (WRITE_TOOLS[toolName] !== undefined) {
    const paths = extractPaths(toolName, args)
    if (paths.length === 0) {
      // A known write tool with no usable path argument. This is reachable if
      // an upstream layer renamed the field; treating it as harmless would be
      // the exact silent-widening failure this module exists to prevent.
      return {
        kind: CALL_KINDS.WRITE,
        name: toolName,
        paths: [],
        guarded: false,
        reason: `tool "${toolName}" is a write tool but carried no readable path argument`,
      }
    }
    return { kind: CALL_KINDS.WRITE, name: toolName, paths, guarded: true }
  }

  if (SHELL_TOOLS.includes(toolName)) {
    return {
      kind: CALL_KINDS.SHELL,
      name: toolName,
      paths: [],
      guarded: false,
      reason:
        `tool "${toolName}" runs a command string; a redirection or generator `
        + 'target inside it is not visible to a tool-pipeline guard',
    }
  }

  if (READ_TOOLS.includes(toolName)) {
    return { kind: CALL_KINDS.READ, name: toolName, paths: [], guarded: false }
  }

  return {
    kind: CALL_KINDS.UNKNOWN,
    name: toolName,
    paths: [],
    guarded: false,
    reason: `tool "${toolName}" is not in the known table, so its write behaviour is unknown`,
  }
}

/**
 * The tool names this module recognises, for tests and for a diagnostics view.
 *
 * @returns {{write: readonly string[], read: readonly string[], shell: readonly string[]}}
 */
export function knownTools() {
  return {
    write: Object.keys(WRITE_TOOLS),
    read: [...READ_TOOLS],
    shell: [...SHELL_TOOLS],
  }
}
