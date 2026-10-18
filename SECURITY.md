# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately through
GitHub Security Advisories on this repository, or by contacting the maintainer
directly. Include reproduction steps and the affected version.

## Threat model (read this before enabling the plugin)

This plugin can drive a Windows desktop and a Chromium browser. That is a
privileged capability, and it is designed around one rule: **the human decides
what may be driven.**

- `automationMode` defaults to `standard`: observation is free, every actuation
  goes through the host approval card.
- `autonomous` and `unrestricted` remove or reduce that prompt. Enable them only
  on a machine you are willing to hand over.
- A physical brake (`Ctrl+Esc`) stops control immediately and holds the machine
  until the human re-arms with `Ctrl+Alt+R`. `Ctrl+Alt+Q` ends the session.
- The browser tools never read a password field's value or selection, and never
  read the clipboard. Values are reported only as a salted length+digest.
- The native worker records an audit trail; it does not record clipboard
  contents, typed text, or page values.

## Known limitations that matter for security

1. **ASKING state has not been verified in a real runtime session.**
2. **Whether the activity border stays visible during HUMAN-HANDOFF is NOT VERIFIED.**
3. **A real clipboard transfer (Ctrl+C / Ctrl+V) has not been through final acceptance.**
4. **One accidental Ctrl+V dispatch occurred during test development. Its actual
   paste side effect is UNKNOWN** — it cannot be claimed that nothing was pasted.

Do not treat absence of a log entry as proof that nothing happened.