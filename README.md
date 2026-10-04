# dsh-gac-runtime

GAC (Governed Agent Collaboration) runtime for DeepSeek Harness.

A DSH plugin that adds **risk-tiered execution modes, a strict write scope, write
claims, and independent verification** on top of the harness kernel. It does not
reimplement scheduling, sessions, subagents or approval — the harness owns those
(see [GAC-DSH-ADAPTATION-PLAN.md](GAC-DSH-ADAPTATION-PLAN.md) §1).

```text
Harness kernel  →  sessions, events, tools, subagents, workflow, approval, sandbox
GAC plugin      →  execution mode, write scope, write claims, verification, evidence
```

---

## Status

| Phase | Component | State |
| --- | --- | --- |
| 0 | `lib/write-scope.js` — strict containment | done, 35 tests |
| 0 | `lib/project.js` — Project Adapter + mode escalation | done, 30 tests |
| 0 | `lib/tool-targets.js` — what counts as a write | done |
| 0 | `lib/plugin.js` — the `tools/pre-execute` gate | done, 28 tests |
| 0.5 | `lib/tool-scope.js` — the `gac_scope` tool | done |
| 0.5 | `lib/index.js` — DSH shell, installed in the `core-020` profile | **verified in a live session** |
| 1 | `lib/project-state.js` — Project Adapter loaded from `.dsh/gac/project.json` | done |
| 1 | `lib/tool-project.js` — `gac_project`: adapter inspection + mode declaration | done |
| 2 | `lib/claims.js` + `lib/claim-store.js` — write claims | done |
| 3 | Coordinator: DAG, ready nodes, STANDARD_TASK | not started |
| 4 | Independent verification: plan, falsification, traceability | not started |
| 5 | Session event projection | not started |
| 6 | Evidence capture and AC traceability | not started |

**Phase 0 is verified, not merely tested.** In a live session with
`scope: ["docs/scratch.md"]`:

| Attempt | Result |
| --- | --- |
| write `docs/scratch.md` (in scope) | allowed, file created |
| write `docs/outside.md` (out of scope) | **refused**, `GAC_WRITE_SCOPE_DENIED` |
| `pwsh` shell write | **refused**, `GAC_SHELL_DENIED_UNDER_SCOPE` |

The decisive check is the filesystem, not the message: neither refused path
existed afterwards. The refusal happens **before** dispatch, which is the
assumption the rest of this architecture rests on.

**Phase 1 is verified in a live session too.** `gac_project` reported the
project, its five declared high-risk paths and its capability vocabulary; then a
`direct_edit` targeting `lib/write-scope.js` was escalated to `high_risk_task`
automatically.

The interesting part is what the model did with that. It had declared
`direct_edit` with a genuine argument (one file, reversible, immediately
verifiable, no interface or migration change) and did not contrive a way around
the escalation:

> This is not a mis-declared mode. The path's high-risk property is declared by
> the project in advance; the declaration step cannot bypass it, and should not
> try to. `lib/write-scope.js` is permission-scope core — changing it directly
> affects which writes are refused, so escalating matches the design intent.

That is the behaviour the tool description is written to produce. A model that
*tried* to guess the gate would sometimes pick heavier process than the work
needs, which is the ceremony the design exists to avoid.

**The guard is inert until a session declares a scope.** Every session starts
ungoverned and the gate allows everything. That is deliberate: a gate that
enforced a scope nobody declared would be unusable outside GAC work.

---

## Install

The plugin resolves DSH packages from the profile, so it must be installed into
a profile rather than imported directly (`lib/resolve-dsh.js` explains why).

```text
plugin_manager { action: install_bundle, target: "<this directory>" }
```

This adds `dsh-gac-runtime` as a `link:` dependency of the active profile and
appends it to `dsh.profile.bundles`. Consequences worth knowing:

