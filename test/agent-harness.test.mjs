import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent/harness.js";
import { createToolRegistry, ToolSchemaError } from "../src/agent/tool-registry.js";
import { createResponsesAdapter, createScriptedModelAdapter } from "../src/agent/responses-adapter.js";

const recordTermSchema = {
  type: "object",
  properties: {
    term: { type: "string", minLength: 1 },
  },
  required: ["term"],
  additionalProperties: false,
};

function createRecordTermTool(execute) {
  return {
    name: "record_term",
    description: "Record one canonical term for this recording.",
    parameters: recordTermSchema,
    strict: true,
    execute,
  };
}

function createProfile(tools, overrides = {}) {
  return {
    name: "terminology-contract",
    instructions: "Keep terminology consistent within one recording.",
    tools,
    isComplete: ({ outputText }) => Boolean(outputText),
    result: ({ state, outputText }) => ({ state, outputText }),
    onIncomplete: () => "Continue until the requested result is complete.",
    ...overrides,
  };
}

function completedMessageResponse(id, text) {
  return {
    id,
    status: "completed",
    output: [{
      id: `message_${id}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }],
  };
}

test("tool schemas must be recursively strict before a run starts", () => {
  const invalidNestedSchema = {
    type: "object",
    properties: {
      entry: {
        type: "object",
        properties: { term: { type: "string" } },
        required: ["term"],
      },
    },
    required: ["entry"],
    additionalProperties: false,
  };

  assert.throws(
    () => createToolRegistry([createRecordTermTool(() => null), {
      name: "record_entry",
      description: "Record a structured terminology entry.",
      parameters: invalidNestedSchema,
      strict: true,
      execute: () => null,
    }]),
    (error) => {
      assert.ok(error instanceof ToolSchemaError);
      assert.equal(error.code, "tool_schema_invalid");
      assert.equal(error.tool, "record_entry");
      assert.ok(error.issues.some((issue) => issue.includes("entry.additionalProperties")));
      return true;
    },
  );

  assert.throws(
    () => createToolRegistry([{ ...createRecordTermTool(() => null), strict: false }]),
    (error) => error instanceof ToolSchemaError && error.code === "tool_schema_invalid",
  );

  const registry = createToolRegistry([createRecordTermTool(() => null)]);
  assert.deepEqual(registry.definitions, [{
    type: "function",
    name: "record_term",
    description: "Record one canonical term for this recording.",
    parameters: recordTermSchema,
    strict: true,
  }]);
});

test("tool output keeps call_id and replays the complete response output including reasoning", async () => {
  const firstOutput = [{
    id: "reasoning_1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Resolve the repeated ASR alias." }],
    encrypted_content: "opaque-reasoning-payload",
  }, {
    id: "message_progress",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "I will normalize the repeated term." }],
  }, {
    id: "function_1",
    type: "function_call",
    status: "completed",
    call_id: "call_descheduler_1",
    name: "record_term",
    arguments: JSON.stringify({ term: "Descheduler" }),
  }];
  const finalResponse = completedMessageResponse("response_2", "Descheduler is now canonical.");
  const adapter = createScriptedModelAdapter([{
    id: "response_1",
    status: "completed",
    output: firstOutput,
  }, finalResponse]);
  const registry = createToolRegistry([createRecordTermTool(({ term }, { state }) => ({
    output: { accepted: term },
    state: { ...state, terms: [...state.terms, term] },
  }))]);

  const run = await runAgent({
    adapter,
    profile: createProfile(registry),
    input: "Normalize repeated terminology.",
    initialState: { terms: [] },
    policy: { maxModelTurns: 2, maxToolCalls: 1 },
  });

  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(adapter.requests[1].input, [
    { role: "user", content: "Normalize repeated terminology." },
    ...firstOutput,
    {
      type: "function_call_output",
      call_id: "call_descheduler_1",
      output: JSON.stringify({ accepted: "Descheduler" }),
    },
  ]);
  assert.deepEqual(adapter.requests[1].input[1], firstOutput[0]);
  assert.equal(adapter.requests[1].input.at(-1).call_id, firstOutput.at(-1).call_id);
  assert.deepEqual(run.state, { terms: ["Descheduler"] });
  assert.equal(run.outputText, "Descheduler is now canonical.");
  assert.deepEqual(run.usage, { modelTurns: 2, toolCalls: 1 });
});

test("a multi-call response is rejected atomically when the remaining tool budget is too small", async () => {
  const executions = [];
  const registry = createToolRegistry([createRecordTermTool(({ term }) => {
    executions.push(term);
    return { accepted: term };
  })]);
  const response = {
    id: "response_over_budget",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "record_term",
        arguments: JSON.stringify({ term: "Descheduler" }),
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "record_term",
        arguments: JSON.stringify({ term: "Kubernetes" }),
      },
    ],
  };
  const adapter = createScriptedModelAdapter([response]);

  await assert.rejects(
    () => runAgent({
      adapter,
      profile: createProfile(registry),
      input: "Record both terms.",
      initialState: {},
      policy: { maxModelTurns: 1, maxToolCalls: 1 },
    }),
    (error) => {
      assert.equal(error.code, "agent_budget_exceeded");
      assert.equal(error.kind, "tool_calls");
      assert.equal(error.limit, 1);
      assert.equal(error.used, 0);
      assert.equal(error.requested, 2);
      assert.deepEqual(error.agentUsage, { modelTurns: 1, toolCalls: 0 });
      assert.equal(error.agentTrace.some((event) => event.type === "tool.started"), false);
      return true;
    },
  );

  assert.deepEqual(executions, []);
});

test("state-changing tools cannot share one model response", async () => {
  const executions = [];
  const tools = ["read_window", "finalize_artifact"].map((name) => ({
    ...createRecordTermTool(() => {
      executions.push(name);
      return { output: { ok: true }, state: { changedBy: name } };
    }),
    name,
    stateful: true,
  }));
  const adapter = createScriptedModelAdapter([{
    id: "response_parallel_state",
    status: "completed",
    output: tools.map((tool, index) => ({
      type: "function_call",
      call_id: `state_call_${index}`,
      name: tool.name,
      arguments: JSON.stringify({ term: "Descheduler" }),
    })),
  }]);

  await assert.rejects(
    () => runAgent({
      adapter,
      profile: createProfile(tools),
      input: "Read and finalize the recording.",
      initialState: {},
      policy: { maxModelTurns: 1, maxToolCalls: 2 },
    }),
    (error) => {
      assert.equal(error.code, "parallel_stateful_tools");
      assert.deepEqual(error.tools, ["read_window", "finalize_artifact"]);
      assert.equal(error.agentTrace.some((event) => event.type === "tool.started"), false);
      return true;
    },
  );
  assert.deepEqual(executions, []);
});

test("a state-changing call cannot share a response with a stateless call", async () => {
  const executions = [];
  const tools = [{ name: "read_window", stateful: true }, { name: "scan_term", stateful: false }].map((definition) => ({
    ...createRecordTermTool(() => {
      executions.push(definition.name);
      return { output: { ok: true } };
    }),
    ...definition,
  }));
  const adapter = createScriptedModelAdapter([{
    id: "response_mixed_state",
    status: "completed",
    output: tools.map((tool, index) => ({
      type: "function_call",
      status: "completed",
      call_id: `mixed_call_${index}`,
      name: tool.name,
      arguments: JSON.stringify({ term: "Descheduler" }),
    })),
  }]);

  await assert.rejects(
    () => runAgent({
      adapter,
      profile: createProfile(tools),
      input: "Do not mix stateful and stateless execution.",
      initialState: {},
      policy: { maxModelTurns: 1, maxToolCalls: 2 },
    }),
    (error) => error.code === "mixed_stateful_tool_batch",
  );
  assert.deepEqual(executions, []);
});

test("an unfinished function_call item is rejected before execution", async () => {
  const executions = [];
  const adapter = createScriptedModelAdapter([{
    id: "response_unfinished_call",
    status: "completed",
    output: [{
      type: "function_call",
      status: "in_progress",
      call_id: "call_in_progress",
      name: "record_term",
      arguments: JSON.stringify({ term: "Descheduler" }),
    }],
  }]);
  const registry = createToolRegistry([createRecordTermTool(() => executions.push("executed"))]);

  await assert.rejects(
    () => runAgent({
      adapter,
      profile: createProfile(registry),
      input: "Wait for completed function call arguments.",
      initialState: {},
      policy: { maxModelTurns: 1, maxToolCalls: 1 },
    }),
    (error) => {
      assert.equal(error.code, "function_call_not_completed");
      assert.equal(error.functionCallStatus, "in_progress");
      assert.deepEqual(error.agentUsage, { modelTurns: 1, toolCalls: 0 });
      return true;
    },
  );
  assert.deepEqual(executions, []);
});

test("a completed response containing a function call cannot finalize on its output_text", async () => {
  const completenessChecks = [];
  const executions = [];
  const adapter = createScriptedModelAdapter([{
    id: "response_with_call",
    status: "completed",
    output_text: "Premature final text.",
    output: [{
      type: "function_call",
      call_id: "call_before_final",
      name: "record_term",
      arguments: JSON.stringify({ term: "Descheduler" }),
    }],
  }, {
    ...completedMessageResponse("response_final", "Authoritative final text."),
    output_text: "Authoritative final text.",
  }]);
  const registry = createToolRegistry([createRecordTermTool(({ term }, { state }) => {
    executions.push(term);
    return { output: "recorded", state: { ...state, recorded: true } };
  })]);

  const run = await runAgent({
    adapter,
    profile: createProfile(registry, {
      isComplete: ({ state, outputText }) => {
        completenessChecks.push(outputText);
        return state.recorded === true;
      },
      result: ({ outputText }) => outputText,
    }),
    input: "Normalize the recording.",
    initialState: { recorded: false },
    policy: { maxModelTurns: 2, maxToolCalls: 1 },
  });

  assert.deepEqual(executions, ["Descheduler"]);
  assert.equal(adapter.requests.length, 2);
  assert.deepEqual(completenessChecks, ["Authoritative final text."]);
  assert.equal(run.outputText, "Authoritative final text.");
  assert.equal(run.result, "Authoritative final text.");
  assert.equal(run.response.id, "response_final");
});

test("a completed response without function calls produces the profile final result", async () => {
  const response = completedMessageResponse("response_done", "Terminology is consistent.");
  const adapter = createScriptedModelAdapter([response]);
  const state = { recordingId: "weekly-01", complete: true };
  let incompleteCalls = 0;

  const run = await runAgent({
    adapter,
    profile: createProfile([], {
      isComplete: ({ state: current, response: currentResponse, outputText }) => {
        assert.deepEqual(current, state);
        assert.equal(currentResponse.id, "response_done");
        assert.equal(outputText, "Terminology is consistent.");
        return current.complete;
      },
      result: ({ state: current, outputText }) => ({
        recordingId: current.recordingId,
        text: outputText,
      }),
      onIncomplete: () => {
        incompleteCalls += 1;
        return "This should not be requested.";
      },
    }),
    input: [{ role: "user", content: "Return the completed result." }],
    initialState: state,
    policy: { maxModelTurns: 1, maxToolCalls: 0 },
  });

  assert.equal(incompleteCalls, 0);
  assert.equal(run.outputText, "Terminology is consistent.");
  assert.deepEqual(run.result, {
    recordingId: "weekly-01",
    text: "Terminology is consistent.",
  });
  assert.deepEqual(run.state, state);
  assert.deepEqual(run.response, response);
  assert.deepEqual(run.usage, { modelTurns: 1, toolCalls: 0 });
  assert.equal(run.trace.at(-1).type, "run.completed");
});

test("a non-completed Responses result cannot execute tools or complete from output text", async () => {
  for (const status of ["failed", "in_progress", "cancelled"]) {
    const executions = [];
    const adapter = createScriptedModelAdapter([{
      id: `response_${status}`,
      status,
      output_text: "This must not be accepted.",
      output: [{
        type: "function_call",
        call_id: `call_${status}`,
        name: "record_term",
        arguments: JSON.stringify({ term: "Descheduler" }),
      }],
    }]);
    const registry = createToolRegistry([createRecordTermTool(() => {
      executions.push(status);
      return { output: { ok: true } };
    })]);

    await assert.rejects(
      () => runAgent({
        adapter,
        profile: createProfile(registry),
        input: "Do not accept a non-terminal model response.",
        initialState: {},
        policy: { maxModelTurns: 1, maxToolCalls: 1 },
      }),
      (error) => {
        assert.equal(error.code, `response_${status}`);
        assert.equal(error.responseStatus, status);
        assert.deepEqual(error.agentUsage, { modelTurns: 1, toolCalls: 0 });
        assert.equal(error.agentTrace.at(-1).type, "run.failed");
        return true;
      },
    );
    assert.deepEqual(executions, []);
  }
});

test("a terminal profile state rejects later tool calls without mutating state", async () => {
  const executions = [];
  const adapter = createScriptedModelAdapter([{
    id: "response_after_terminal",
    status: "completed",
    output: [{
      type: "function_call",
      call_id: "call_after_terminal",
      name: "record_term",
      arguments: JSON.stringify({ term: "Kubernetes" }),
    }],
  }]);
  const registry = createToolRegistry([createRecordTermTool(() => {
    executions.push("executed");
    return { state: { finalized: true, changed: true }, output: { ok: true } };
  })]);

  await assert.rejects(
    () => runAgent({
      adapter,
      profile: createProfile(registry, { isTerminalState: ({ state }) => state.finalized === true }),
      input: "The artifact is already final.",
      initialState: { finalized: true },
      policy: { maxModelTurns: 1, maxToolCalls: 1 },
    }),
    (error) => {
      assert.equal(error.code, "tools_after_terminal_state");
      assert.deepEqual(error.agentState, { finalized: true });
      assert.deepEqual(error.agentUsage, { modelTurns: 1, toolCalls: 0 });
      return true;
    },
  );
  assert.deepEqual(executions, []);
});

test("a terminal tool can complete the run without a fragile extra model turn", async () => {
  const adapter = createScriptedModelAdapter([{
    id: "response_finalize_tool",
    status: "completed",
    output: [{
      type: "function_call",
      status: "completed",
      call_id: "call_finalize_tool",
      name: "record_term",
      arguments: JSON.stringify({ term: "Descheduler" }),
    }],
  }]);
  const registry = createToolRegistry([createRecordTermTool(({ term }, { state }) => ({
    state: { ...state, finalized: true, artifact: { canonical: term } },
    output: { ok: true },
  }))]);
  const run = await runAgent({
    adapter,
    profile: createProfile(registry, {
      isTerminalState: ({ state }) => state.finalized === true,
      completeOnTerminalState: true,
      result: ({ state }) => state.artifact,
    }),
    input: "Finalize exactly once.",
    initialState: { finalized: false, artifact: null },
    policy: { maxModelTurns: 1, maxToolCalls: 1 },
  });

  assert.equal(adapter.requests.length, 1);
  assert.equal(run.outputText, "");
  assert.deepEqual(run.result, { canonical: "Descheduler" });
  assert.deepEqual(run.usage, { modelTurns: 1, toolCalls: 1 });
  assert.equal(run.trace.at(-1).data.completion, "terminal_tool_state");
});

test("an oversized tool output is counted as an attempted call and does not commit returned state", async () => {
  const adapter = createScriptedModelAdapter([{
    id: "response_large_tool_output",
    status: "completed",
    output: [{
      type: "function_call",
      call_id: "call_large_output",
      name: "record_term",
      arguments: JSON.stringify({ term: "Descheduler" }),
    }],
  }]);
  const registry = createToolRegistry([createRecordTermTool(() => ({
    state: { committed: true },
    output: { text: "x".repeat(100) },
  }))]);

  await assert.rejects(
    () => runAgent({
      adapter,
      profile: createProfile(registry),
      input: "Exercise output accounting.",
      initialState: { committed: false },
      policy: { maxModelTurns: 1, maxToolCalls: 1, maxToolOutputCharacters: 20 },
    }),
    (error) => {
      assert.equal(error.code, "tool_output_too_large");
      assert.deepEqual(error.agentUsage, { modelTurns: 1, toolCalls: 1 });
      assert.deepEqual(error.agentState, { committed: false });
      assert.ok(error.agentTrace.some((event) => event.type === "tool.failed"));
      return true;
    },
  );
});

test("history and reported token budgets stop the run before further execution", async () => {
  const untouchedAdapter = createScriptedModelAdapter([]);
  await assert.rejects(
    () => runAgent({
      adapter: untouchedAdapter,
      profile: createProfile([]),
      input: "x".repeat(1_100),
      initialState: {},
      policy: { maxModelTurns: 1, maxToolCalls: 0, maxHistoryCharacters: 1_000 },
    }),
    (error) => error.code === "agent_budget_exceeded" && error.kind === "history_characters",
  );
  assert.equal(untouchedAdapter.requests.length, 0);

  const tokenAdapter = createScriptedModelAdapter([{
    ...completedMessageResponse("response_over_token_budget", "Too expensive."),
    usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
  }]);
  await assert.rejects(
    () => runAgent({
      adapter: tokenAdapter,
      profile: createProfile([]),
      input: "Respect the token cap.",
      initialState: {},
      policy: { maxModelTurns: 1, maxToolCalls: 0, maxTotalTokens: 100 },
    }),
    (error) => (
      error.code === "agent_budget_exceeded"
      && error.kind === "total_tokens"
      && error.requested === 120
    ),
  );
});

test("Responses adapter sends an explicit model output budget", async () => {
  let body;
  const adapter = createResponsesAdapter({
    model: "gpt-5.6-luna",
    maxOutputTokens: 2_048,
    request: async (requestBody) => {
      body = requestBody;
      return completedMessageResponse("response_adapter_budget", "Done.");
    },
  });

  await adapter.create({ instructions: "Use tools.", input: [], tools: [] });
  assert.equal(body.max_output_tokens, 2_048);
  assert.equal(body.store, false);
});
