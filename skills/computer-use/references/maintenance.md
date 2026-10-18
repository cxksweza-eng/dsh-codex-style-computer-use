# Maintenance and storage

## Evidence for a regression result

Record the exact model/provider, loaded plugin version, test time and tool calls for each run. Count tools actually reached, including batch substeps; skipped steps and protection refusals are not functional passes. Do not merge an earlier model/build's results into a new run's coverage. A tool receipt proves dispatch/return; verify the intended effect with a readback. Opposite scroll commands do not prove restoration at a scroll boundary.

For vision, use a fresh image whose answer is absent from text, filenames and UIA; check both the image block and the model's answer. A model saying it cannot see is not a transport trace. For marks/stability, distinguish changed pixels from changed geometry and control the suspected animation before assigning a cause. `lastDiffPct` describes the final sample pair, not the whole wait. Read current virtual-screen bounds before diagnosing multi-monitor or off-screen coordinates.

## Driving the worker from a shell (debugging, calibration)

`worker.exe --op <op> '<json-args>'` runs one op with no stdin — the fastest way to test the input
path without the plugin. Two traps, both of which look like product bugs:

- **Use PowerShell 7, never 5.1.** PS 5.1 mangles argv containing quoted strings (`{"combo":"ctrl+a"}`
  arrives as `{combo:ctrl+a}`) and the worker answers `bad json` — which reads exactly like "typing
  never works". Number-only args survive, so the failure looks intermittent.
- **Never name a function parameter `$Args`.** It collides with PowerShell's automatic `$args` and
  silently arrives empty; the worker then gets no arguments at all (`window not found`).

## Deploying a change to this plugin (learned the hard way)

A tool that fails AFTER doing its work is the most expensive kind: the screenshot exists, the click
already landed, and the model cannot proceed.

- **Never ship an optional key with an `undefined` value** — the harness rejects the result as
  "value is not lossless JSON". The tool layer normalises every result through a JSON round-trip, so
  this cannot recur; do not rely on it for a tool returning buffers/NaN.
- **After a JS-layer change, verify BEFORE asking for the host restart:** `node
  build/verify-tools-schema.mjs` (must exit 0 — it loads the REAL dsh-tools DSL and registers every
  tool) and `node scripts/measure-tool-tokens.mjs --no-baseline` (tool-definition cost; without
  `--no-baseline` it overwrites the baseline you are diffing against). Then one real call per new
  tool.
- Worker (C#) changes load after the resident process is replaced. Verify DSH is idle, back up and
  check the deployed bytes, then stop only the identified idle worker; never interrupt an active task for a build check.
- The tool definitions are paid for on every request: keep new tools few, parameters fewer, and put
  prose in this skill instead.

## Storage hygiene

Plugin screenshots have unique filenames and an owned-shots.jsonl manifest recording content hashes. scripts/cleanup-owned-shots.mjs <computer-use-data-root> <ISO-created-before> previews eligible files; --apply removes only recorded, unchanged plugin images. Keep images needed as deliverables or evidence outside that cleanup selection.

Do not infer ownership from a prefix, age, extension or folder name. DSH attachments, user files, worker caches, backups and workspace scratch are not included in this cleanup. Record other task-created files explicitly before proposing their scoped cleanup. Do not use the legacy broad cleanup-computer-use.ps1 for routine task cleanup.

## Where lessons go (keep this file GENERAL)

This file is the transferable manual. Two other places exist on purpose:

| kind of finding | where | examples |
|---|---|---|
| **general, transfers between tasks** | **this file** | the channel ladder, the witness rule, the tiling trick, the Ant traps |
| **task-level** (this site, this form, this machine) | `tasks/<date>-<task>/notes.md`, updated at meaningful checkpoints or handover | "this portal's 增加 button is at x≈1620", "the row re-sorts after save", "this PDF is locked", "the TXT source is at D:\…" |
| **measured geometry for a window/epoch** | `tasks/<date>-<task>/screen-model.md` | column x, row pitch, icon x, popup offsets + their witness |

Record facts needed to resume at meaningful checkpoints; no per-action journal is required. If a
task finding turns out to generalise, promote it into this file and delete it from the task notes;
if a task folder grows rules that only apply to one form, that is correct — do not promote them.
