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
| 3 | `lib/coordinator.js` — DAG, ready nodes, state transitions | done (logic) |
| 3 | `lib/task-store.js` + `lib/tool-task.js` — durable task records, `gac_task` | done |
| 3 | `lib/capability-router.js` + `lib/executor.js` — dispatch actually invokes | done |
| 4 | `lib/verification.js` — plan, falsification, traceability gates | done |
| 4 | Plan and evidence gates wired into `gac_task` | done |
| 5 | `lib/grilling.js` — multi-round requirement refinement | done |
| 5 | `lib/contract.js` — interface contract freeze | done |
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

## The coordinator (`lib/coordinator.js`)

Pure logic, and the module the rest of the runtime will be driven by. It is
written and tested ahead of any tool that exposes it, because the rules it
enforces are the ones worth getting exactly right in isolation.

Three properties are structural rather than conventional:

**An executor never declares completion.** `applyResult` accepts a structured
result and decides the transition from an explicit table. `completed` and
`superseded` appear in no table's *source* position, so "a terminal state cannot
be moved by a late result" is a property of the table itself, not a check
scattered across branches.

**Attempts are never reused.** Every dispatch mints a new identity
(`attempt`, `dispatch_id`). A result whose `dispatch_id` does not match the
node's active execution is classified `stale` and changes nothing — otherwise a
late result from a previous attempt would look like the current one and rewrite
state it has no claim to.

**Parallelism is decided by facts, not intent.** A node is *ready* when its
dependencies are complete; it joins the execution *batch* only if its write scope
is disjoint from every in-flight and same-batch node AND it shares no exclusive
resource. Ready-but-not-batched is reported with a reason, so "why is this not
running" has an answer.

```text
compileTask(plan)   → validate: existence, cycles, non-empty capabilities,
                      declared write scope. Rejects before any file is touched.
resolveReady(task)  → { ready, batch, reason }
dispatch(task, ids) → new attempt + dispatch identity per node
applyResult(t, r)   → { classification: accepted | stale | rejected }
reopen(t, id, why)  → a reason is mandatory; terminal states move only explicitly
nextAction(task)    → dispatch | await | blocked | repair | complete_task | done
```

Note that `await` is deliberately distinct from `blocked`: waiting on a
subagent you dispatched is internal, and recording it as an external blockage
would hide the difference between "the world is preventing progress" and "my own
work is still running".

### Driving it: `gac_task`

```text
gac_task { action: "create", task_id: "REQ-1", mode: "standard_task",
           plan: { nodes: [
             { id: "T1", objective: "implement", required_capabilities: ["implementation"],
               write_scope: ["src/"] },
             { id: "T2", objective: "verify", depends_on: ["T1"],
               required_capabilities: ["verification"], write_scope: [] } ] } }

gac_task { action: "advance", task_id: "REQ-1" }
  → action: dispatch, nodes: ["T1"]      the tool minted dispatch_id REQ-1-T1-A1

gac_task { action: "advance", task_id: "REQ-1",
           report: { node_id: "T1", dispatch_id: "REQ-1-T1-A1", status: "completed" } }
  → classifications: ["accepted"], action: dispatch, nodes: ["T2"]
```

**You cannot declare completion.** A report must carry the `dispatch_id` minted
when the node was dispatched. A report without it — or with a stale one — is
classified `stale` and changes nothing, because a late result from a previous
attempt must not rewrite state it has no claim to. That rule is the whole reason
the identity exists, so it is enforced at the tool boundary and not merely
documented.

Task records live in `<project>/.dsh/gac/tasks/`, one file per task, and are
re-validated on load by the same code that validates a new plan. That is
deliberate: a hand-edited record would otherwise be able to bypass `compileTask`
and introduce a cyclic or capability-less DAG. Two consistency rules are checked
on load — a node `in_progress` must hold a dispatch identity, and a node not
`in_progress` must not — because either inversion leaves a task that can never
make progress again.

Tasks are keyed by **project**, not by session: one requirement's nodes are
advanced by different executors, and a session-scoped record would be invisible
to whoever picks up the next node.

### Dispatch actually invokes

`advance` does not merely record that a node should run — it routes the node by
its `required_capabilities` and invokes the executor:

```text
advance → routes T1 (implementation) to builder, T2 (verification) to verifier
        → invokes, applies the returned status, then re-decides the next action
advance → complete_task
complete { evidence: { all_criteria_covered: true } } → completed
advance → done
```

Four properties make that honest rather than decorative:

**Routing prefers the tightest fit.** Among executors covering the required
capabilities, the one with the *fewest extras* wins, so a generalist does not
absorb every node — otherwise capability declarations would be decorative and
verification independence impossible. A node no single executor covers is
rejected before any file is touched, naming the gap (`拆节点`, split the node —
do not declare an executor omnipotent).

**An in-process call cannot write.** It has no write tools, so it serves only
nodes whose `write_scope` is empty and *declines* the rest. A node that writes
goes to a session executor, which registers it as `in_progress` rather than
fabricating a report about files it never touched.

**`in_progress` is a real answer.** A run still going, or one that could not
start, is not a pass and not a failure. Neither is invented.

**Closing is gated on evidence.** `complete` is refused unless every node is
completed and `all_criteria_covered` is true — a refusal leaves the status
untouched, because half a close-out is harder to unwind than none. Before this
existed, `complete_task` repeated forever and a task could never close.

