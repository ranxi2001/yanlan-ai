import { cloneJson } from "./tool-registry.js";

export function createResponsesAdapter({
  request,
  model,
  store = false,
  includeEncryptedReasoning = true,
  maxOutputTokens = 4_096,
} = {}) {
  if (typeof request !== "function") throw new TypeError("Responses adapter requires a request function");
  if (!String(model || "").trim()) throw new TypeError("Responses adapter requires a model");
  return Object.freeze({
    async create({ instructions, input, tools, signal }) {
      const body = {
        model: String(model).trim(),
        instructions: String(instructions || ""),
        input,
        tools,
        store: Boolean(store),
      };
      if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_output_tokens = maxOutputTokens;
      if (!store && includeEncryptedReasoning) body.include = ["reasoning.encrypted_content"];
      return request(body, { signal });
    },
  });
}

export function createScriptedModelAdapter(steps = []) {
  if (!Array.isArray(steps)) throw new TypeError("Scripted adapter steps must be an array");
  const queue = [...steps];
  const requests = [];
  return {
    requests,
    async create(request) {
      requests.push(cloneJson(request));
      if (!queue.length) throw new Error("Scripted model adapter has no response left");
      const step = queue.shift();
      return typeof step === "function" ? step(request, requests.length - 1) : cloneJson(step);
    },
  };
}
