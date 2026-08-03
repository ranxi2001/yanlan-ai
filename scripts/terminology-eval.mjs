import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, correctTranscript } from "../src/api.js";

export const DEFAULT_TERMINOLOGY_SPEC = fileURLToPath(new URL(
  "../data/cloud-native-weekly-01.terminology-eval.json",
  import.meta.url,
));

export async function runTerminologyEvaluation(specPath = DEFAULT_TERMINOLOGY_SPEC) {
  const resolvedSpecPath = resolve(specPath);
  const spec = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
  validateSpec(spec);

  const specDirectory = dirname(resolvedSpecPath);
  const audioPath = resolve(specDirectory, spec.audio.path);
  const shareHtmlPath = resolve(specDirectory, spec.share_html.path);
  const [audio, shareHtml] = await Promise.all([
    readFile(audioPath),
    readFile(shareHtmlPath, "utf8"),
  ]);
  const audioSha256 = createHash("sha256").update(audio).digest("hex");
  assert.equal(audioSha256, spec.audio.sha256.toLowerCase(), "audio SHA-256 does not match the corpus spec");

  const meeting = parseShareMeeting(shareHtml);
  assert.ok(Array.isArray(meeting.segments) && meeting.segments.length, "share fixture has no transcript segments");
  const originalGeometry = transcriptGeometry(meeting.segments);
  const historicalText = transcriptText(meeting.segments);
  const observedOccurrences = countTerms(historicalText, spec.terminology.aliases);
  assert.equal(
    observedOccurrences,
    spec.terminology.expected_occurrences,
    "historical share fixture no longer contains the expected terminology corpus",
  );

  const mock = createCorrectionMock(spec.terminology);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  let corrected;
  try {
    corrected = await correctTranscript({
      config: correctionConfig(spec.terminology),
      meeting,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const correctedText = transcriptText(corrected.segments);
  const canonicalOccurrences = countLiteral(correctedText, spec.terminology.canonical);
  const forbiddenOccurrences = countTerms(correctedText, spec.terminology.aliases);
  const acceptedCorrections = corrected.corrections.filter((entry) => entry.status === "accepted");
  const rejectedCorrections = corrected.corrections.filter((entry) => entry.status === "rejected");

  assert.equal(canonicalOccurrences, spec.terminology.expected_occurrences, "not every observed alias became the canonical term");
  assert.equal(forbiddenOccurrences, 0, "one or more forbidden aliases remain in the corrected transcript");
  assert.deepEqual(transcriptGeometry(corrected.segments), originalGeometry, "correction changed timestamps or speakers");
  assert.equal(acceptedCorrections.length, spec.terminology.expected_occurrences, "correction ledger is missing accepted occurrences");
  assert.equal(rejectedCorrections.length, 0, "correction ledger contains rejected terminology patches");
  assert.equal(corrected.rejectedCorrections, 0, "correction result reports rejected terminology patches");
  assert.ok(acceptedCorrections.every((entry) => entry.to === spec.terminology.canonical), "ledger contains a non-canonical target");
  assert.ok(acceptedCorrections.every((entry) => entry.reason === "recording_consensus"), "fixture bypassed recording-wide consensus");
  assertLedgerOffsets(meeting.segments, acceptedCorrections);
  assert.deepEqual(
    new Set(acceptedCorrections.map((entry) => entry.from)),
    new Set(spec.terminology.aliases),
    "ledger does not cover every historical alias",
  );

  return {
    schema: 1,
    ok: true,
    corpus: spec.id,
    audio: {
      path: spec.audio.path,
      bytes: audio.length,
      sha256: audioSha256,
      hash_matches: true,
    },
    share_html: {
      path: spec.share_html.path,
      segments: meeting.segments.length,
    },
    terminology: {
      canonical: spec.terminology.canonical,
      expected_occurrences: spec.terminology.expected_occurrences,
      observed_alias_occurrences: observedOccurrences,
      canonical_occurrences: canonicalOccurrences,
      forbidden_alias_occurrences: forbiddenOccurrences,
      accepted_ledger_entries: acceptedCorrections.length,
      rejected_ledger_entries: rejectedCorrections.length,
      accepted_reasons: [...new Set(acceptedCorrections.map((entry) => entry.reason))],
    },
    model_mock: {
      requests: mock.requests.length,
      segment_ids_by_request: mock.requests.map((request) => request.segmentIds),
      proposed_aliases: [...new Set(mock.requests.flatMap((request) => request.aliases))],
    },
  };
}

export function parseShareMeeting(html) {
  const startMarker = "const m=";
  const endMarker = ";const e=";
  const start = String(html).indexOf(startMarker);
  const end = start < 0 ? -1 : String(html).indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, "share fixture does not contain the expected const m payload");
  return JSON.parse(String(html).slice(start + startMarker.length, end));
}

function correctionConfig(terminology) {
  return {
    ...DEFAULT_CONFIG,
    chatBaseUrl: "https://terminology-eval.invalid/v1",
    chatApiKey: "offline-eval-key",
    chatModel: "offline-terminology-fixture",
    chatProtocol: "chat-completions",
    chatPath: "chat/completions",
    contextHint: `术语：${terminology.canonical}`,
  };
}

function createCorrectionMock(terminology) {
  const requests = [];
  return {
    requests,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://terminology-eval.invalid/v1/chat/completions");
      const body = JSON.parse(options?.body || "{}");
      const user = body.messages?.find((message) => message.role === "user")?.content;
      assert.equal(typeof user, "string", "correction request is missing the user prompt");
      const payload = correctionPayload(user);
      const patches = payload.segments.map((segment) => ({
        id: segment.id,
        replacements: terminology.aliases
          .filter((alias) => String(segment.text || "").includes(alias))
          .map((alias) => ({ from: alias, to: terminology.canonical })),
      })).filter((patch) => patch.replacements.length);
      requests.push({
        segmentIds: payload.segments.map((segment) => segment.id),
        aliases: patches.flatMap((patch) => patch.replacements.map((replacement) => replacement.from)),
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ patches, join_after: [] }) } }],
      }), { headers: { "content-type": "application/json" } });
    },
  };
}

