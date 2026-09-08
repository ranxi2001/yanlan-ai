import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { assembleMeetingContent, contentSpeakerSummaries, renderMeetingContent } from "../src/meeting-content.js";
import { buildShareHtml, publicMeeting } from "../src/api.js";

const segments = [
  { start_seconds: 0, end_seconds: 6, speaker: "提问方", text: "呃，我们是否已经完全替换了旧系统？" },
  { start_seconds: 6, end_seconds: 14, speaker: "回答方", text: "嗯，我们还没有决定是否替换，当前两个系统并行。" },
  { start_seconds: 14, end_seconds: 20, speaker: "回答方", text: "工作地点可以选择北京或者上海。" },
];
const points = [
  { id: "b0-p0", topic: "系统关系", text: "回答方说明，两个系统目前并行，是否替换尚未决定。", speaker: "回答方", evidence: [{ start_seconds: 6, speaker: "回答方", quote: segments[1].text }] },
  { id: "b0-p1", topic: "工作地点", text: "工作地点可选北京或上海。", speaker: "回答方", evidence: [{ start_seconds: 14, speaker: "回答方", quote: segments[2].text }] },
];
const content = assembleMeetingContent([{ content: { title: "系统交流", points, status: "complete", rejected: 0, missing_topics: [] } }], segments);
const meeting = {
  id: "content-browser-fixture", title: "系统交流", createdAt: "2026-09-08T10:00:00Z", duration: 20,
  status: "done", mode: "meeting", segments, summary_kind: "synthesis", summary_content: content,
  summary: renderMeetingContent(content), speaker_summaries: contentSpeakerSummaries(content),
  keywords: ["系统", "北京"], highlights: [], decisions: [], decision_records: [], action_items: [], questions: [],
};
assert.equal(publicMeeting(meeting).summary_content?.points.length, 2);
const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error", server: { host: "127.0.0.1", port: 4173, strictPort: false, hmr: false, watch: { ignored: ["**/artifacts/**"] } } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((value) => localStorage.setItem("yanlan.meetings.v1", JSON.stringify([value])), meeting);
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator("#transcriptList .segment-text").first().waitFor();
  assert.match(await page.locator("#transcriptList .segment-text").first().textContent(), /^我们是否/u);
  await page.locator("#transcriptReadingMode").selectOption("original");
  assert.match(await page.locator("#transcriptList .segment-text").first().textContent(), /^呃，我们/u);
  await page.locator("#transcriptReadingMode").selectOption("reading");
  await page.locator('[data-insight="summary"]').click();
  await page.getByText(points[0].text, { exact: true }).waitFor();
  assert.equal(await page.locator('#insightContent [data-seek="6"]').count(), 1);
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/content-desktop.png", import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().right <= 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Mobile page overflows horizontally");
  await page.locator("#insightsButton").click();
  await page.waitForFunction(() => Math.abs(document.querySelector("#insightsPane").getBoundingClientRect().left) <= 1);
  await page.screenshot({ path: fileURLToPath(new URL("../artifacts/content-mobile.png", import.meta.url)), fullPage: true });
  const share = await browser.newPage();
  share.on("pageerror", (error) => errors.push(error.message));
  await share.setContent(buildShareHtml(meeting));
  await share.getByText(points[0].text, { exact: true }).first().waitFor();
  assert.equal(await share.locator(".summary .evidence").count(), 2);
  const edited = structuredClone(meeting);
  edited.segments[1].text = "需要重新核对。";
  const stale = await browser.newPage();
  stale.setDefaultTimeout(10_000);
  stale.on("pageerror", (error) => errors.push(error.message));
  await stale.setContent(buildShareHtml(edited));
  assert.equal(await stale.getByText(points[0].text, { exact: true }).count(), 0);
  await stale.getByText("逐字稿已更新，请重新生成摘要。", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Content browser checks passed: reading switch, reviewed points, evidence timestamps, mobile overflow, share rendering and stale-source invalidation. Model outputs are synthetic fixtures, not live quality scores.");
} finally {
  await browser?.close();
  await server.close();
}
