# Phase 0 verification: does the gate actually deny before execution?

The whole GAC architecture rests on one unproven assumption: that a DSH plugin
can stop an out-of-scope write **before it happens**. This is the procedure that
settles it. Run it after a restart, because the harness watches configuration
rather than module files and will otherwise still be running an older build.

If this procedure fails, nothing downstream matters — do not build the
coordinator on top of it.

---

## Step 0 — the plugin loaded, with its scope source

```powershell
Get-Content "$env:USERPROFILE\.dsh\gac-runtime-report.jsonl" -Encoding UTF8 | Select-Object -Last 3
```

Expect a `plugin-loaded` record whose `scope_tool` is `registered` and whose
`enforcement` reads `active - a declared scope is enforced before dispatch`:

```jsonc
{"event":"plugin-loaded","services":{"tools":true,"sessions":true},
 "scope_tool":"registered",
 "scope_tool_note":"scope can be declared and is enforced before dispatch",
 "enforcement":"active - a declared scope is enforced before dispatch"}
```

If `scope_tool` is `unavailable` or `failed`, the guard is installed but no
session can be governed. The note field says why. **Stop here** — the rest of
this procedure cannot pass.

Also confirm the previous run's counters, which prove the interception is live:

```jsonc
{"event":"plugin-unloaded","observed":{"calls":17,"denials":0}}
```

`observed.calls` counts every tool call the gate saw. A non-zero value on the
previous unload means the hook is genuinely in the pipeline, not merely
registered.

---

## Step 1 — declare a scope

The scope is **per session**. Declaring it here does not affect any other
session, which is why this step is safe to run in a live GUI.

```text
gac_scope { task_id: "REQ-VERIFY-1", scope: ["docs/scratch.md"] }
```

Expect a summary naming `docs/scratch.md`. If the tool is not found, Step 0
failed or the restart did not happen.

---

## Step 2 — the denial (this is the actual test)

Ask the agent to write a file outside the declared scope:

```text
Write these two files:
  1. docs/scratch.md        (inside the scope)
  2. docs/outside.md        (outside the scope)
```

Expected: `docs/scratch.md` is created; the write of `docs/outside.md` is
refused, and the refusal names the declared scope:

```text
GAC: task REQ-VERIFY-1 node REQ-VERIFY-1 may write [docs/scratch.md].
"docs/outside.md" is outside that scope (declared write scope is [docs/scratch.md]).
```

Confirm from the report that the refusal was recorded:

```powershell
Get-Content "$env:USERPROFILE\.dsh\gac-runtime-report.jsonl" -Encoding UTF8 |
  Select-String 'guard-denied' | Select-Object -Last 3
```

```jsonc
{"event":"guard-denied","tool":"write","code":"GAC_WRITE_SCOPE_DENIED", ...}
```

**The decisive check**: `docs/outside.md` must **not exist** on disk. A denial
that still produced the file is an after-the-fact observation, not a
pre-execution guard, and would mean moving the enforcement to `fs/write-intent`
(a seam that cannot refuse — adaptation plan §7, boundary 3).

```powershell
Test-Path docs/outside.md     # must be False
```

---

## Step 3 — the shell refusal

While the scope is still active:

```text
Run this: echo test > docs/shell-mark.md
```

Expected: refused with `GAC_SHELL_DENIED_UNDER_SCOPE`. This is the honest
boundary, not a bug: a redirection target inside a command string cannot be seen
by a tool-pipeline guard, so the gate refuses the whole class rather than
pretending to check it.

---

## Step 4 — present-path containment (outline §21)

Re-declare with a bare basename and confirm the alias bypass is closed:

```text
gac_scope { task_id: "REQ-VERIFY-2", scope: ["mod.c"] }
```

Then attempt writes to `./mod.c` (allowed), `sub/mod.c` (refused) and
`SRC/MOD.C` (refused — case folding). `sub/mod.c` must not be created.

---

## Step 5 — release and confirm the session is ungoverned again

```text
gac_scope { clear: true }
```

Then repeat an out-of-scope write. It should now succeed, because no session is
governed by default. This step matters as much as the denial: it proves the gate
does not interfere with ordinary work outside a declared task.

---

## Recording the result

The outcome belongs in the repository, not just in a conversation. Update the
status table in `README.md` with what passed and what did not, and note any
refusal that produced a file anyway — that is the one result that invalidates the
approach and must not be smoothed over.

---

## If it fails

| Symptom | Likely cause |
| --- | --- |
| `gac_scope` not found | Plugin not reloaded (restart needed), or Step 0 reported `unavailable` |
| Write succeeds despite a declared scope | The guard is not in the dispatch path; check `observed.calls` increments |
| Refusal appears but the file exists | Enforcement is post-hoc, not pre-execution — the design needs revisiting |
| `scope_tool: unavailable` | `@deepseek-ai/dsh-tools` unresolvable from the linked install; see `lib/resolve-dsh.js` |
| Every write refused | Scope was declared as `[]`, or an earlier `task_id` is still active — inspect with `gac_scope {}` |
