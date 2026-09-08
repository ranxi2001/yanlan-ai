import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent/harness.js";

const response = (id, tool) => ({ status: "completed", output: [{ type: "function_call", call_id: id, name: tool, arguments: "{}" }] });
const profile = () => ({ name: "checkpoint-fixture", input: "Start", initialState: { count: 0, done: false }, instructions: "Use tools",
  tools: [
    { name: "increment", strict: true, stateful: true, description: "Increment", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, execute: (_, { state }) => ({ state: { ...state, count: state.count + 1 }, output: { ok: true } }) },
    { name: "finish", strict: true, stateful: true, description: "Finish", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, execute: (_, { state }) => ({ state: { ...state, done: true }, output: { ok: true } }) },
  ], isComplete: ({ state }) => state.done, isTerminalState: ({ state }) => state.done, completeOnTerminalState: true, allowEmptyFinal: true, result: ({ state }) => state,
});

test("checkpoint resumes completed tool history without rerunning the committed tool", async () => {
  const p = profile();
  let saved;
  let calls = 0;
  await assert.rejects(runAgent({ profile: p, input: p.input, initialState: p.initialState,
    onCheckpoint: (checkpoint) => { saved = structuredClone(checkpoint); },
    adapter: { create: async () => { if (calls++) throw new Error("network unavailable"); return response("call-1", "increment"); } },
  }), /network unavailable/u);
  assert.equal(saved.state.count, 1);
  const completed = await runAgent({ profile: p, resume: saved, adapter: { create: async ({ input }) => {
    assert.ok(input.some((item) => item.type === "function_call_output" && item.call_id === "call-1"));
    return response("call-2", "finish");
  } } });
  assert.equal(completed.result.count, 1);
  assert.equal(completed.usage.modelTurns, 2);
  assert.equal(completed.usage.toolCalls, 2);
});

test("resume preserves prior budgets and rejects another profile checkpoint", async () => {
  const p = profile();
  const saved = { schema: 1, profile: p.name, state: { count: 1 }, history: [], usage: { modelTurns: 5, toolCalls: 1 } };
  await assert.rejects(runAgent({ profile: p, resume: saved, policy: { maxModelTurns: 5 }, adapter: { create: async () => { throw new Error("must not run"); } } }), (error) => error.code === "agent_budget_exceeded");
  await assert.rejects(runAgent({ profile: p, resume: { ...saved, profile: "other" }, adapter: { create: async () => response("bad", "finish") } }), /Invalid agent checkpoint/u);
});
