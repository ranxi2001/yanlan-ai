import { cloneJson, deepFreeze } from "./tool-registry.js";

export function createRunTrace({ runId = createRunId(), clock = () => new Date().toISOString() } = {}) {
  const events = [];
  return Object.freeze({
    runId,
    append(type, data = {}) {
      const event = deepFreeze({
        sequence: events.length,
        run_id: runId,
        type: String(type || "event"),
        at: String(clock()),
        data: cloneJson(data) || {},
      });
      events.push(event);
      return event;
    },
    snapshot() {
      return deepFreeze(cloneJson(events));
    },
  });
}

function createRunId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
