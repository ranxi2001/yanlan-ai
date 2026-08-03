import { assertBudget, createAgentPolicy } from "./policy.js";
import { cloneJson, createToolRegistry, deepFreeze } from "./tool-registry.js";
import { createRunTrace } from "./trace.js";

export class AgentProtocolError extends Error {
  constructor(message, code = "agent_protocol_error", details = {}) {
    super(message);
    this.name = "AgentProtocolError";
    this.code = code;
    Object.assign(this, details);
  }
}

export async function runAgent({
  adapter,
  profile,
  input,
  initialState = {},
  policy: policyValue,
  signal,
  runId,
  clock,
} = {}) {
  if (typeof adapter?.create !== "function") throw new TypeError("Agent requires a model adapter");
  if (!profile || typeof profile !== "object") throw new TypeError("Agent requires a profile");
  const registry = isToolRegistry(profile.tools) ? profile.tools : createToolRegistry(profile.tools || []);
  const policy = createAgentPolicy(policyValue);
  const runSignal = combineAbortSignals(signal, AbortSignal.timeout(policy.maxRunMilliseconds));
  const trace = createRunTrace({ runId, clock });
  let state = immutableState(initialState);
  let history = normalizeInput(input);
  let modelTurns = 0;
  let toolCalls = 0;
  let modelTokens = 0;
  let idleTurns = 0;
  let lastResponse = null;
  const seenCallIds = new Set();

  trace.append("run.started", { profile: String(profile.name || "agent"), tool_count: registry.definitions.length });

  const usageSnapshot = () => Object.freeze({
    modelTurns,
    toolCalls,
    ...(modelTokens > 0 ? { modelTokens } : {}),
  });

  const completeRun = async ({ outputText, response, completion }) => {
    const result = typeof profile.result === "function"
      ? await profile.result({ state, response, outputText })
      : outputText;
    trace.append("run.completed", { model_turns: modelTurns, tool_calls: toolCalls, completion });
    return Object.freeze({
      outputText,
      result,
      state,
      response,
      trace: trace.snapshot(),
      usage: usageSnapshot(),
    });
  };

  try {
    while (true) {
      assertBudget("model_turns", policy.maxModelTurns, modelTurns, 1);
      assertHistoryBudget(history, policy.maxHistoryCharacters);
      const instructions = typeof profile.instructions === "function"
        ? profile.instructions({ state, modelTurns, toolCalls })
        : profile.instructions;
      trace.append("model.requested", { turn: modelTurns + 1, history_items: history.length });
      const response = await adapter.create({
        instructions: String(instructions || ""),
        input: history,
        tools: registry.definitions,
        signal: runSignal,
      });
      modelTurns += 1;
      lastResponse = response;
      assertUsableResponse(response);
      const responseTokens = responseTokenUsage(response);
      assertBudget("total_tokens", policy.maxTotalTokens, modelTokens, responseTokens);
      modelTokens += responseTokens;
      const output = response.output;
      history = [...history, ...output];
      assertHistoryBudget(history, policy.maxHistoryCharacters);
      const calls = output.filter((item) => item?.type === "function_call");
      trace.append("model.responded", {
        turn: modelTurns,
        response_id: String(response.id || ""),
        status: String(response.status || "completed"),
        output_types: output.map((item) => String(item?.type || "unknown")),
        tool_calls: calls.length,
      });

      if (calls.length) {
        idleTurns = 0;
        const alreadyTerminal = typeof profile.isTerminalState === "function"
          ? Boolean(await profile.isTerminalState({ state, response }))
          : false;
        if (alreadyTerminal) {
          throw new AgentProtocolError(
            "Model requested tools after the profile reached a terminal state",
            "tools_after_terminal_state",
            { tools: calls.map((call) => String(call?.name || "")) },
          );
        }
        assertBudget("tool_calls", policy.maxToolCalls, toolCalls, calls.length);
        const batchCallIds = new Set();
        const prepared = calls.map((call) => {
          if (call?.status && call.status !== "completed") {
            throw new AgentProtocolError(
              `Function call ${String(call?.call_id || "")} is not completed`,
              "function_call_not_completed",
              { callId: String(call?.call_id || ""), functionCallStatus: String(call.status) },
            );
          }
          const callId = String(call?.call_id || "").trim();
          if (!callId) throw new AgentProtocolError("Function call is missing call_id", "missing_call_id");
          if (batchCallIds.has(callId) || seenCallIds.has(callId)) {
            throw new AgentProtocolError(`Duplicate function call_id: ${callId}`, "duplicate_call_id", { callId });
          }
          batchCallIds.add(callId);
          return registry.prepare(call);
        });
        const statefulCalls = prepared.filter((invocation) => invocation.tool.stateful);
        if (statefulCalls.length > 1) {
          throw new AgentProtocolError(
            "A single model response cannot contain multiple state-changing tool calls",
            "parallel_stateful_tools",
            { tools: statefulCalls.map((invocation) => invocation.tool.name) },
          );
        }
        if (statefulCalls.length === 1 && prepared.length > 1) {
          throw new AgentProtocolError(
            "A state-changing tool call must be the only tool in its model response",
            "mixed_stateful_tool_batch",
            { tools: prepared.map((invocation) => invocation.tool.name) },
          );
        }
        const outputs = [];
        for (const invocation of prepared) {
          trace.append("tool.started", { call_id: invocation.callId, tool: invocation.tool.name });
          seenCallIds.add(invocation.callId);
          toolCalls += 1;
          let rawResult;
          try {
            rawResult = await registry.execute(invocation, Object.freeze({
              state,
              signal: runSignal,
              runId: trace.runId,
              trace,
            }));
          } catch (error) {
            trace.append("tool.failed", {
              call_id: invocation.callId,
              tool: invocation.tool.name,
              code: String(error?.code || "tool_execution_failed"),
            });
            throw error;
          }
          const normalized = normalizeToolResult(rawResult, state);
          const serialized = serializeToolOutput(normalized.output);
          if (serialized.length > policy.maxToolOutputCharacters) {
            trace.append("tool.failed", {
              call_id: invocation.callId,
              tool: invocation.tool.name,
              code: "tool_output_too_large",
            });
            throw new AgentProtocolError(
              `Tool ${invocation.tool.name} output exceeded ${policy.maxToolOutputCharacters} characters`,
              "tool_output_too_large",
              { tool: invocation.tool.name, callId: invocation.callId },
            );
          }
          state = immutableState(normalized.state);
          outputs.push({ type: "function_call_output", call_id: invocation.callId, output: serialized });
          trace.append("tool.completed", { call_id: invocation.callId, tool: invocation.tool.name, output_characters: serialized.length });
        }
        history = [...history, ...outputs];
        const terminalAfterTools = profile.completeOnTerminalState === true && typeof profile.isTerminalState === "function"
          ? Boolean(await profile.isTerminalState({ state, response }))
          : false;
        if (terminalAfterTools) {
          return completeRun({ outputText: "", response, completion: "terminal_tool_state" });
        }
        continue;
      }

      const outputText = responseOutputText(response);
      const complete = typeof profile.isComplete === "function"
        ? Boolean(await profile.isComplete({ state, response, outputText }))
        : Boolean(outputText);
      if (complete) {
        if (!outputText && profile.allowEmptyFinal !== true) {
          throw new AgentProtocolError("Completed agent response has no assistant output", "no_final_output");
        }
        return completeRun({ outputText, response, completion: "assistant_message" });
      }

      assertBudget("idle_turns", policy.maxIdleTurns, idleTurns, 1);
      const feedback = typeof profile.onIncomplete === "function"
        ? await profile.onIncomplete({ state, response, outputText, idleTurns })
        : "The run is not complete. Continue by calling an available tool.";
      if (!String(feedback || "").trim()) throw new AgentProtocolError("Agent stopped before completing its profile", "agent_incomplete");
      idleTurns += 1;
      history = [...history, { role: "user", content: String(feedback).trim() }];
      trace.append("run.continued", { reason: "profile_incomplete", idle_turn: idleTurns });
    }
  } catch (error) {
    trace.append("run.failed", {
      code: String(error?.code || "agent_run_failed"),
      message: String(error?.message || error),
      model_turns: modelTurns,
      tool_calls: toolCalls,
    });
    error.agentTrace = trace.snapshot();
    error.agentState = state;
    error.agentUsage = usageSnapshot();
    error.lastResponse = lastResponse;
    throw error;
  }
}

