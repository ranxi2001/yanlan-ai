export class RunBudgetExceeded extends Error {
  constructor(kind, { limit, used, requested }) {
    super(`Agent ${kind} budget exceeded: ${used} + ${requested} > ${limit}`);
    this.name = "RunBudgetExceeded";
    this.code = "agent_budget_exceeded";
    this.kind = kind;
    this.limit = limit;
    this.used = used;
    this.requested = requested;
  }
}

export function createAgentPolicy(value = {}) {
  return Object.freeze({
    maxModelTurns: boundedInteger(value.maxModelTurns, 12, 1, 100),
    maxToolCalls: boundedInteger(value.maxToolCalls, 32, 0, 500),
    maxIdleTurns: boundedInteger(value.maxIdleTurns, 1, 0, 5),
    maxToolOutputCharacters: boundedInteger(value.maxToolOutputCharacters, 40_000, 100, 1_000_000),
    maxHistoryCharacters: boundedInteger(value.maxHistoryCharacters, 500_000, 1_000, 5_000_000),
    maxTotalTokens: boundedInteger(value.maxTotalTokens, 100_000, 100, 2_000_000),
    maxRunMilliseconds: boundedInteger(value.maxRunMilliseconds, 300_000, 1_000, 1_800_000),
  });
}

export function assertBudget(kind, limit, used, requested = 1) {
  if (used + requested > limit) throw new RunBudgetExceeded(kind, { limit, used, requested });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}