- **A restart is required.** The harness HMR entry watches *configuration*, not
  module files (the base bundle sets `root: []` when a launcher supplies a
  profile context). Editing `lib/*.js` therefore does **not** reload the plugin.
  Disabling and re-enabling the entry re-runs `apply` but does **not** re-import
  the module, so it keeps executing the code it loaded at startup — only a
  restart picks up code changes.

  To iterate without restarts, widen the HMR watch roots in the *profile* patch
  (`~/.dsh/profiles/<profile>/cordis.patch.yml`). Use an **absolute path**:

  ```yaml
  - id: hmr
    name: "@deepseek-ai/dsh-hmr"
    config:
      root:
        - D:/WorkSpace/99_Others/02_UserProject/Agent_Runtime
  ```

  A profile patch layer has the highest precedence, so it overrides the base
  bundle's `root: []`. It takes effect on the next restart; afterwards `lib/*.js`
  edits reload on their own.

  Do **not** use `root: ["."]`. Watch roots resolve against `baseDir`, which is
  the profile directory (`dsh-hmr/lib/index.js:319`), so `"."` watches the
  profile and never the plugin — which is linked from outside it. That was this
  file's original advice and it was wrong: it would have looked configured while
  changing nothing.

- Because it is a link, the plugin keeps its own `node_modules` and cannot
  bare-import `@deepseek-ai/*`. `lib/resolve-dsh.js` resolves those from the
  profile directory instead.

### Current state on this machine

Already applied, so future edits to `lib/*.js` reload without a restart:

- `dsh-gac-runtime` is installed into the `core-020` profile as a link to this
  directory.
- `~/.dsh/profiles/core-020/cordis.patch.yml` carries the `hmr` override above.
  A timestamped backup of that file sits beside it.

Still requires a restart: changes to `package.json`, `cordis.patch.yml`, or
anything that alters the set of registered plugins or tools.

### Which profile?

There are two on this machine: `core-020` (the Web GUI) and `tauri` (the desktop
shell). `plugin_manager` installs into the **active** profile. Check with
`plugin_manager { action: list_bundles }` before assuming.

---

## Verify it is running

The plugin writes a JSONL report beside the DSH home directory
(`$DSH_HOME/gac-runtime-report.jsonl`, falling back to the user profile). It is a
file rather than a log line because console output inside a web-served harness
is not reliably visible.

```jsonc
{"event":"plugin-loaded","services":{"tools":true,"sessions":true},
 "scope_tool":"registered",
 "enforcement":"active - a declared scope is enforced before dispatch"}
{"event":"guard-denied","tool":"write","code":"GAC_WRITE_SCOPE_DENIED", ...}
{"event":"plugin-unloaded","observed":{"calls":17,"denials":0}}
```

The `observed.calls` counter on unload is the proof the interception is live: it
counts every tool call the gate saw.

### When the tool does not appear

Read `scope_tool` and `scope_tool_note` in the load report first — the note names
every resolution anchor tried and why each failed. That diagnostic exists because
an earlier build reported only "not resolvable", which sent one debugging session
in the wrong direction twice.

```bash
node scripts/diagnose-resolution.js   # how the anchor list is derived, per-anchor reasons
node scripts/diagnose-import.js       # separates resolution failure from import failure
```

Run `npm test` before restarting: the suite exercises the real `defineTool` when
DSH is present, and catches authoring mistakes that would otherwise surface only
as a missing tool after a restart.

---

## Use

### Declare how much process the work needs

```text
gac_project {}                          # what project am I in, and what does it call risky?
gac_project { mode: "direct_edit", reason: "one config value", target_paths: ["config/app.json"] }
```

Modes, cheapest sufficient process first:

| Mode | Use for | What it commits to |
| --- | --- | --- |
| `read_only` | explain, search, read, analyse | no task record |
| `direct_edit` | one unambiguous, local, reversible change | no task record, no verifier |
| `standard_task` | ordinary bugfix / feature / local refactor | an independent verifier checks the result |
| `high_risk_task` | security, auth, persistent state, migrations, public contracts, boot, production | a verification plan derived from the requirement *before* implementation, then an independent review |