function correctionPayload(userPrompt) {
  const marker = "待检查片段：\n";
  const offset = userPrompt.lastIndexOf(marker);
  assert.ok(offset >= 0, "correction prompt is missing its segment payload");
  const payload = JSON.parse(userPrompt.slice(offset + marker.length));
  assert.ok(Array.isArray(payload.segments), "correction prompt segment payload is invalid");
  return payload;
}

function validateSpec(spec) {
  assert.equal(spec?.schema, 1, "unsupported terminology corpus schema");
  assert.equal(typeof spec?.id, "string", "corpus spec id is required");
  assert.equal(typeof spec?.audio?.path, "string", "corpus audio path is required");
  assert.match(spec?.audio?.sha256 || "", /^[0-9a-f]{64}$/i, "corpus audio SHA-256 is invalid");
  assert.equal(typeof spec?.share_html?.path, "string", "corpus share HTML path is required");
  assert.equal(typeof spec?.terminology?.canonical, "string", "canonical term is required");
  assert.ok(Array.isArray(spec?.terminology?.aliases) && spec.terminology.aliases.length, "at least one alias is required");
  assert.ok(Number.isInteger(spec?.terminology?.expected_occurrences), "expected occurrence count must be an integer");
}

function transcriptText(segments) {
  return segments.map((segment) => String(segment.text || "")).join("\n");
}

function transcriptGeometry(segments) {
  return segments.map(({ start_seconds, end_seconds, speaker }) => ({ start_seconds, end_seconds, speaker }));
}

function countTerms(value, terms) {
  return terms.reduce((total, term) => total + countLiteral(value, term), 0);
}

function countLiteral(value, term) {
  if (!term) return 0;
  let count = 0;
  let offset = String(value).indexOf(term);
  while (offset !== -1) {
    count += 1;
    offset = String(value).indexOf(term, offset + term.length);
  }
  return count;
}

function assertLedgerOffsets(sourceSegments, corrections) {
  for (const entry of corrections) {
    const source = sourceSegments[entry.segmentId]?.text;
    assert.equal(typeof source, "string", `ledger references unknown segment ${entry.segmentId}`);
    assert.ok(Number.isInteger(entry.start_offset), "ledger start_offset must be an integer");
    assert.ok(Number.isInteger(entry.end_offset), "ledger end_offset must be an integer");
    assert.equal(source.slice(entry.start_offset, entry.end_offset), entry.from, "ledger offsets do not replay against the source");
  }
}

function failureReport(error) {
  return {
    schema: 1,
    ok: false,
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      ...(Object.hasOwn(error || {}, "actual") ? { actual: error.actual } : {}),
      ...(Object.hasOwn(error || {}, "expected") ? { expected: error.expected } : {}),
    },
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runTerminologyEvaluation(process.argv[2] || DEFAULT_TERMINOLOGY_SPEC)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify(failureReport(error), null, 2));
      process.exitCode = 1;
    });
}
