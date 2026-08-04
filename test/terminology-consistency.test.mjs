import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  askTranscript,
  correctTranscript,
  publicMeeting,
  summarizeTranscript,
} from "../src/api.js";

const chatConfig = (contextHint = "") => ({
  ...DEFAULT_CONFIG,
  chatBaseUrl: "https://terminology-consistency.invalid/v1",
  chatApiKey: "test-key",
  chatModel: "offline-test-model",
  chatProtocol: "chat-completions",
  chatPath: "chat/completions",
  contextHint,
});

function sourceMeeting(texts) {
  const rawSegments = texts.map((text, index) => ({
    start_seconds: index * 3,
    end_seconds: index * 3 + 2,
    speaker: "A",
    text,
  }));
  return {
    rawSegments,
    segments: rawSegments,
    asrReconciliations: [],
  };
}

function chatResponse(content) {
  const value = typeof content === "string" ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ choices: [{ message: { content: value } }] }), {
    headers: { "content-type": "application/json" },
  });
}

function correctionPayload(options) {
  const body = JSON.parse(options?.body || "{}");
  const user = body.messages?.find((message) => message.role === "user")?.content || "";
  const marker = "待检查片段：\n";
  const offset = user.lastIndexOf(marker);
  assert.ok(offset >= 0, "correction prompt is missing its segment payload");
  return JSON.parse(user.slice(offset + marker.length));
}

async function withMockFetch(mock, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a correction batch cannot patch the following-segment preview", async () => {
  const source = sourceMeeting([
    `first batch ${"前".repeat(7_400)}`,
    `disk scheduler appears here and disk scheduler repeats ${"后".repeat(1_000)}`,
  ]);
  const payloads = [];
  const result = await withMockFetch(async (_url, options) => {
    const payload = correctionPayload(options);
    payloads.push(payload);
    if (payload.segments[0]?.id === 0) {
      assert.equal(payload.following_segment?.id, 1);
      assert.match(payload.following_segment?.text || "", /disk scheduler/u);
      return chatResponse({
        patches: [{
          id: payload.following_segment.id,
          replacements: [{ from: "disk scheduler", to: "Descheduler" }],
        }],
        join_after: [],
      });
    }
    return chatResponse({ patches: [], join_after: [] });
  }, () => correctTranscript({ config: chatConfig(), meeting: source }));

  assert.equal(payloads.length, 2);
  assert.deepEqual(result.segments.map((segment) => segment.text), source.segments.map((segment) => segment.text));
  assert.deepEqual(result.terminology, []);
  assert.equal(result.rejectedCorrections, 1);
  assert.deepEqual(result.corrections.map(({ segmentId, status, reason }) => ({ segmentId, status, reason })), [
    { segmentId: 1, status: "rejected", reason: "out_of_batch_segment" },
  ]);
});

test("recording consensus excludes an unrelated alias for the same canonical", async () => {
  const source = sourceMeeting([
    "disk scheduler starts checking.",
    "disk scheduler finishes checking.",
    "database starts checking.",
    "database finishes checking.",
  ]);
  const result = await withMockFetch(async (_url, options) => {
    const payload = correctionPayload(options);
    return chatResponse({
      patches: payload.segments.map((segment) => ({
        id: segment.id,
        replacements: [{
          from: segment.text.startsWith("disk scheduler") ? "disk scheduler" : "database",
          to: "Descheduler",
        }],
      })),
      join_after: [],
    });
  }, () => correctTranscript({ config: chatConfig(), meeting: source }));

  assert.deepEqual(result.segments.map((segment) => segment.text), [
    "Descheduler starts checking.",
    "Descheduler finishes checking.",
    "database starts checking.",
    "database finishes checking.",
  ]);
  assert.deepEqual(result.terminology, ["Descheduler"]);
  assert.equal(result.corrections.filter((entry) => entry.status === "accepted").length, 2);
  assert.equal(result.corrections.filter((entry) => entry.status === "accepted")
    .every((entry) => entry.from === "disk scheduler" && entry.reason === "recording_consensus"), true);
  assert.deepEqual(result.corrections.filter((entry) => entry.from === "database")
    .map(({ status, reason }) => ({ status, reason })), [
    { status: "rejected", reason: "explicit_alias_required" },
    { status: "rejected", reason: "explicit_alias_required" },
  ]);
});

