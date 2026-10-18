# Changelog

All notable changes to this project are documented here.
This project does not yet follow a formal versioning policy beyond semver.

## [1.2.1] - 2026-10-19

### Added
- `browser_press`: CDP keyboard tool for the attached page (17-key allowlist).
- `cycle-lifecycle`: pure cycle-end decision module, so the border lifecycle is
  testable without a host.

### Fixed
- **Activity border could stay lit after a task ended.** A completed turn did not
  end its own cycle, and a suppressed turn-end card left nothing to cut the
  border. A completed turn now ends the cycle it owns; a residue path clears the
  native light when the JS gate already considers the cycle finished.
- **Clipboard chords without a target asked for approval and then refused.** They
  are now denied *before* a card is shown, and a role-only target is rejected as
  not specific enough.
- **Observer leaked control values.** `accName()` no longer falls back to
  `input.value`, so an unlabelled field cannot echo what was typed.
- **Value digests were brute-forceable.** They are now salted with a per-process
  value, so a low-entropy secret cannot be enumerated from a log.

### Changed
- `registry.dispatches` is documented as *claims of the single dispatch slot*;
  `dispatchClaimed` and `sideEffectSent` were added so the two facts are not
  conflated.

## [1.2.0] - 2026-10-16

### Added
- `browser_type`, `browser_click`, `browser_navigate`, `browser_observe`,
  `browser_verify`, `browser_open`, `browser_tabs`.
- D4 correlation: audit `hostCallId` and registry `actionId` are joinable.

### Fixed
- Plugin failed to load at all (four cascading defects swallowed by the plugin
  loader).
- Browser actuation bypassed the policy gate.
- `not-dispatched` outcomes were recorded as `FAILED` instead of `CANCELLED`.

## [1.0.0] - 2026-10-16

### Added
- Initial release: native worker, UIA/Win32 input, screenshot capture, approval
  hold, human handoff detection, action registry.