Provider routes come from the adapter's `execution.provider_routes` (keyed by
executor name — see [Model routing](#model-routing)), so "the verifier runs on a
different model" is configuration rather than convention — which is what makes
independence real instead of nominal.

---

### Independent verification

The question this answers is the only one that matters: **the implementation is
correct — how do we know?** "The tests pass" is not an answer, because the
implementation and its tests come from one understanding, and a wrong
understanding turns both green together.

A plan must be registered **before** the work it judges:

```text
gac_task { action: "plan", task_id: "REQ-1", criteria: ["AC1", "AC2"],
           verification_plan: { cases: [
             { id: "V1", covers: ["AC1"], type: "positive",      expect: "..." },
             { id: "V2", covers: ["AC1"], type: "falsification", expect_failure: "..." } ] } }
```

Three rules are enforced, and each names what is missing rather than counting it:

**Every criterion needs a positive *and* a falsification case.** A positive case
proves the correct implementation passes; a falsification case proves a relevant
wrong one fails. A suite of positives cannot tell "correct" from "assertions too
weak" — so a falsification case must state `expect_failure`, or it degrades into
a weaker positive.

**Evidence must trace criterion → case → execution.** Each case needs its own
executed evidence reference; a bare "passed" is someone asking to be believed.

**Pooled evidence is rejected separately.** One command's output cited as the
evidence for several cases is formally valid — cases complete, criteria covered,
evidence present — yet it is one observation. Counting cannot find it; comparing
the evidence can.

Gates fire where they can still change the outcome:

| Gate | Fires | Why there |
| --- | --- | --- |
| plan required | before dispatching a `verification`/`review` node of a `high_risk_task` | a plan written after implementation derives from the implementation, not the requirement |
| falsification / coverage | at plan registration | a gap reported now is fixed before any file is touched |
| evidence | at `complete` | uses a content-addressed `plan_id`, so a report against a superseded plan is caught |

Plans are stored separately from task records and refuse to be overwritten: their
lifecycles differ — a frozen plan never changes while task state changes every
round — and mixing them would make "has this plan been altered?" hard to answer.

Only the *verification* nodes are held back when the plan is missing; the rest of
the batch still dispatches. Holding the whole batch would collapse "plan, then
implement" into three serial steps and discard the parallelism that is the point.

---

### Requirement refinement (grilling)

The loop is run by fixed code; the questions are asked by the session. "Which
decisions are still unmade" is a semantic judgement that code cannot make, so
**the session supplies the questions**. But "how many rounds happened, what did
each cover, has it converged, did the user confirm" are facts, and those are
recorded here. The model thinks; the runtime attests.

```text
gac_task { action: "grill", grill_action: "status" }                        # what has been asked
gac_task { action: "grill", grill_action: "record",  round: { questions: [...] } }
gac_task { action: "grill", grill_action: "converge" }                      # you think you are done
gac_task { action: "grill", grill_action: "confirm", confirmation: "<用户的原话>" }
```

**The loop does not end on the model's self-assessment.** A model with a wrong
understanding will confidently believe it has asked everything, so the loop ends
only when the *user* says it is enough. Recording `converge` does not end
anything — it states an opinion. `confirm` requires the user's actual words.

**A round must contain both a question and an answer.** An answer of "不知道" is
a real finding and is recorded and reported as unresolved; a *missing* answer is
different from "the user doesn't know", and conflating them loses the distinction
between a decision that is still open and one nobody asked about.

**Round count has no ceiling semantics.** A requirement that genuinely needs five
rounds must get five. The limit is a runaway guard, not a statement that "this
many should be enough".

### Interface contract (freeze before parallel work)

This is what makes "write the implementation and the tests in parallel" more than
a slogan. A test author writing tests does not know what the implementation looks
like. If the two sides invent interfaces independently, the tests fail because the
*interfaces* disagree — a structural failure, not a defect, and one that yields no
information about correctness. Freezing a minimal contract first means both
branches depend only on it: tests derive from **contract + acceptance criteria**
(without reading the implementation), code from **contract + design** (without
reading the tests). Two separated information paths — which is also what makes
verification independence real rather than nominal.

**`behavior` is required, not just `signature`.** With only a signature, "what does
it return" is still a guess, and the guessed expectation is exactly where the two
sides diverge. The behaviour note need not be exhaustive, only sufficient for
someone else to write an assertion from.

**The freeze is a gate before dispatch, and it is declared by the project.** The
adapter states it, so small changes need no ceremony:

```json
"execution": { "require_contract": ["high_risk_task"] }
```

Only *writing* nodes are held back; nodes that just return a report are not. And
like the verification plan, the contract is content-addressed and refuses to be
overwritten — a change after both branches are working against it is precisely the
divergence the freeze exists to prevent.

### Model routing

`execution.provider_routes` is keyed by **executor name** (the names listed in
`executors`), not by capability:

```json
"execution": { "provider_routes": { "verifier": { "provider": "p", "model": "m" } } }
```

Keyed by name because capability routing returns a *name*, and that name has to
find the executor it denotes. Keying by capability and naming executors
`capability:provider/model` meant the lookup never matched and silently fell
through to "whoever supports it" — the declared route was ignored while
everything looked fine. It also lets two executors of the *same* capability use
different models, which is what independence needs.

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
npm test          # 494 tests, no DSH required
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
  capability-router.js  pick an executor by required capabilities (pure)
  contract.js        interface contract: freeze it before parallel work (pure)
  executor.js        execution boundary: invoke, or refuse honestly
  coordinator.js     task DAG, ready resolution, state transitions (pure)
  grilling.js        multi-round requirement refinement (pure)
  task-store.js      durable one-file-per-task store, plans, load-time revalidation
  tool-task.js       the gac_task tool
  verification.js    verification plan, falsification, traceability gates (pure)
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
