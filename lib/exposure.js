// Keep desktop execution schemas out of unrelated turns. Brakes stay globally callable.
export const ACTIVATION_TOOL = 'computer_use_activate'
const ALWAYS = new Set(['computer_ctrl', 'computer_ask'])

export function installToolExposure ({ ctx, definitions, defineTool, scopeOf, readSkill, skillPath, log, enabled = true }) {
  const active = new Map()
  const boundaries = new Map()
  const agents = new Set()
  const globalDisposers = []
  const execution = definitions.filter(d => !ALWAYS.has(d.name))
  const maskInherited = (agent) => {
    if (active.has(agent) || boundaries.has(agent) || !agent?.ctx || scopeOf(agent.ctx) !== agent) return
    const inherited = execution.filter(d => ctx.tools.get(d.name, agent)).map(d => d.name)
    if (inherited.length) boundaries.set(agent, agent.ctx.tools.restrict({ deny: inherited }))
  }
  let disposed = false
  const activate = (agent) => {
    if (!enabled) return { activated: true, reused: true }
    if (disposed) throw new Error('computer-use plugin was disposed')
    if (!agent?.ctx?.tools || scopeOf(agent.ctx) !== agent) {
      throw new Error('computer-use activation needs this Agent\'s scoped tools registry; this host can use progressiveTools:false for legacy registration')
    }
    if (active.has(agent)) return { activated: true, reused: true }
    const disposers = []
    try {
      for (const definition of execution) disposers.push(agent.ctx.tools.register(definition))
      active.set(agent, disposers)
      agents.add(agent)
      for (const other of agents) maskInherited(other)
      return { activated: true, reused: false }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
  }
  const detach = (agent) => {
    const disposers = active.get(agent)
    active.delete(agent)
    for (const dispose of (disposers || []).reverse()) dispose()
    boundaries.get(agent)?.()
    boundaries.delete(agent)
    agents.delete(agent)
  }
  for (const definition of definitions) {
    if (!enabled || ALWAYS.has(definition.name)) globalDisposers.push(ctx.tools.register(definition))
  }
  if (enabled) {
    globalDisposers.push(ctx.tools.register(defineTool({
      name: ACTIVATION_TOOL,
      description: 'Load the Windows computer-use manual and activate desktop tools for this Agent. Use when the task needs mouse, keyboard, screenshots or UIA. Does not start control or release a human brake.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      execute: (_args, exec) => {
        if (active.has(exec.agent)) return { activated: true, reused: true }
        const manual = readSkill()
        return { ...activate(exec.agent), tools: definitions.map(d => d.name), manual, ...(skillPath ? { manualPath: skillPath } : {}) }
      },
    })))
    // A successful normal Skill load/receipt also activates tools, avoiding an extra bootstrap call.
    globalDisposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      const skillLoaded = exec.name === 'skill' && exec.arguments?.name === 'computer-use'
      const acknowledged = exec.name === 'computer_ctrl' && exec.arguments?.action === 'acknowledge'
      if (!result.isError && decision.kind === 'accept' && (skillLoaded || acknowledged) && exec.agent) activate(exec.agent)
      return decision
    }))
    globalDisposers.push(ctx.on('agent/disposed', (event) => detach(event.agent || event)))
    globalDisposers.push(ctx.on('agent/created', (event) => {
      const agent = event.agent || event
      agents.add(agent)
      maskInherited(agent)
    }))
    globalDisposers.push(ctx.tools.guard(exec => execution.some(d => d.name === exec.name) && !active.has(exec.agent)
      ? 'Load computer-use or call computer_use_activate in this Agent before dispatching desktop tools' : undefined))
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const agent of active.keys()) detach(agent)
    for (const agent of boundaries.keys()) detach(agent)
    agents.clear()
    for (const undo of globalDisposers.reverse()) undo()
  }
  ctx.effect(() => dispose)
  log?.info?.(`tool exposure: ${enabled ? '3 bootstrap/safety tools; 19 after Agent activation' : 'legacy 18 global tools'}`)
  return { activate, dispose }
}
