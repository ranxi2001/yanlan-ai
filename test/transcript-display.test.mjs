import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  buildShareHtml,
  publicMeeting,
  readableTranscriptSegments,
  toMarkdown,
  toVtt,
  transcriptDisplaySegments,
} from "../src/api.js";

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function providerSegment(start, end, speaker, text) {
  return { start_seconds: start, end_seconds: end, timing_source: "provider", speaker, text };
}

test("display projection collapses an exact Chinese boundary overlap with replayable provenance", () => {
  const segments = freezeDeep([
    providerSegment(0, 10, "A", "服务部署"),
    providerSegment(9.5, 20, "A", "服务部署，然后验证回滚流程"),
  ]);
  const before = structuredClone(segments);

  const display = transcriptDisplaySegments(segments);

  assert.equal(display.length, 2);
  assert.deepEqual(display.map((segment) => segment.start_seconds), [0, 9.5]);
  assert.deepEqual(display.map((segment) => segment.text), ["服务部署", "然后验证回滚流程"]);
  assert.deepEqual(display[1].source_segment_ids, [1]);
  assert.deepEqual(display[1].collapsed_overlap, {
    algorithm_version: "display-overlap-v1",
    reason: "exact_normalized_boundary_overlap",
    matched_segment_id: 0,
    matched_start_offset: 0,
    matched_end_offset: 4,
    source_segment_id: 1,
    source_start_offset: 0,
    source_end_offset: 4,
    hidden_end_offset: 5,
    matched_text: "服务部署",
    source_text: "服务部署",
    hidden_text: "服务部署，",
    normalized_text: "服务部署",
  });
  assert.equal(
    display[1].source_text.slice(
      display[1].collapsed_overlap.source_start_offset,
      display[1].collapsed_overlap.source_end_offset,
    ),
    display[1].collapsed_overlap.source_text,
  );
  assert.deepEqual(segments, before);
});

test("display projection keeps a fully duplicated source row and its own seek time", () => {
  const segments = [
    providerSegment(0, 10, "A", "已确认核心服务部署完成"),
    providerSegment(8.5, 20, "A", "已确认核心服务部署完成"),
  ];

  const display = transcriptDisplaySegments(segments);

  assert.equal(display.length, 2);
  assert.equal(display[1].start_seconds, 8.5);
  assert.equal(display[1].text, "");
  assert.equal(display[1].source_text, segments[1].text);
  assert.equal(display[1].collapsed_overlap.hidden_end_offset, segments[1].text.length);
});

test("display projection collapses long full duplicates without truncating the hidden range", () => {
  for (const units of [161, 200, 800]) {
    const text = "部".repeat(units);
    const segments = [
      providerSegment(0, 100, "A", text),
      providerSegment(0, 100, "A", text),
    ];
    const display = transcriptDisplaySegments(segments);

    assert.equal(display[1].text, "");
    assert.equal(display[1].collapsed_overlap.hidden_end_offset, text.length);
    assert.equal(display[1].collapsed_overlap.normalized_text.length, units);
  }
});

test("display provenance offsets replay against canonical untrimmed source segments", () => {
  const segments = [
    providerSegment(0, 10, "A", "  服务部署  "),
    providerSegment(9.5, 20, "A", "  服务部署，然后验证  "),
  ];
  const display = transcriptDisplaySegments(segments);
  const provenance = display[1].collapsed_overlap;

  assert.equal(display[1].source_text, segments[1].text);
  assert.equal(display[1].text, "然后验证");
  assert.equal(
    segments[provenance.matched_segment_id].text.slice(
      provenance.matched_start_offset,
      provenance.matched_end_offset,
    ),
    provenance.matched_text,
  );
  assert.equal(
    segments[provenance.source_segment_id].text.slice(
      provenance.source_start_offset,
      provenance.source_end_offset,
    ),
    provenance.source_text,
  );
  assert.equal(
    segments[provenance.source_segment_id].text.slice(0, provenance.hidden_end_offset),
    provenance.hidden_text,
  );
});

