const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class ToolSchemaError extends Error {
  constructor(message, { tool = "", issues = [] } = {}) {
    super(message);
    this.name = "ToolSchemaError";
    this.code = "tool_schema_invalid";
    this.tool = tool;
    this.issues = issues;
  }
}

export class ToolArgumentError extends Error {
  constructor(message, { tool = "", callId = "", issues = [] } = {}) {
    super(message);
    this.name = "ToolArgumentError";
    this.code = "tool_arguments_invalid";
    this.tool = tool;
    this.callId = callId;
    this.issues = issues;
  }
}

export function createToolRegistry(tools = []) {
  if (!Array.isArray(tools)) throw new ToolSchemaError("Agent tools must be an array");
  const registered = new Map();

  for (const candidate of tools) {
    const name = String(candidate?.name || "").trim();
    if (!TOOL_NAME.test(name)) throw new ToolSchemaError(`Invalid tool name: ${name || "(empty)"}`, { tool: name });
    if (registered.has(name)) throw new ToolSchemaError(`Duplicate tool name: ${name}`, { tool: name });
    if (candidate?.strict !== true) throw new ToolSchemaError(`Tool ${name} must declare strict: true`, { tool: name });
    if (typeof candidate?.description !== "string" || !candidate.description.trim()) {
      throw new ToolSchemaError(`Tool ${name} must have a description`, { tool: name });
    }
    if (typeof candidate?.execute !== "function") throw new ToolSchemaError(`Tool ${name} must have an executor`, { tool: name });
    const issues = strictSchemaIssues(candidate.parameters, "$parameters");
    if (issues.length) throw new ToolSchemaError(`Tool ${name} has a non-strict JSON schema`, { tool: name, issues });
    registered.set(name, Object.freeze({
      name,
      description: candidate.description.trim(),
      parameters: cloneJson(candidate.parameters),
      strict: true,
      stateful: candidate.stateful === true,
      execute: candidate.execute,
    }));
  }

  const definitions = Object.freeze([...registered.values()].map((tool) => Object.freeze({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: cloneJson(tool.parameters),
    strict: true,
  })));

  return Object.freeze({
    definitions,
    has(name) {
      return registered.has(name);
    },
    prepare(call) {
      const name = String(call?.name || "").trim();
      const callId = String(call?.call_id || "").trim();
      const tool = registered.get(name);
      if (!tool) throw new ToolArgumentError(`Unknown tool: ${name || "(empty)"}`, { tool: name, callId });
      let args;
      try {
        args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : cloneJson(call.arguments);
      } catch {
        throw new ToolArgumentError(`Tool ${name} returned malformed JSON arguments`, {
          tool: name,
          callId,
          issues: ["$arguments must be valid JSON"],
        });
      }
      const issues = valueSchemaIssues(args, tool.parameters, "$arguments");
      if (issues.length) throw new ToolArgumentError(`Tool ${name} arguments do not match its schema`, { tool: name, callId, issues });
      return Object.freeze({ tool, call, callId, args: deepFreeze(cloneJson(args)) });
    },
    execute(prepared, executionContext) {
      return prepared.tool.execute(prepared.args, executionContext);
    },
  });
}

function strictSchemaIssues(schema, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path} must be an object schema`];
  const issues = [];
  const types = schemaTypes(schema);
  if (!types.length) issues.push(`${path}.type is required`);
  const nonNullTypes = types.filter((type) => type !== "null");
  if (nonNullTypes.length !== 1) issues.push(`${path}.type must describe exactly one value type plus optional null`);
  const type = nonNullTypes[0];
  if (type === "object") {
    if (schema.additionalProperties !== false) issues.push(`${path}.additionalProperties must be false`);
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      issues.push(`${path}.properties must be an object`);
    } else {
      const names = Object.keys(properties);
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (names.some((name) => !required.includes(name)) || required.some((name) => !names.includes(name))) {
        issues.push(`${path}.required must list every property exactly once`);
      }
      for (const [name, child] of Object.entries(properties)) issues.push(...strictSchemaIssues(child, `${path}.properties.${name}`));
    }
  }
  if (type === "array") {
    if (!schema.items) issues.push(`${path}.items is required`);
    else issues.push(...strictSchemaIssues(schema.items, `${path}.items`));
  }
  return issues;
}

function valueSchemaIssues(value, schema, path) {
  if (value === null && schemaTypes(schema).includes("null")) return [];
  const type = schemaTypes(schema).find((candidate) => candidate !== "null");
  const issues = [];
  if (!matchesType(value, type)) return [`${path} must be ${type}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) issues.push(`${path} is not an allowed value`);
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value)) issues.push(`${path} must equal its const value`);
  if (type === "object") {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) issues.push(`${path}.${name} is required`);
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(properties, name)) issues.push(`${path}.${name} is not allowed`);
      else issues.push(...valueSchemaIssues(value[name], properties[name], `${path}.${name}`));
    }
  }
  if (type === "array") {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) issues.push(`${path} has too few items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) issues.push(`${path} has too many items`);
    value.forEach((entry, index) => issues.push(...valueSchemaIssues(entry, schema.items, `${path}[${index}]`)));
  }
  if (type === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) issues.push(`${path} is too short`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) issues.push(`${path} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) issues.push(`${path} does not match its pattern`);
  }
  if (type === "number" || type === "integer") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) issues.push(`${path} is below minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) issues.push(`${path} is above maximum`);
  }
  return issues;
}

function schemaTypes(schema) {
  if (typeof schema?.type === "string") return [schema.type];
  return Array.isArray(schema?.type) ? schema.type : [];
}

function matchesType(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

export function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