test("an unrelated alias cannot inherit two plausible aliases in the same canonical group", async () => {
  const source = sourceMeeting([
    "disk scheduler starts checking.",
    "dis scheduler finishes checking.",
    "database remains unchanged.",
  ]);
  const result = await withMockFetch(async (_url, options) => {
    const payload = correctionPayload(options);
    return chatResponse({
      patches: payload.segments.map((segment) => ({
        id: segment.id,
        replacements: [{
          from: segment.text.startsWith("disk scheduler")
            ? "disk scheduler"
            : (segment.text.startsWith("dis scheduler") ? "dis scheduler" : "database"),
          to: "Descheduler",
        }],
      })),
      join_after: [],
    });
  }, () => correctTranscript({ config: chatConfig(), meeting: source }));

  assert.deepEqual(result.segments.map((segment) => segment.text), [
    "Descheduler starts checking.",
    "Descheduler finishes checking.",
    "database remains unchanged.",
  ]);
  assert.equal(result.corrections.filter((entry) => entry.status === "accepted").length, 2);
  assert.deepEqual(result.corrections.filter((entry) => entry.from === "database")
    .map(({ status, reason }) => ({ status, reason })), [
    { status: "rejected", reason: "explicit_alias_required" },
  ]);
});

test("two occurrences in one segment establish recording consensus", async () => {
  const source = sourceMeeting(["disk scheduler starts, then disk scheduler checks again."]);
  const result = await withMockFetch(async (_url, options) => {
    const payload = correctionPayload(options);
    return chatResponse({
      patches: [{
        id: payload.segments[0].id,
        replacements: [{ from: "disk scheduler", to: "Descheduler" }],
      }],
      join_after: [],
    });
  }, () => correctTranscript({ config: chatConfig(), meeting: source }));

  assert.equal(result.segments[0].text, "Descheduler starts, then Descheduler checks again.");
  assert.deepEqual(result.terminology, ["Descheduler"]);
  assert.equal(result.rejectedCorrections, 0);
  assert.deepEqual(result.corrections.map(({ from, to, status, reason, start_offset, end_offset }) => ({
    from, to, status, reason, start_offset, end_offset,
  })), [
    {
      from: "disk scheduler", to: "Descheduler", status: "accepted", reason: "recording_consensus", start_offset: 0, end_offset: 14,
    },
    {
      from: "disk scheduler", to: "Descheduler", status: "accepted", reason: "recording_consensus", start_offset: 28, end_offset: 42,
    },
  ]);
});

test("terminology matching handles invisible separators and Unicode boundaries without crossing sentences", async () => {
  const source = sourceMeeting([
    "d\u00adschedule",
    "d\u200bschedule",
    "d\u2060schedule",
    "d\u2212schedule",
    "cafe\u0301",
    "service. mesh",
    "éapp app",
    "myapi网关x and api网关",
  ]);
  const contextHint = "术语：d-schedule -> Descheduler、café -> CafeService、service mesh -> ServiceMesh、app -> Application、api网关 -> APIGateway";
  const result = await withMockFetch(
    async () => chatResponse({ patches: [], join_after: [] }),
    () => correctTranscript({ config: chatConfig(contextHint), meeting: source }),
  );

  assert.deepEqual(result.segments.map((segment) => segment.text), [
    "Descheduler",
    "Descheduler",
    "Descheduler",
    "Descheduler",
    "CafeService",
    "service. mesh",
    "éapp Application",
    "myapi网关x and APIGateway",
  ]);
  assert.equal(result.rejectedCorrections, 0);
  assert.equal(result.corrections.filter((entry) => entry.status === "accepted").length, 7);
  assert.equal(result.corrections.some((entry) => entry.from === "service. mesh"), false);
  assert.equal(result.corrections.some((entry) => entry.from === "app" && entry.start_offset === 1), false);
});

