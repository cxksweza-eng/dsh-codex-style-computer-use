import { randomBytes } from 'node:crypto'

const clone = value => JSON.parse(JSON.stringify(value))
const encode = value => JSON.stringify(value)
const elementKey = e => e.target || (e.runtimeId ? `uia:${e.pid ?? ''}:${e.runtimeId}` : null)
const windowKey = w => w.hwnd ? `window:${w.pid ?? ''}:${w.hwnd}` : null

// An explicit base prevents implicit deltas after compaction or in an unrelated Agent.
// Full immutable observations are retained, including every provider field; only the wire view differs.
export class ObservationStore {
  constructor ({ capacity = 64 } = {}) {
    this.capacity = capacity
    this.scopes = new WeakMap()
    this.unscoped = {}
    this.sequence = 0
    this.prefix = randomBytes(4).toString('hex')
  }
  scope (exec) {
    const owner = exec?.agent || this.unscoped
    let cache = this.scopes.get(owner)
    if (!cache) { cache = new Map(); this.scopes.set(owner, cache) }
    return cache
  }
  get (exec, id, kind) {
    const entry = this.scope(exec).get(id)
    if (!entry || entry.kind !== kind) throw new Error('OBSERVATION_UNAVAILABLE: snapshot expired or belongs to another Agent/tool; request a fresh full observation')
    return clone(entry.full)
  }
  ownsTarget (exec, target) {
    return [...this.scope(exec).values()].some(entry => (entry.full.elements || []).some(e => e.target === target))
  }
  publish (exec, kind, query, value, since) {
    const cache = this.scope(exec)
    const fields = kind === 'uia' ? { elements: elementKey } : { windows: windowKey, uiaFlat: elementKey }
    const full = clone({ ...value, observation: `O${this.prefix}-${++this.sequence}`, mode: 'full' })
    // The scope includes the exact query and observed window/process. A change forces a full view.
    const scope = encode([query, value.hwnd ?? value.active?.hwnd ?? null, value.pid ?? value.active?.pid ?? null])
    const previous = since && cache.get(since)
    let wire = full
    if (since) {
      let reason = !previous ? 'base-unavailable' : previous.kind !== kind || previous.scope !== scope ? 'scope-changed'
        : previous.full.truncated || previous.full.uiaTruncated || full.truncated || full.uiaTruncated ? 'incomplete-observation' : null
      if (!reason) {
        const delta = {}
        for (const [field, keyOf] of Object.entries(fields)) {
          const before = previous.full[field] || [], after = full[field] || []
          const keyMap = rows => {
            const map = new Map()
            for (const row of rows) {
              const key = keyOf(row)
              if (!key || map.has(key)) return null
              map.set(key, row)
            }
            return map
          }
          const oldMap = keyMap(before), newMap = keyMap(after)
          if (!oldMap || !newMap) { reason = 'ambiguous-identity'; break }
          delta[field] = { added: [], changed: [], removed: [] }
          for (const [key, row] of newMap) {
            if (!oldMap.has(key)) delta[field].added.push({ key, element: row })
            else if (encode(oldMap.get(key)) !== encode(row)) delta[field].changed.push({ key, element: row })
          }
          for (const key of oldMap.keys()) if (!newMap.has(key)) delta[field].removed.push(key)
          if (encode([...oldMap.keys()]) !== encode([...newMap.keys()])) delta[field].order = [...newMap.keys()]
        }
        if (!reason) {
          wire = { ...full, mode: 'diff', base: since, delta }
          for (const field of Object.keys(fields)) delete wire[field]
          if (encode(wire).length >= encode(full).length) reason = 'delta-not-smaller'
        }
      }
      if (reason) wire = { ...full, resetReason: reason }
    }
    cache.set(full.observation, { full, kind, scope })
    while (cache.size > this.capacity) cache.delete(cache.keys().next().value)
    return wire
  }
}