**The mode is cross-checked, not trusted.** Declaring a mode whose `target_paths`
fall in a project-declared high-risk path is escalated to `high_risk_task`
automatically:

```text
gac_project { mode: "direct_edit", reason: "tweak one comparison",
              target_paths: ["lib/write-scope.js"] }
→ Escalated from direct_edit to high_risk_task: declared direct_edit, but 1 target
  path(s) fall in a project-declared high-risk path: lib/write-scope.js.
```

Do not try to pre-empt that check; declare honestly and report what you are told.
A model that guessed at the gate would sometimes pick a heavier process than the
work needs, which is the ceremony the design exists to avoid.

### Declare which paths the task may write

```text
gac_scope { task_id: "REQ-20261004-xyz", scope: ["src/", "docs/api.md"] }
```

While a scope is active, four things are refused before dispatch:

| Attempt | Result | Code |
| --- | --- | --- |
| write outside the declared scope | refused | `GAC_WRITE_SCOPE_DENIED` |
| a shell command (`pwsh`, `bash`) | refused | `GAC_SHELL_DENIED_UNDER_SCOPE` |
| a tool the runtime cannot classify | refused | `GAC_UNGUARDABLE_WRITE_DENIED` |
| a write tool with no readable path argument | refused | `GAC_UNGUARDABLE_WRITE_DENIED` |

```text
gac_scope {}                    # inspect the current scope
gac_scope { clear: true }       # release it, returning to ungoverned
```

### Declaring also claims the paths against other sessions

A declaration is the moment a session says "these paths are mine", so that is
when a cross-session collision is detected. It is not a separate step the model
has to remember — a protection that must be remembered is one that will
eventually be skipped.

```text
session A: gac_scope { task_id: "REQ-1", scope: ["src/"] }
           → governs, and claims src/

session B: gac_scope { task_id: "REQ-2", scope: ["src/a.c"] }
           → REFUSED: declared write scope "src/a.c" overlaps "src/" held by
             task REQ-1 node REQ-1 (session ..., dispatch ...).
```

The refusal names the holder and both paths, so the model can narrow its scope
instead of retrying. B stays **ungoverned** rather than half-declared — a session
governed by a scope it does not own would be a guard enforcing paths it was never
granted.

Claims live in `<project>/.dsh/gac/claims/`, one file per session, so they are
visible to every session and survive a plugin reload. Declaring again replaces
your own scope; it never merges with it. `clear` withdraws the claim.

Scope overlap is compared as **prefix overlap**, not as literal strings, so
`src/` and `src/deep/a.c` collide as they should. The rule deliberately
over-reports in one case: `src/*.c` and `src/*.h` share the prefix `src` and are
treated as conflicting although the sets are disjoint. A false positive costs
some parallelism; a false negative lets two writers hit one file, which cannot be
separated afterwards. See the header of `lib/claims.js`.

### Declare what the project considers risky

`.dsh/gac/project.json` at the project root. Unknown top-level keys are
**rejected**, so a typo in `risk.high_risk_paths` fails loudly instead of
silently disabling the escalation gate:

```json
{
  "schema_version": 1,
  "project": { "id": "my-project", "title": "My Project" },
  "capabilities": ["implementation", "verification"],
  "executors": { "implementation": ["builder"], "verification": ["verifier"] },
  "risk": { "high_risk_paths": ["src/auth/", "src/boot/**"], "default_level": "low" }
}
```

A project with no adapter is **ungoverned**, not broken: `gac_project` reports
it as such, and a declared mode is recorded but marked `NOT cross-checked`.
An **invalid** adapter is not cached, so fixing the file takes effect on the next
call rather than needing a restart.

### Scope semantics

`gac_scope` is a **strict list**, and this is the part worth reading carefully:

```text
scope ["mod.c"]     permits  ./mod.c
                    refuses  src/mod.c, other/mod.c, SRC/MOD.C
scope ["src/"]      permits  src/a.c, src/deep/a.c
                    refuses  src2/a.c, src/../other.c
scope ["src/*.c"]   permits  src/a.c  (and src/deep/a.c — see below)
```

