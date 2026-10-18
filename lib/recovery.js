// Host facts checked independently of the native pause credential.
export function recoveryProblem (permit, claim, cycle, pendingApprovals, exited) {
  if (!permit || !claim.sessionKey || !claim.agentKey) return 'no temporary pause owned by this execution'
  if (pendingApprovals) return 'human approval is pending'
  if (exited || cycle.state !== 'paused' || cycle.id !== permit.cycleId) return 'the original paused cycle changed'
  if (cycle.ownerIdent !== claim.ident || permit.ownerIdent !== claim.ident) return 'the pause belongs to another owner'
  return null
}