function assertUsableResponse(response) {
  if (!response || typeof response !== "object") throw new AgentProtocolError("Model adapter returned no response", "invalid_response");
  const status = String(response.status || "completed");
  if (status !== "completed") {
    const suffix = /^[a-z][a-z0-9_]*$/u.test(status) ? status : "not_completed";
    throw new AgentProtocolError(
      String(response.error?.message || `Model response status is ${status}`),
      `response_${suffix}`,
      { responseStatus: status, incompleteDetails: response.incomplete_details, responseError: response.error },
    );
  }
  if (response.error) throw new AgentProtocolError(String(response.error?.message || response.error), "response_error");
  if (!Array.isArray(response.output)) throw new AgentProtocolError("Responses API output must be an array", "invalid_response_output");
}

function normalizeInput(input) {
  if (Array.isArray(input)) return cloneJson(input);
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (input && typeof input === "object") return [cloneJson(input)];
  throw new TypeError("Agent input must be a string, item, or item array");
}

function normalizeToolResult(value, currentState) {
  const isEnvelope = value && typeof value === "object" && !Array.isArray(value)
    && (Object.hasOwn(value, "output") || Object.hasOwn(value, "state"));
  if (!isEnvelope) return { output: value, state: currentState };
  return {
    output: Object.hasOwn(value, "output") ? value.output : null,
    state: Object.hasOwn(value, "state") ? value.state : currentState,
  };
}

function serializeToolOutput(value) {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value ?? null);
  if (typeof serialized !== "string") throw new AgentProtocolError("Tool output is not JSON serializable", "invalid_tool_output");
  return serialized;
}

function responseOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  const chunks = [];
  for (const item of response.output || []) {
    if (item?.type !== "message" || (item.status && item.status !== "completed")) continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      const text = typeof content?.text === "string" ? content.text : content?.text?.value;
      if (content?.type === "output_text" && String(text || "").trim()) chunks.push(String(text).trim());
    }
  }
  return chunks.join("\n").trim();
}

function immutableState(value) {
  const cloned = cloneJson(value);
  if (!cloned || typeof cloned !== "object") throw new AgentProtocolError("Agent state must be JSON serializable", "invalid_agent_state");
  return deepFreeze(cloned);
}

function assertHistoryBudget(history, limit) {
  const characters = JSON.stringify(history).length;
  assertBudget("history_characters", limit, characters, 0);
}

function responseTokenUsage(response) {
  const usage = response?.usage;
  const total = Number(usage?.total_tokens);
  if (Number.isFinite(total) && total >= 0) return Math.floor(total);
  const input = Number(usage?.input_tokens);
  const output = Number(usage?.output_tokens);
  return Math.max(0, Math.floor((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)));
}

function combineAbortSignals(signal, timeout) {
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = (source) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (signal.aborted) abort(signal);
  else signal.addEventListener("abort", () => abort(signal), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}

function isToolRegistry(value) {
  return value && Array.isArray(value.definitions) && typeof value.prepare === "function" && typeof value.execute === "function";
}
