import test from "node:test";
import assert from "node:assert/strict";
import {
  askTranscript,
  correctTranscript,
  publicMeeting,
  summarizeTranscript,
} from "../src/api.js";

const config = {
  asrBaseUrl: "https://mimo.example/v1",
  asrApiKey: "asr-secret",
  asrModel: "mimo-v2.5-asr",
  asrProtocol: "mimo-chat",
  asrPath: "chat/completions",
  chatBaseUrl: "https://gpt.example/v1",
  chatApiKey: "gpt-secret",
  chatModel: "gpt-test",
  chatProtocol: "chat-completions",
  chatPath: "chat/completions",
  contextHint: "",
};

const meetingBase = {
  id: "mapping-graph-meeting",
  title: "术语图测试",
  createdAt: "2026-08-03T00:00:00.000Z",
  duration: 10,
  language: "zh",
  keywords: [],
  highlights: [],
  speaker_summaries: [],
  decisions: [],
  decision_records: [],
  action_items: [],
};

test("explicit mapping chains close over their terminal canonical and remain idempotent", async () => {
  const rawSegments = [{
    start_seconds: 0,
    end_seconds: 10,
    speaker: "A",
    text: "alpha beta alpha",
  }];
  const source = { ...meetingBase, rawSegments, segments: rawSegments, asrReconciliations: [] };

  await withFetch(correctionMock([]), async () => {
    const correctionConfig = { ...config, contextHint: "术语：alpha -> beta、beta -> gamma" };
    const first = await correctTranscript({ config: correctionConfig, meeting: source });
    const second = await correctTranscript({ config: correctionConfig, meeting: { ...source, ...first } });

    assert.equal(first.segments[0].text, "gamma gamma gamma");
    assert.deepEqual(first.terminology, ["gamma"]);
    assert.equal(first.rejectedCorrections, 0);
    assert.equal(first.corrections.length, 3);
    assert.equal(first.corrections.every((entry) => entry.status === "accepted" && entry.to === "gamma"), true);
    assert.deepEqual(second, first);
  });
});

test("recording-inferred aliases close over an explicit mapping terminal", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 3, speaker: "A", text: "betaa first" },
    { start_seconds: 3, end_seconds: 6, speaker: "A", text: "betaa second" },
    { start_seconds: 6, end_seconds: 9, speaker: "A", text: "beta direct" },
  ];
  const source = { ...meetingBase, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const patches = [
    { id: 0, replacements: [{ from: "betaa", to: "beta" }] },
    { id: 1, replacements: [{ from: "betaa", to: "beta" }] },
  ];

  await withFetch(correctionMock(patches), async () => {
    const result = await correctTranscript({
      config: { ...config, contextHint: "术语：beta -> Gamma" },
      meeting: source,
    });

    assert.deepEqual(result.segments.map((segment) => segment.text), ["Gamma first", "Gamma second", "Gamma direct"]);
    assert.deepEqual(result.terminology, ["Gamma"]);
    assert.equal(result.rejectedCorrections, 0);
    assert.equal(result.corrections.length, 3);
    assert.deepEqual(result.corrections.map(({ from, to, status, reason }) => ({ from, to, status, reason })), [
      { from: "betaa", to: "Gamma", status: "accepted", reason: "recording_consensus" },
      { from: "betaa", to: "Gamma", status: "accepted", reason: "recording_consensus" },
      { from: "beta", to: "Gamma", status: "accepted", reason: "explicit_alias" },
    ]);
  });
});

