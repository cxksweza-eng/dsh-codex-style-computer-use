# Shared keyboard and clipboard

The desktop is shared state. A successful input receipt still needs a readback of the intended field.

## Chords

`KEY_ALREADY_DOWN` means a key in the requested chord was held before dispatch. No chord keys were sent. Do not release the human's key or keep retrying while they are using it.

The worker records successful downs in each chord. Failure or cancellation releases those keys in reverse order through the cleanup path, which remains available when ordinary input is stopped. `KEY_CLEANUP_FAILED` means Windows did not accept at least one cleanup release; do not claim that all keys are up. Normal sends and cleanup releases retain the agent's input stamp.

The accepted-input ledger covers native keys, Unicode packets and mouse buttons. Cleanup is idempotent and transfers a key/button to a physical user who holds it. Failed releases remain owned for a later cleanup attempt. See lifecycle.md for the immediate yield / 2-second waiting / 3-second quiet contract. Deterministic tests and real-input evidence are recorded separately.

## Preserved paste

With clipboard preservation enabled (the core's default), the worker snapshots supported formats before changing anything. Unicode/plain text, standard HGLOBAL data formats, and selected registered formats such as RTF/HTML are supported. Unknown/private formats, GDI handle formats or oversized snapshots refuse before clipboard mutation. No format is silently dropped to make a snapshot fit.

Comparison and restoration happen under one exclusive clipboard lock. A different sequence number means another writer changed the clipboard, even if its text looks identical; that new content wins. An initially empty clipboard is restored to empty. `clipboardRestore` reports `restored`, `skipped-changed`, `restore-failed` or `not-requested`.

If automatic typing selected paste and receives `CLIPBOARD_PRESERVATION_UNAVAILABLE` with `outcome:not-dispatched`, the core may use Unicode input and reports `modeFallback:clipboard-preservation-unavailable`. An explicit paste request, a changed clipboard, an interruption or an unknown outcome never triggers this fallback. This does not guarantee that a particular editor accepts Unicode input; verify its value.

There is an unavoidable interval between releasing the clipboard lock and the receiver reading a paste. A human copy during that interval can change what is pasted. A clipboard conflict or restoration warning therefore needs a target-value readback; do not replay text merely because restoration failed.

## Evidence boundary for the 1.1.2-rc.2 candidate

The original production methods were executed with injected devices: three of four send-failure positions left keys held, concurrent copy was overwritten, and rich-text format was lost. The candidate's complete C# source compiles with the Windows legacy C# 5 compiler; production scopes, the interruptible hold loop and the core's fallback are covered by fault-injection tests.

These are not native clipboard or physical keyboard passes. Creating a private named window station was denied (Win32 5); an unnamed CREATE_ONLY attempt refused an already-existing station (183). Tests did not access the user's clipboard, inject desktop input, or weaken isolation. This paragraph describes the historical rc.2 test boundary; current installation and native evidence belong to each release report.