test("display projection handles complete Latin tokens but never fuzzy word stems", () => {
  const exact = transcriptDisplaySegments([
    providerSegment(0, 10, "A", "Service deployment."),
    providerSegment(9.5, 20, "A", "Service deployment, then verified rollback."),
  ]);
  assert.equal(exact[1].text, "then verified rollback.");
  assert.equal(exact[1].collapsed_overlap.normalized_text, "servicedeployment");

  const stem = transcriptDisplaySegments([
    providerSegment(0, 10, "A", "We completed ResourceBinding"),
    providerSegment(9.5, 20, "A", "ResourceBindings remain compatible"),
  ]);
  assert.equal(stem[1].text, "ResourceBindings remain compatible");
  assert.equal(stem[1].collapsed_overlap, undefined);

  const compatibilityCharacter = transcriptDisplaySegments([
    providerSegment(0, 10, "A", "ﬃservice deployment"),
    providerSegment(9.5, 20, "A", "iservice deployment, then verify"),
  ]);
  assert.equal(compatibilityCharacter[1].text, "iservice deployment, then verify");
  assert.equal(compatibilityCharacter[1].collapsed_overlap, undefined);
});

test("display projection rejects unsafe timing, speaker, short, and critical overlaps", () => {
  const cases = [
    [
      providerSegment(0, 10, "A", "服务部署"),
      providerSegment(10, 20, "A", "服务部署，然后验证"),
    ],
    [
      providerSegment(0, 10, "A", "服务部署"),
      providerSegment(9.5, 20, "B", "服务部署，然后验证"),
    ],
    [
      { ...providerSegment(0, 10, "A", "服务部署"), timing_source: "inferred" },
      providerSegment(9.5, 20, "A", "服务部署，然后验证"),
    ],
    [
      providerSegment(0, 10, "A", "数据"),
      providerSegment(9.5, 20, "A", "数据还需要处理"),
    ],
    [
      providerSegment(0, 10, "A", "我们不建议录用"),
      providerSegment(9.5, 20, "A", "建议录用候选人"),
    ],
    [
      providerSegment(0, 10, "A", "预算不是 100 万"),
      providerSegment(9.5, 20, "A", "100 万预算已批准"),
    ],
    [
      providerSegment(0, 10, "A", "We do not approve this release"),
      providerSegment(9.5, 20, "A", "not approve this release until review"),
    ],
    [
      providerSegment(0, 10, "A", "abc服务部署"),
      providerSegment(9.5, 20, "A", "bc服务部署继续验证"),
    ],
    [
      providerSegment(0, 10, "A", "我们不考虑这个方案"),
      providerSegment(9.5, 20, "A", "考虑这个方案，继续推进"),
    ],
    [
      providerSegment(0, 10, "A", "如果采用这个方案"),
      providerSegment(9.5, 20, "A", "采用这个方案，下周发布"),
    ],
    [
      providerSegment(0, 10, "A", "是否采用这个方案？"),
      providerSegment(9.5, 20, "A", "采用这个方案，下周发布"),
    ],
    [
      providerSegment(0, 10, "A", "We need to re-sign the contract"),
      providerSegment(9.5, 20, "A", "resign the contract after review"),
    ],
    [
      providerSegment(0, 10, "Ann A", "We completed the service deployment"),
      providerSegment(9.5, 20, "Anna", "service deployment needs review"),
    ],
    [
      providerSegment(0, 10, "A", "已经讨论上线方案"),
      providerSegment(9.999_999, 20, "A", "上线方案需要调整"),
    ],
    [
      { start_seconds: 0, end_seconds: 10, speaker: "A", text: "已经讨论上线方案" },
      { start_seconds: 9.5, end_seconds: 20, speaker: "A", text: "上线方案需要调整" },
    ],
    [
      providerSegment(0, 10, "A", "We discussed the rapist report"),
      providerSegment(9.5, 20, "A", "therapist report requires review"),
    ],
    [
      providerSegment(0, 10, "A", "如果市场反馈良好，我们再讨论上线方案"),
      providerSegment(9.5, 20, "A", "上线方案需要立即执行"),
    ],
    [
      providerSegment(0, 10, "A", "风险评估"),
      providerSegment(9.5, 20, "A", "风险评估，风险评估，这一步不能省略"),
    ],
    [
      providerSegment(0, 10, "A", "C++ service runtime"),
      providerSegment(9.5, 20, "A", "C service runtime requires review"),
    ],
    [
      providerSegment(0, 10, "A", "C# service runtime"),
      providerSegment(9.5, 20, "A", "C service runtime requires review"),
    ],
    [
      providerSegment(0, 10, "A", "read/write service"),
      providerSegment(9.5, 20, "A", "readwrite service requires review"),
    ],
    [
      providerSegment(0, 10, "A", "核心服务🚀部署完成"),
      providerSegment(9.5, 20, "A", "核心服务🛑部署完成，然后验证"),
    ],
    [
      providerSegment(0, 10, "A", "服务部署"),
      providerSegment(9.5, 20, "A", "服务部署\uFE0F，然后验证"),
    ],
    [
      providerSegment(0, 10, "A", "project resume"),
      providerSegment(9.5, 20, "A", "project resume\u0301, then review"),
    ],
    [
      providerSegment(0, 10, "A", "We shouldn't use release plan"),
      providerSegment(9.5, 20, "A", "release plan starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "我们切记勿采用上线方案"),
      providerSegment(9.5, 20, "A", "上线方案立即执行"),
    ],
    [
      providerSegment(0, 10, "A", "If tests pass; we discuss release plan"),
      providerSegment(9.5, 20, "A", "release plan starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "Once tests pass, we discuss release plan"),
      providerSegment(9.5, 20, "A", "release plan starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "风险评估"),
      providerSegment(9.5, 20, "A", "风险评估，我再说一遍，风险评估不能省略"),
    ],
    [
      providerSegment(0, 10, "A", "C* service runtime"),
      providerSegment(9.5, 20, "A", "C service runtime requires review"),
    ],
    [
      providerSegment(0, 10, "A", "核心服务👩‍💻部署完成"),
      providerSegment(9.5, 20, "A", "核心服务👩💻部署完成，然后验证"),
    ],
    [
      providerSegment(0, 10, "A", "проект система"),
      providerSegment(9.5, 20, "A", "проектсистема требует проверки"),
    ],
    [
      providerSegment(0, 10, "A", "前一段最后完整说明核心服务部署和回滚验证流程"),
      providerSegment(9.5, 20, "A", "核心服务部署和回滚验证流程需要在下一阶段重新讨论"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment review"),
      providerSegment(9, 9.05, "A", "service deployment review then verify"),
    ],
    [
      providerSegment(0, 10, "A", "std::vector runtime"),
      providerSegment(9.5, 20, "A", "std vector runtime requires review"),
    ],
    [
      providerSegment(0, 10, "A", "Polish deployment plan"),
      providerSegment(9.5, 20, "A", "polish deployment plan before review"),
    ],
    [
      providerSegment(0, 10, "A", "Let's eat grandma"),
      providerSegment(9.5, 20, "A", "Let's eat, grandma before six"),
    ],
    [
      providerSegment(0, 10, "A", "release plan"),
      providerSegment(9.5, 20, "A", "“release plan starts tomorrow”"),
    ],
    [
      providerSegment(0, 10, "A", "release plan..."),
      providerSegment(9.5, 20, "A", "release plan starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "release plan"),
      providerSegment(9.5, 20, "A", "release plan... status unknown"),
    ],
    [
      providerSegment(0, 10, "A", "If ready use release plan"),
      providerSegment(9.5, 20, "A", "If ready use release plan starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "我们采用上线方案吗"),
      providerSegment(9.5, 20, "A", "我们采用上线方案吗立即执行"),
    ],
    [
      providerSegment(0, 10, "A", "核心服务部署和回滚验证流程"),
      providerSegment(9.5, 20, "A", "核心服务部署和回滚验证流程需要重新讨论"),
    ],
    [
      providerSegment(0, 10, "A", "план выпуска"),
      providerSegment(9.5, 20, "A", "план выпускать завтра"),
    ],
    [
      providerSegment(0, 10, "A", "خطة الإصدار"),
      providerSegment(9.5, 20, "A", "خطة الإصدارات الجديدة"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment"),
      providerSegment(9.5, 20, "A", "service deployment.com launches tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment"),
      providerSegment(9.5, 20, "A", "service deployment:v2 launches tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "核心服务部署"),
      providerSegment(9.5, 20, "A", "核心服务部署🚀完成验证"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment"),
      providerSegment(9.5, 20, "A", "service deployment\u2060api starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment"),
      providerSegment(9.5, 20, "A", "service deployment\u202Eapi starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment"),
      providerSegment(9.5, 20, "A", "service deployment\u0000api starts tomorrow"),
    ],
    [
      providerSegment(0, 10, "A", "service deployment"),
      providerSegment(9.5, 20, "A", "service deployment\uE000api starts tomorrow"),
    ],
  ];

  assert.deepEqual(cases.map((segments) => transcriptDisplaySegments(segments)[1].collapsed_overlap),
    new Array(cases.length).fill(undefined));
});

test("display projection consumes harmless terminal punctuation instead of leaving an orphan row", () => {
  const display = transcriptDisplaySegments([
    providerSegment(0, 10, "A", "服务部署"),
    providerSegment(9.5, 20, "A", "服务部署。"),
  ]);

  assert.equal(display[1].text, "");
  assert.equal(display[1].collapsed_overlap.hidden_text, "服务部署。");

  for (const punctuation of ["？", "……"]) {
    const preserved = transcriptDisplaySegments([
      providerSegment(0, 10, "A", "服务部署"),
      providerSegment(9.5, 20, "A", `服务部署${punctuation}`),
    ]);
    assert.equal(preserved[1].text, `服务部署${punctuation}`);
    assert.equal(preserved[1].collapsed_overlap, undefined);
  }
});

test("display projection treats composed and decomposed graphemes consistently", () => {
  const display = transcriptDisplaySegments([
    providerSegment(0, 10, "A", "café project"),
    providerSegment(9.5, 20, "A", "cafe\u0301 project, then review"),
  ]);

  assert.equal(display[1].text, "then review");
  assert.equal(display[1].collapsed_overlap.source_text, "cafe\u0301 project");
});

test("an overlap row remains independent from a following semantic join", () => {
  const display = transcriptDisplaySegments([
    providerSegment(0, 10, "A", "服务部署"),
    { ...providerSegment(9.5, 20, "A", "服务部署，然后验证回滚流程"), join_next: true },
    providerSegment(20, 25, "A", "并记录验证结果。"),
  ]);

  assert.equal(display.length, 3);
  assert.equal(display[1].text, "然后验证回滚流程");
  assert.equal(display[1].source_text, "服务部署，然后验证回滚流程");
  assert.deepEqual(display[1].source_segment_ids, [1]);
  assert.deepEqual(display[2].source_segment_ids, [2]);
});

test("public transcript timing provenance keeps inferred overlaps expanded", () => {
  const meeting = {
    title: "Inferred timing",
    createdAt: "2026-08-06T00:00:00.000Z",
    duration: 20,
    segments: [
      { ...providerSegment(0, 10, "A", "服务部署"), timing_source: "inferred" },
      { ...providerSegment(9.5, 20, "A", "服务部署，然后验证"), timing_source: "inferred" },
    ],
  };

  const once = publicMeeting(meeting);
  const twice = publicMeeting(once);
  assert.deepEqual(once, twice);
  assert.deepEqual(once.segments.map((segment) => segment.timing_inferred), [true, true]);
  assert.equal(transcriptDisplaySegments(once.segments)[1].collapsed_overlap, undefined);
});

test("public transcript preserves verified provider timing without exposing provider internals", () => {
  const meeting = {
    title: "Provider timing",
    createdAt: "2026-08-06T00:00:00.000Z",
    duration: 20,
    segments: [
      providerSegment(0, 10, "A", "服务部署"),
      providerSegment(9.5, 20, "A", "服务部署，然后验证"),
    ],
  };

  const once = publicMeeting(meeting);
  const twice = publicMeeting(once);
  assert.deepEqual(once, twice);
  assert.deepEqual(once.segments.map((segment) => segment.timing_verified), [true, true]);
  assert.equal(Object.hasOwn(once.segments[0], "timing_source"), false);
  assert.equal(transcriptDisplaySegments(once.segments)[1].text, "然后验证");
});

test("readable transcript API does not expose display-only source ids", () => {
  const readable = readableTranscriptSegments([
    { ...providerSegment(0, 10, "A", "第一段"), join_next: true },
    providerSegment(10, 20, "A", "第二段"),
  ]);

  assert.equal(Object.hasOwn(readable[0], "source_segment_ids"), false);
});

test("display projection remains linear at one-hour transcript scale", () => {
  const segments = Array.from({ length: 1_440 }, (_, index) => {
    const start = index * 2.5;
    return providerSegment(start, start + 3, "A", `${"a".repeat(199)}${index % 2 ? "b" : "c"}`);
  });

  const startedAt = performance.now();
  const display = transcriptDisplaySegments(segments);
  const elapsed = performance.now() - startedAt;

  assert.equal(display.length, segments.length);
  assert.ok(elapsed < 2_000, `expected a linear projection under 2s, received ${elapsed.toFixed(1)}ms`);
});

test("overlap display never changes canonical public, Markdown, or WebVTT facts", () => {
  const segments = [
    providerSegment(0, 10, "A", "服务部署"),
    providerSegment(9.5, 20, "A", "服务部署，然后验证回滚流程"),
  ];
  const meeting = {
    title: "Overlap fixture",
    createdAt: "2026-08-06T00:00:00.000Z",
    duration: 20,
    segments,
  };

  assert.deepEqual(publicMeeting(meeting).segments.map((segment) => segment.text), segments.map((segment) => segment.text));
  assert.equal((toVtt(meeting).match(/-->/g) || []).length, 2);
  assert.match(toVtt(meeting), /服务部署，然后验证回滚流程/u);
  assert.match(toMarkdown(meeting), /### 00:09 · A\n\n服务部署，然后验证回滚流程/u);
  const html = buildShareHtml(meeting);
  assert.match(html, /display-overlap-v1/);
  assert.match(html, /服务部署，然后验证回滚流程/u);
  assert.doesNotMatch(html, /timing_source|rawSegments|provider_debug/);
});

test("offline share bounds transcript pages and avoids an unchanged display payload copy", () => {
  const collisionText = ",ds=m.display_segments||m.segments;const interview=";
  const meeting = {
    title: "Long offline transcript",
    createdAt: "2026-08-06T00:00:00.000Z",
    duration: 241,
    segments: Array.from({ length: 241 }, (_, index) => (
      providerSegment(index, index + 0.5, "A", index === 0 ? collisionText : `segment-${index}`)
    )),
  };

  const html = buildShareHtml(meeting);

  assert.doesNotMatch(html, /"display_segments":/u);
  assert.match(html, /ps=200/u);
  assert.match(html, /aria-label="最后一页"/u);
  assert.match(html, /id="transcriptRows"/u);
  const payloadStart = html.indexOf("const m=") + "const m=".length;
  const payloadEnd = html.indexOf(";const e=", payloadStart);
  assert.equal(JSON.parse(html.slice(payloadStart, payloadEnd)).segments[0].text, collisionText);
});