test("a canonical containing its alias stays idempotent in correction, summaries, public data, and QA", async () => {
  const source = sourceMeeting(["scheduler and Descheduler remain stable."]);
  const config = chatConfig("术语：scheduler -> Descheduler");
  const corrected = await withMockFetch(
    async () => chatResponse({ patches: [], join_after: [] }),
    () => correctTranscript({ config, meeting: source }),
  );
  assert.equal(corrected.segments[0].text, "Descheduler and Descheduler remain stable.");

  const retried = await withMockFetch(
    async () => chatResponse({ patches: [], join_after: [] }),
    () => correctTranscript({ config, meeting: { ...source, ...corrected } }),
  );
  assert.equal(retried.segments[0].text, corrected.segments[0].text);

  const correctedMeeting = { ...source, ...corrected };
  const summary = await withMockFetch(
    async () => chatResponse({
      title: "Descheduler review",
      summary: "scheduler and Descheduler remain stable.",
      keywords: ["scheduler", "Descheduler"],
      highlights: [],
      speaker_summaries: [],
      decisions: [],
      decision_records: [],
      action_items: [],
    }),
    () => summarizeTranscript({ config, meeting: correctedMeeting }),
  );
  assert.equal(summary.title, "Descheduler会议纪要");
  assert.equal(summary.summary, "[00:00] A：Descheduler and Descheduler remain stable.");
  assert.deepEqual(summary.keywords, ["Descheduler"]);

  const publicInput = {
    ...correctedMeeting,
    title: "Descheduler review",
    summary: "scheduler and Descheduler remain stable.",
    keywords: ["Descheduler"],
    createdAt: "2026-08-03T00:00:00.000Z",
    duration: 3,
  };
  const published = publicMeeting(publicInput);
  assert.equal(published.title, "Descheduler review");
  assert.equal(published.summary, "Descheduler and Descheduler remain stable.");
  assert.deepEqual(published.keywords, ["Descheduler"]);
  assert.deepEqual(publicMeeting(publicInput), published);

  const answer = await withMockFetch(
    async () => chatResponse("scheduler and Descheduler remain stable."),
    () => askTranscript({ config, meeting: correctedMeeting, question: "Which scheduler remains stable?" }),
  );
  assert.equal(answer, "Descheduler and Descheduler remain stable.");
});

test("generated terminology normalization preserves identity fields and canonical formatting", async () => {
  const source = sourceMeeting(["app will review disk scheduler."]);
  source.rawSegments[0].speaker = "App";
  const config = chatConfig("术语：app -> Application、disk scheduler -> Descheduler");
  const corrected = await withMockFetch(
    async () => chatResponse({ patches: [], join_after: [] }),
    () => correctTranscript({ config, meeting: source }),
  );
  const correctedMeeting = { ...source, ...corrected };

  const summary = await withMockFetch(
    async () => chatResponse({
      title: "descheduler review",
      summary: "De-scheduler reviews app.",
      keywords: ["De scheduler", "descheduler"],
      highlights: [],
      speaker_summaries: [{
        speaker: "App",
        summary: "app reviews descheduler.",
        key_points: ["de-scheduler"],
        evidence: [{ start_seconds: 0, quote: "app will review descheduler." }],
      }],
      decisions: [],
      decision_records: [],
      action_items: [{ task: "app checks de scheduler", owner: "App", due: "app", start_seconds: 0, evidence: "app will review descheduler." }],
    }),
    () => summarizeTranscript({ config, meeting: correctedMeeting }),
  );

  assert.equal(summary.title, "Descheduler会议纪要");
  assert.equal(summary.summary, "[00:00] App：Application will review Descheduler.");
  assert.deepEqual(summary.keywords, ["Descheduler"]);
  assert.deepEqual(summary.speaker_summaries, [{
    speaker: "App",
    summary: "Application will review Descheduler.",
    key_points: ["Application will review Descheduler."],
    evidence: [{ start_seconds: 0, speaker: "App", quote: "Application will review Descheduler." }],
  }]);
  assert.deepEqual(summary.action_items, [{
    task: "Application will review Descheduler.",
    owner: "",
    due: "",
    start_seconds: 0,
    speaker: "App",
    evidence: "Application will review Descheduler.",
  }]);

  const published = publicMeeting({ ...correctedMeeting, ...summary });
  assert.equal(published.speaker_summaries[0].speaker, "App");
  assert.equal(published.action_items[0].owner, "");
  assert.equal(published.action_items[0].due, "");

  const answer = await withMockFetch(
    async () => chatResponse("de scheduler and app"),
    () => askTranscript({ config, meeting: correctedMeeting, question: "Which terms?" }),
  );
  assert.equal(answer, "Descheduler and Application");
});