Path comparison normalises separators, resolves `.`/`..`, and **folds case**, so
`SRC/MOD.C` and `src/mod.c` are the same file. A bare basename is an exact file,
never an alias for a same-named file elsewhere.

`*` crosses separators, matching `fnmatch`, so `src/*.c` also covers
`src/sub/a.c`. This is deliberate and preserved for behavioural compatibility.
It is the safe direction: a wider scope *permits* more, so it can never silently
permit a write the project meant to forbid. Do not narrow it without reading the
module header of `lib/write-scope.js`.

---

## Known limits

Stated here rather than discovered later (adaptation plan §7):

1. **Shell writes cannot be guarded.** A redirection or generator target inside
   a command string is not visible to a tool-pipeline guard. Rather than pretend
   otherwise, the gate refuses shell commands entirely while a scope is active.
   Patterns that need shell execution must either run outside a scope or be
   rewired to the structured file tools.
2. **The gate is per tool call, not per process.** A process started before a
   scope was declared is not affected by it.
3. **Scopes are in-memory.** A restart drops every scope; that is the correct
   failure direction, since a stale scope would enforce an authority nobody
   holds. Durable scopes arrive with the coordinator, re-derived from the session
   log. **Claims are durable**, so a crash can leave one behind — it stops
   blocking as soon as its session is no longer live, because a store with a
   liveness predicate prunes it before judging the next conflict. With no
   liveness information at all, claims are kept rather than guessed dead:
   blocking a writer is recoverable, and two writers on one file is not.
4. **Unknown tools fail closed while governed.** A tool added by a harness
   upgrade is refused until it is classified in `lib/tool-targets.js`. This is
   intentional: a runtime upgrade must not silently widen authority.

   This rule produced a real defect, kept here as the worked example. GAC's own
   `gac_scope` was initially unclassified, so once a scope was declared the guard
   refused the one tool able to release it — the scope became a trap. It is now
   classified as touching no file. **Any tool whose enforcement path is itself
   guarded must be provably unable to write**, or it re-creates this deadlock.

---

## Develop

```bash
npm test          # 119 tests, no DSH required
```

The library modules are pure and dependency-injected precisely so the suite runs
without a harness. `test/entry.test.js` additionally asserts the Cordis export
shape and that no module imports a bare `@deepseek-ai/*` package at module scope
(which would throw during evaluation, before any plugin code could report why).

```text
lib/
  index.js           DSH shell: registers the guard and the declaration tools
  plugin.js          the pre-execute gate (fails closed on every unknown)
  write-scope.js     strict path containment — the security boundary
  claims.js          write-claim conflict detection (pure)
  claim-store.js     durable one-file-per-claim store with orphan pruning
  project.js         adapter validation + execution-mode escalation (pure)
  project-state.js   adapter loading, caching, and per-session mode state
  tool-project.js    the gac_project tool
  tool-targets.js    which tool calls write which paths
  tool-scope.js      the gac_scope tool
  session-scope.js   per-session declared scope registry
  path-utils.js      absolute-path and root-prefix helpers
  resolve-dsh.js     resolve @deepseek-ai/* from a linked install
```

Design rules the code follows:

- **One definition site per security decision.** Containment lives in
  `write-scope.js` only, and is unit-tested; the DSH bridge calls it rather than
  re-deriving it. A second implementation would drift.
- **No project facts in the runtime.** No project name, path or capability word
  appears in `lib/`; `test/project.test.js` fails if one does.
- **Failures are explicit.** A denial names the declared scope and carries a
  stable code; a plugin that cannot register half its behaviour says so in the
  load report rather than dropping it silently.

See [GAC-DSH-ADAPTATION-PLAN.md](GAC-DSH-ADAPTATION-PLAN.md) for the full design,
the six real gaps, the boundary conditions, and the phase plan.
