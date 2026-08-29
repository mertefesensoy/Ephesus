// PLANTED PATTERN 1: planning is separated from dispatch, so a retry re-plans
// instead of replaying the previous tool call.
export function runTurn(state: unknown): void {
  const plan = planTurn(state)
  dispatch(plan)
}

function planTurn(state: unknown): unknown {
  return state
}

function dispatch(plan: unknown): void {
  void plan
}
