// skill-gate.js — "READ THE PROCEDURE BEFORE DRIVING".
//
// The human's rule (2026-09-13, verbatim): "未先读 skill 时拒绝驱动类 op". It exists because an
// agent that skipped the manual improvised its way through a two-call job: it never looked at the
// window list, spent three rounds attacking an occlusion that did not exist (the windows were
// MINIMIZED), guessed taskbar coordinates from a scaled screenshot, and then reported all of it to
// the human as "the environment blocked it".
//
// No tool layer can SEE whether a model read a document. So the receipt is a PHRASE THAT ONLY EXISTS
// INSIDE SKILL.md — the model has to open the file to produce it. That is the strongest honest
// version of "force it to read": not guessable by accident, verifiable by exact string equality, and
// free. build/test-skill-gate.mjs asserts this constant against SKILL.md itself, so the manual and
// the gate can never drift apart (a phrase that lived in only one of the two would either lock the
// agent out forever or let it in without reading anything).
//
// Deliberately NOT in here: any way for the gate to block the safety direction. `computer_ask`, and
// `computer_ctrl {action:"stop"|"exit"}`, are decided by the caller and never gated — a gate that can
// block a brake is worse than no gate.

import { ACTUATION_TOOLS } from './policy.js'

export const REQUIRED_PHRASE = 'A MINIMIZED window is not an occluded window'

export const ACK_HINT =
  'Before the first DRIVING call of a session, read the computer-use skill ' +
  '(skills/computer-use/SKILL.md) and acknowledge it once: ' +
  'computer_ctrl {action:"acknowledge", text:"' + REQUIRED_PHRASE + '"}. ' +
  'Observation tools are never gated, and neither is the safety direction (computer_ask, ' +
  'computer_ctrl stop/exit).'

const acked = new Set()

/** @returns {boolean} true when `text` is the exact phrase from the skill. */
export function acknowledge (text, key) {
  if (String(text == null ? '' : text).trim() !== REQUIRED_PHRASE) return false
  acked.add(String(key == null ? 'default' : key))
  return true
}

export function isAcked (key) {
  return acked.has(String(key == null ? 'default' : key))
}

/** Tests only. */
export function resetAcks () { acked.clear() }

/**
 * Does this call DRIVE the machine — i.e. does it need the receipt?
 * It mirrors policy.js's own classification instead of keeping a second list: a drifted list either
 * locks the agent out of its own tools or lets it through without reading anything.
 * Never driving: observation, `computer_ask` (the safety direction), and computer_ctrl
 * stop/selftest/exit/indicator.
 * Driving: everything in ACTUATION_TOOLS, a clipboard WRITE, calibrate (it moves the pointer) — and a
 * BATCH only when something INSIDE it drives. Classifying the wrapper alone blocked batches built
 * from pure observation steps: a false positive that buys no safety and costs a round trip. Recursion
 * means a nested batch is judged by its innermost steps.
 */
export function isDrivingCall (name, args) {
  const a = args || {}
  if (name === 'computer_ask') return false
  if (name === 'computer_ctrl') return String(a.action || 'selftest') === 'calibrate'
  if (name === 'computer_clip') return a.text !== undefined
  if (name === 'computer_batch') {
    const steps = Array.isArray(a.actions) ? a.actions : []
    return steps.some((step) => step && isDrivingCall(String(step.tool || ''), step.args || {}))
  }
  return ACTUATION_TOOLS.has(name)
}