test("cyclic explicit mappings reject the whole group without partial transcript changes", async () => {
  const rawSegments = [{
    start_seconds: 0,
    end_seconds: 10,
    speaker: "A",
    text: "alpha beta gamma",
  }];
  const source = { ...meetingBase, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const patches = [{
    id: 0,
    replacements: [
      { from: "alpha", to: "beta" },
      { from: "beta", to: "gamma" },
      { from: "gamma", to: "alpha" },
    ],
  }];

  await withFetch(correctionMock(patches), async () => {
    const result = await correctTranscript({
      config: { ...config, contextHint: "术语：alpha -> beta、beta -> gamma、gamma -> alpha" },
      meeting: source,
    });

    assert.deepEqual(result.segments.map((segment) => segment.text), rawSegments.map((segment) => segment.text));
    assert.deepEqual(result.terminology, []);
    assert.equal(result.rejectedCorrections, 3);
    assert.equal(result.corrections.length, 3);
    assert.equal(result.corrections.every((entry) => (
      entry.status === "rejected" && entry.reason === "conflicting_alias_mapping"
    )), true);
  });
});

test("recording inference preserves an entire alias group when only one mapping slot remains", async () => {
  const rawSegments = [
    { start_seconds: 0, end_seconds: 5, speaker: "A", text: "dis scheduler 开始检查。" },
    { start_seconds: 5, end_seconds: 10, speaker: "A", text: "disk scheduler 完成检查。" },
  ];
  const source = { ...meetingBase, rawSegments, segments: rawSegments, asrReconciliations: [] };
  const placeholders = Array.from({ length: 199 }, (_, index) => {
    const suffix = String.fromCharCode(0x3400 + index);
    return `甲${suffix}->乙${suffix}`;
  }).join("、");
  const patches = [
    { id: 0, replacements: [{ from: "dis scheduler", to: "Descheduler" }] },
    { id: 1, replacements: [{ from: "disk scheduler", to: "Descheduler" }] },
  ];

  await withFetch(correctionMock(patches), async () => {
    const result = await correctTranscript({
      config: { ...config, contextHint: `术语：${placeholders}` },
      meeting: source,
    });

    assert.deepEqual(result.segments.map((segment) => segment.text), rawSegments.map((segment) => segment.text));
    assert.deepEqual(result.terminology, []);
    assert.equal(result.rejectedCorrections, 2);
    assert.deepEqual(result.corrections.map(({ from, status, reason }) => ({ from, status, reason })), [
      { from: "dis scheduler", status: "rejected", reason: "unknown_canonical" },
      { from: "disk scheduler", status: "rejected", reason: "unknown_canonical" },
    ]);
  });
});

test("invalid or cross-recording accepted ledgers cannot rewrite summaries, answers, or public data", async (t) => {
  const alias = "stalealias";
  const canonical = "CanonicalTerm";
  const raw = { start_seconds: 0, end_seconds: 6, speaker: "A", text: `${alias} was discussed.` };
  const source = { ...meetingBase, rawSegments: [raw], segments: [raw], asrReconciliations: [] };
  const corrected = await withFetch(correctionMock([]), () => correctTranscript({
    config: { ...config, contextHint: `术语：${alias} -> ${canonical}` },
    meeting: source,
  }));
  const validMeeting = insightMeeting({ ...source, ...corrected }, alias);

  await withFetch(generatedTextMock(alias), async () => {
    const controlSummary = await summarizeTranscript({ config, meeting: validMeeting });
    const controlAnswer = await askTranscript({ config, meeting: validMeeting, question: "使用了什么术语？" });
    const controlPublic = publicMeeting(validMeeting);
    assert.equal(controlSummary.title, `${canonical}会议纪要`);
    assert.match(controlSummary.summary, new RegExp(canonical));
    assert.doesNotMatch(controlSummary.summary, /stalealias summary/);
    assert.equal(controlAnswer, `${canonical} answer`);
    assert.equal(controlPublic.title, `${canonical} title`);

    const validEntry = corrected.corrections[0];
    const attacks = [
      {
        name: "forged source hash",
        meeting: insightMeeting({
          ...validMeeting,
          corrections: [{ ...validEntry, source_hash: "fnv1a32:00000000" }],
        }, alias),
      },
      {
        name: "wrong correction offset",
        meeting: insightMeeting({
          ...validMeeting,
          corrections: [{
            ...validEntry,
            start_offset: validEntry.start_offset + 1,
            end_offset: validEntry.end_offset + 1,
          }],
        }, alias),
      },
      {
        name: "stale source hash after raw transcript change",
        meeting: insightMeeting({
          ...validMeeting,
          rawSegments: [{ ...raw, text: `prefix ${raw.text}` }],
          segments: [{ ...corrected.segments[0], text: `prefix ${corrected.segments[0].text}` }],
          corrections: [{ ...validEntry }],
        }, alias),
      },
      {
        name: "accepted ledger copied from another recording",
        meeting: insightMeeting({
          ...validMeeting,
          id: "different-recording",
          rawSegments: [{ ...raw, speaker: "B", text: `other recording mentions ${alias}.` }],
          segments: [{ ...raw, speaker: "B", text: `other recording mentions ${alias}.` }],
          corrections: [{ ...validEntry }],
        }, alias),
      },
      {
        name: "orphan accepted entry outside the source recording",
        meeting: insightMeeting({
          ...validMeeting,
          corrections: [
            ...validMeeting.corrections,
            { ...validEntry, segmentId: 99 },
          ],
        }, alias),
      },
    ];

    for (const attack of attacks) {
      await t.test(attack.name, async () => {
        const summary = await summarizeTranscript({ config, meeting: attack.meeting });
        const answer = await askTranscript({ config, meeting: attack.meeting, question: "使用了什么术语？" });
        const shared = publicMeeting(attack.meeting);

        assert.notEqual(summary.title, `${canonical}会议纪要`);
        assert.doesNotMatch(`${summary.title}\n${summary.summary}`, new RegExp(canonical));
        assert.doesNotMatch(summary.summary, new RegExp(`${alias} summary`));
        assert.equal(summary.keywords.includes(canonical), false);
        assert.equal(answer, `${alias} answer`);
        assert.equal(shared.title, `${alias} title`);
        assert.equal(shared.summary, `${alias} summary`);
        assert.deepEqual(shared.keywords, [alias]);
      });
    }
  });
});

function correctionMock(patches) {
  return async () => chatResponse(JSON.stringify({ patches, join_after: [] }));
}

function generatedTextMock(alias) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages?.[0]?.content || "";
    if (system.includes("会议纪要助手")) {
      return chatResponse(JSON.stringify({
        title: `${alias} title`,
        summary: `${alias} summary`,
        keywords: [alias],
        highlights: [],
        speaker_summaries: [],
        decisions: [],
        decision_records: [],
        action_items: [],
      }));
    }
    return chatResponse(`${alias} answer`);
  };
}

function insightMeeting(meeting, alias) {
  return {
    ...meeting,
    title: `${alias} title`,
    summary: `${alias} summary`,
    keywords: [alias],
    highlights: [],
    speaker_summaries: [],
    decisions: [],
    decision_records: [],
    action_items: [],
  };
}

function chatResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "content-type": "application/json" },
  });
}

async function withFetch(fetchImplementation, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
