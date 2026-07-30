import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4173";
const fixture = new URL("../meeting-test-zh.mp3", import.meta.url).pathname;
await mkdir(new URL("../artifacts", import.meta.url), { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true, permissions: ["microphone"] });
const page = await context.newPage();
const browserErrors = [];
page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
page.on("pageerror", (error) => browserErrors.push(error.message));

await page.route("https://mimo.example/v1/chat/completions", async (route) => {
  assert.equal(route.request().method(), "POST");
  assert.match(route.request().headers().authorization || "", /^Bearer asr-test-key$/);
  const request = route.request().postDataJSON();
  assert.equal(request.model, "mimo-v2.5-asr");
  assert.match(request.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "今天讨论万福来项目，由小明明天完成。" } }],
    }),
  });
});

await page.route("https://gpt.example/v1/chat/completions", async (route) => {
  assert.match(route.request().headers().authorization || "", /^Bearer gpt-test-key$/);
  const request = route.request().postDataJSON();
  const system = request.messages[0].content;
  let content;
  if (system.includes("逐字稿校对员")) {
    content = JSON.stringify({ segments: [{ id: 0, speaker: "小明", text: "今天讨论 OneFly 项目，由小明明天完成。" }], terminology: ["OneFly"] });
  } else if (system.includes("会议纪要助手")) {
    content = JSON.stringify({ title: "OneFly 项目周会", summary: "会议明确了 OneFly 项目的近期交付安排。", keywords: ["OneFly", "交付"], decisions: ["项目明天完成"], action_items: [{ task: "完成 OneFly 项目", owner: "小明", due: "明天" }] });
  } else {
    content = "小明负责在明天完成 OneFly 项目（00:00）。";
  }
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }] }) });
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#settingsButton").click();
  await page.locator("#asrBaseUrlInput").fill("https://mimo.example/v1");
  await page.locator("#asrApiKeyInput").fill("asr-test-key");
  await page.locator("#chatBaseUrlInput").fill("https://gpt.example/v1");
  await page.locator("#chatApiKeyInput").fill("gpt-test-key");
  await page.locator("#contextHintInput").fill("项目名 OneFly；负责人小明");
  await page.locator("#saveSettingsButton").click();

  const persisted = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.doesNotMatch(JSON.stringify(persisted.local), /asr-test-key|gpt-test-key/);
  assert.match(JSON.stringify(persisted.session), /asr-test-key/);

  await page.locator("#fileInput").setInputFiles(fixture);
  await page.getByText("OneFly 项目周会", { exact: true }).first().waitFor({ timeout: 15000 });
  await page.getByText("今天讨论 OneFly 项目，由小明明天完成。", { exact: true }).waitFor();
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  assert.equal(await page.locator(".correction-note").textContent().then((text) => text.trim()), "已统一 1 个术语");

  await page.locator('[data-insight="qa"]').click();
  await page.locator("#questionInput").fill("谁负责项目，什么时候完成？");
  await page.locator("#qaForm button").click();
  await page.getByText(/小明负责在明天完成/).waitFor();

  await page.locator("#exportButton").click();
  const markdownDownload = page.waitForEvent("download");
  await page.locator('[data-export="markdown"]').click();
  assert.match((await markdownDownload).suggestedFilename(), /\.md$/);

  await page.locator("#exportButton").click();
  const audioDownload = page.waitForEvent("download");
  await page.locator('[data-export="audio"]').click();
  assert.match((await audioDownload).suggestedFilename(), /\.mp3$/);

  await page.locator("#shareButton").click();
  await page.locator("#shareUrlInput").waitFor();
  await page.waitForFunction(() => document.querySelector("#shareUrlInput").value.startsWith("http"));
  const shareUrl = await page.locator("#shareUrlInput").inputValue();
  assert.match(shareUrl, /#share=g\./);
  await page.keyboard.press("Escape");

  await page.locator('[data-insight="summary"]').click();
  await page.locator("#toast").evaluate((element) => { element.className = "toast"; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: new URL("../artifacts/desktop.png", import.meta.url).pathname, fullPage: true });
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(desktopOverflow, false);

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(shareUrl, { waitUntil: "networkidle" });
  await mobile.getByText("这是只读分享稿，不包含原始录音与 API 配置").waitFor();
  await mobile.locator("#insightsButton").click();
  await mobile.waitForTimeout(250);
  await mobile.screenshot({ path: new URL("../artifacts/mobile-share.png", import.meta.url).pathname, fullPage: true });
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(mobileOverflow, false);
  await mobile.close();

  await page.locator("#newMeetingButton").click();
  await page.locator("#startRecordButton").click();
  await page.locator("#liveRecorder:not(.hidden)").waitFor();
  await page.waitForTimeout(1200);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingMeta")?.textContent.includes("已完成"), null, { timeout: 15000 });
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();

  assert.deepEqual(browserErrors, []);
  console.log("Browser flow passed: upload, live recording, dual-model correction, summary, Q&A, audio/text export, share, responsive layout.");
} finally {
  await browser.close();
}
