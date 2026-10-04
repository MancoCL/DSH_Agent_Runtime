/**
 * The `gac_scope` tool: declare and inspect a session's write scope.
 *
 * @module dsh-gac-runtime/tool-scope
 *
 * WHY THIS TOOL EXISTS
 * --------------------
 * The write-scope gate is only as real as its scope source. Until the
 * coordinator can derive a scope from a task DAG, something must be able to
 * declare one, or the gate can never fire and its behaviour stays unproven.
 *
 * This tool is that source, and it is deliberately the *whole* source: the
 * coordinator will later reuse this same seam, so the guard never learns about
 * two different ways a scope comes into existence.
 *
 * THE DESCRIPTION IS PART OF THE MECHANISM, NOT DOCUMENTATION
 * ----------------------------------------------------------
 * A guard the model does not understand produces a retry loop: it attempts an
 * out-of-scope write, is refused, and attempts a variation. So the tool text
 * states the enforcement consequence plainly — that scope covers exactly the
 * declared paths, that a shell command is refused outright while a scope is
 * active, and that an empty scope means nothing may be written. Stating a limit
 * the runtime enforces is what lets the model plan within it instead of
 * discovering it by collision.
 *
 * The options are built by {@link scopeToolOptions} rather than inline so that
 * the runtime's authoring helper can be applied to them in a test, without a
 * live harness — the parameter DSL is validated by that helper, not by this
 * module, so a mistake in it is only findable by running it through.
 */

/** Tool name as the model sees it. */
export const SCOPE_TOOL_NAME = 'gac_scope'

/**
 * Build the authoring options for the `gac_scope` tool.
 *
 * @param {object} deps
 * @param {object} deps.core - a `createGacCore` result.
 * @returns {object} options ready for the runtime's `defineTool`.
 */
export function scopeToolOptions({ core }) {
  return {
    name: SCOPE_TOOL_NAME,
    description:
      'Declare the exact set of paths this task is allowed to modify, so out-of-scope writes '
      + 'are refused before they happen rather than discovered afterwards. '
      + 'Call it before editing files, and again when moving to a different part of the task. '
      + 'The scope is a strict list: `src/mod.c` permits that one file, `src/` permits that whole '
      + 'subtree, and `mod.c` permits only ./mod.c (never src/mod.c). Path matching is '
      + 'case-insensitive, so a differently-cased path is the same file. '
      + 'While a scope is active, a shell command is refused entirely (its file effects cannot be '
      + 'checked), an unrecognised tool is refused, and a write outside the scope is refused. '
      + 'An empty scope permits no writes at all. Inspect the current scope with no arguments.',
    parameters: {
      // Every parameter is optional, so none carries a `required` marker: the
      // runtime's authoring DSL accepts `required: true` or the key's absence,
      // and rejects `required: false` outright. Omitting it IS how a parameter
      // is declared optional.
      scope: {
        type: 'array',
        description:
          'Paths this task may write. Use a trailing "/" for a directory subtree. '
          + 'Omit together with task_id to only inspect the current scope.',
        items: { type: 'string' },
      },
      task_id: {
        type: 'string',
        description: 'Task identifier this scope belongs to. Required when declaring.',
      },
      node_id: {
        type: 'string',
        description: 'Task node identifier this scope belongs to. Defaults to the task id.',
      },
      clear: {
        type: 'boolean',
        description: 'Release the scope and return this session to ungoverned.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          governed: { type: 'boolean', required: true },
          task_id: { type: 'string' },
          node_id: { type: 'string' },
          scope: { type: 'array', required: true, items: { type: 'string' } },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    /**
     * Declare, inspect or release the calling session's write scope.
     *
     * Declared `async` on purpose: DSH's execution contract is a promise, so a
     * synchronous throw here would surface as an unhandled rejection in the
     * pipeline instead of a tool error the model can read and act on.
     *
     * @param {object} args
     * @param {{agent?: {session?: {id?: string}}}} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('gac_scope requires an owning agent session')
      }

      if (args.clear === true) {
        const wasGoverned = core.clearScope(sessionId)
        return {
          governed: false,
          scope: [],
          summary: wasGoverned
            ? 'Write scope released. This session is ungoverned, so no write is checked.'
            : 'No write scope was declared for this session.',
        }
      }

      const declaring = args.task_id !== undefined || Array.isArray(args.scope)
      if (!declaring) {
        const view = core.inspect(sessionId)
        const scope = view.declaration?.write_scope ?? []
        return {
          governed: view.governed,
          ...(view.governed
            ? { task_id: view.declaration.task_id, node_id: view.declaration.node_id }
            : {}),
          scope,
          summary: view.governed
            ? `Task ${view.declaration.task_id} node ${view.declaration.node_id} may write `
              + `[${scope.join(', ') || 'nothing'}]. Shell commands and unknown tools are refused `
              + 'while this scope is active.'
            : 'No write scope is declared, so no write is being checked.',
        }
      }

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        throw new Error('gac_scope: `task_id` is required when declaring a scope')
      }
      const scope = Array.isArray(args.scope) ? args.scope : []
      const declaration = core.declareScope({
        session_id: sessionId,
        task_id: args.task_id,
        node_id: typeof args.node_id === 'string' && args.node_id !== '' ? args.node_id : args.task_id,
        write_scope: scope,
      })

      return {
        governed: true,
        task_id: declaration.task_id,
        node_id: declaration.node_id,
        scope: [...declaration.write_scope],
        summary: scope.length === 0
          ? `Task ${declaration.task_id} declared an EMPTY write scope: every write is now `
            + 'refused, as are shell commands and unknown tools. Declare the paths this task '
            + 'owns, or clear the scope.'
          : `Task ${declaration.task_id} node ${declaration.node_id} may now write `
            + `[${scope.join(', ')}]. Writes outside this list are refused before execution, `
            + 'as are shell commands and unrecognised tools.',
      }
    },
  }
}

/**
 * Build a registry-ready `gac_scope` ToolDefinition.
 *
 * @param {object} deps
 * @param {object} deps.core - a `createGacCore` result.
 * @param {(options: object) => object} deps.defineTool - the runtime's authoring helper.
 * @returns {object}
 */
export function createScopeTool({ core, defineTool }) {
  return defineTool(scopeToolOptions({ core }))
}
