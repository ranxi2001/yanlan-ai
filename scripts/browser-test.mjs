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

await page.route("https://gpt.example/v1/responses", async (route) => {
  assert.match(route.request().headers().authorization || "", /^Bearer gpt-test-key$/);
  const request = route.request().postDataJSON();
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.equal(request.messages, undefined);
  const system = request.instructions;
  const user = request.input;
  let content;
  if (system.includes("逐字稿校对员")) {
    content = user.includes("目标岗位：")
      ? JSON.stringify({ segments: [{ id: 0, speaker: "候选人", text: "我会先做服务降级，再通过日志和指标定位故障。" }], terminology: ["服务降级"] })
      : JSON.stringify({ segments: [{ id: 0, speaker: "小明", text: "今天讨论 OneFly 项目，由小明明天完成。" }], terminology: ["OneFly"] });
  } else if (system.includes("面试评估助手")) {
    assert.match(system, /不得根据声音、口音/);
    assert.match(user, /目标岗位：平台工程师/);
    content = JSON.stringify({
      title: "平台工程师技术一面",
      summary: "候选人给出了服务降级和故障定位思路。",
      keywords: ["服务降级", "故障定位"],
      interview_report: {
        recommendation: "follow_up",
        confidence: "medium",
        overview: "候选人具备基本故障处理思路，系统设计深度需要补充验证。",
        competencies: [
          { name: "系统设计", rating: "mixed", assessment: "提到了服务降级，但缺少容量与一致性细节。", evidence: [{ start_seconds: 0, quote: "我会先做服务降级" }] },
          { name: "故障排查", rating: "adequate", assessment: "给出了日志与指标结合的定位路径。", evidence: [{ start_seconds: 0, quote: "通过日志和指标定位故障" }] },
          { name: "协作沟通", rating: "insufficient", assessment: "证据不足", evidence: [] },
        ],
        strengths: ["能够先控制故障影响"],
        risks: ["系统设计深度尚未验证"],
        follow_ups: ["请说明降级恢复时如何保证数据一致性。"],
      },
    });
  } else if (system.includes("会议纪要助手")) {
    content = JSON.stringify({
      title: "OneFly 项目周会",
      summary: "会议明确了 OneFly 项目的近期交付安排。",
      keywords: ["OneFly", "交付"],
      highlights: [{ start_seconds: 0, speaker: "小明", quote: "由小明明天完成", reason: "明确了负责人和交付时间" }],
      speaker_summaries: [{ speaker: "小明", summary: "确认了 OneFly 项目的交付安排。", key_points: ["明天完成项目"] }],
      decisions: ["项目明天完成"],
      decision_records: [{ decision: "OneFly 项目明天完成", start_seconds: 0, evidence: "由小明明天完成" }],
      action_items: [{ task: "完成 OneFly 项目", owner: "小明", due: "明天" }],
    });
  } else {
    content = "小明负责在明天完成 OneFly 项目（00:00）。";
  }
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: content }] }] }) });
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#brandLogo").waitFor();
  assert.equal(await page.locator("#brandLogo").evaluate((image) => image.complete && image.naturalWidth === 1254), true);
  assert.match(await page.locator('link[rel="icon"]').getAttribute("href"), /yanlan-logo\.png$/);
  await page.locator("#settingsButton").click();
  assert.equal(await page.locator('.provider-link[href="https://ai.tosky.top/"]').getAttribute("target"), "_blank");
  assert.equal(await page.locator('.provider-link[href="https://platform.xiaomimimo.com?ref=6ENEDG"]').getAttribute("target"), "_blank");
  await page.getByText("专属链接注册，双方各得 10 元 API 体验金", { exact: true }).waitFor();
  await page.screenshot({ path: new URL("../artifacts/recommended-providers-desktop.png", import.meta.url).pathname, fullPage: true });
  await page.locator("#settingsDialog header .icon-button").click();
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.open), false);
  await page.locator("#settingsButton").click();
  await page.locator('#settingsDialog footer [value="cancel"]').click();
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.open), false);

  await page.locator("#startRecordButton").click();
  await page.locator("#liveRecorder:not(.hidden)").waitFor();
  await page.getByText("音频仅保存在本机", { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await page.locator("#stopRecordButton").click();
  await page.waitForFunction(() => document.querySelector("#meetingMeta")?.textContent.includes("仅录音"));
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  await page.getByText("录音已保存在本机", { exact: true }).waitFor();
  assert.equal(await page.locator("#copyButton").isDisabled(), true);
  assert.equal(await page.locator("#shareButton").isDisabled(), true);
  assert.equal(await page.locator("#exportButton").isEnabled(), true);
  await page.locator("#exportButton").click();
  assert.equal(await page.locator('[data-export="markdown"]').isDisabled(), true);
  const recorderDownload = page.waitForEvent("download");
  await page.locator('[data-export="audio"]').click();
  assert.match((await recorderDownload).suggestedFilename(), /\.(webm|ogg|m4a)$/);
  await page.screenshot({ path: new URL("../artifacts/recorder-only-desktop.png", import.meta.url).pathname, fullPage: true });
  await page.locator("#newMeetingButton").click();

  await page.locator("#settingsButton").click();
  await page.locator("#asrBaseUrlInput").fill("https://mimo.example/v1");
  await page.locator("#asrApiKeyInput").fill("asr-test-key");
  await page.locator("#chatBaseUrlInput").fill("https://gpt.example/v1");
  await page.locator("#chatApiKeyInput").fill("gpt-test-key");
  assert.equal(await page.locator("#chatModelInput").inputValue(), "gpt-5.6-luna");
  assert.equal(await page.locator("#chatProtocolInput").inputValue(), "responses");
  assert.equal(await page.locator("#chatPathInput").inputValue(), "responses");
  assert.equal(await page.locator("#transportModeInput").inputValue(), "direct");
  assert.equal(await page.locator("#relayPathInput").isDisabled(), true);
  await page.screenshot({ path: new URL("../artifacts/responses-settings-desktop.png", import.meta.url).pathname, fullPage: true });
  assert.equal(await page.locator("#settingsDialog").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await page.locator("#contextHintInput").fill("项目名 OneFly；负责人小明");
  await page.locator("#saveSettingsButton").click();

  const persisted = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.match(JSON.stringify(persisted.local), /asr-test-key|gpt-test-key/);
  assert.doesNotMatch(JSON.stringify(persisted.session), /asr-test-key|gpt-test-key/);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#settingsButton").click();
  assert.equal(await page.locator("#asrApiKeyInput").inputValue(), "asr-test-key");
  assert.equal(await page.locator("#chatApiKeyInput").inputValue(), "gpt-test-key");
  await page.locator("#settingsDialog header .icon-button").click();

  await page.locator("#fileInput").setInputFiles(fixture);
  await page.getByText("OneFly 项目周会", { exact: true }).first().waitFor({ timeout: 15000 });
  await page.getByText("今天讨论 OneFly 项目，由小明明天完成。", { exact: true }).waitFor();
  await page.locator("#recordingPlayer:not(.hidden)").waitFor();
  assert.equal(await page.locator(".correction-note").textContent().then((text) => text.trim()), "已统一 1 个术语");

  await page.locator('[data-insight="highlights"]').click();
  await page.locator(".highlight-item[data-seek='0']", { hasText: "由小明明天完成" }).waitFor();
  await page.screenshot({ path: new URL("../artifacts/meeting-highlights-desktop.png", import.meta.url).pathname, fullPage: true });
  await page.locator('[data-insight="speakers"]').click();
  await page.getByText("确认了 OneFly 项目的交付安排。", { exact: true }).waitFor();
  await page.locator('[data-insight="actions"]').click();
  await page.getByText("OneFly 项目明天完成", { exact: true }).waitFor();
  await page.getByText("完成 OneFly 项目", { exact: true }).waitFor();
  await page.screenshot({ path: new URL("../artifacts/meeting-decisions-desktop.png", import.meta.url).pathname, fullPage: true });

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
  const meetingPublic = await page.evaluate(async (url) => {
    const encoded = new URLSearchParams(new URL(url).hash.slice(1)).get("share");
    const prefix = encoded.slice(0, 2);
    const value = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    const output = prefix === "g." ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : bytes;
    return JSON.parse(new TextDecoder().decode(output));
  }, shareUrl);
  assert.equal(meetingPublic.schema, 3);
  assert.equal(meetingPublic.highlights[0].quote, "由小明明天完成");
  assert.equal(meetingPublic.speaker_summaries[0].speaker, "小明");
  assert.equal(meetingPublic.decision_records[0].start_seconds, 0);
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

  await page.locator("#newMeetingButton").click();
  await page.locator('[data-record-mode="interview"]').click();
  assert.equal(await page.locator("#recorderHeading").textContent(), "开始一场面试记录");
  await page.locator("#uploadButton").click();
  await page.locator("#candidateAliasInput").fill("候选人 A");
  await page.locator("#interviewRoleInput").fill("平台工程师");
  await page.locator("#interviewStageInput").selectOption({ label: "技术一面" });
  await page.locator("#interviewerInput").fill("内部面试官");
  await page.locator("#competenciesInput").fill("系统设计、故障排查、协作沟通");
  await page.locator("#jobDescriptionInput").fill("内部 JD：负责核心平台可靠性");
  await page.locator("#interviewConsentInput").check();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#interviewContinueButton").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(fixture);
  await page.getByText("补充追问", { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('[data-insight="summary"]').textContent(), "评估");
  assert.equal(await page.locator('[data-insight="actions"]').textContent(), "证据");
  assert.equal(await page.locator('[data-insight="qa"]').textContent(), "追问");
  assert.equal(await page.locator('[data-insight="highlights"]').isHidden(), true);
  assert.equal(await page.locator('[data-insight="speakers"]').isHidden(), true);
  await page.locator(".interview-disclaimer").waitFor();

  await page.locator('[data-insight="actions"]').click();
  await page.getByText("故障排查", { exact: true }).waitFor();
  await page.locator(".evidence-item", { hasText: "通过日志和指标定位故障" }).waitFor();
  assert.equal(await page.locator(".evidence-item").first().getAttribute("data-seek"), "0");

  await page.locator("#shareButton").click();
  await page.waitForFunction(() => document.querySelector("#shareUrlInput").value.startsWith("http"));
  const interviewShareUrl = await page.locator("#shareUrlInput").inputValue();
  const decodedPublic = await page.evaluate(async (url) => {
    const encoded = new URLSearchParams(new URL(url).hash.slice(1)).get("share");
    const prefix = encoded.slice(0, 2);
    const value = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    const output = prefix === "g." ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : bytes;
    return JSON.parse(new TextDecoder().decode(output));
  }, interviewShareUrl);
  assert.equal(decodedPublic.interviewContext.role, "平台工程师");
  assert.equal(decodedPublic.interviewReport.recommendation, "follow_up");
  assert.doesNotMatch(JSON.stringify(decodedPublic), /内部 JD|内部面试官/);
  await page.keyboard.press("Escape");
  await page.locator('[data-insight="summary"]').click();
  await page.locator("#toast").evaluate((element) => { element.className = "toast"; });
  await page.screenshot({ path: new URL("../artifacts/interview-desktop.png", import.meta.url).pathname, fullPage: true });

  const interviewMobile = await context.newPage();
  await interviewMobile.setViewportSize({ width: 390, height: 844 });
  await interviewMobile.goto(interviewShareUrl, { waitUntil: "networkidle" });
  await interviewMobile.locator("#insightsButton").click();
  await interviewMobile.waitForTimeout(250);
  await interviewMobile.getByText("补充追问", { exact: true }).waitFor();
  await interviewMobile.locator(".interview-disclaimer").waitFor();
  await interviewMobile.screenshot({ path: new URL("../artifacts/interview-mobile-share.png", import.meta.url).pathname, fullPage: true });
  assert.equal(await interviewMobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await interviewMobile.close();

  const legacy = await context.newPage();
  await legacy.setViewportSize({ width: 390, height: 844 });
  await legacy.addInitScript(() => localStorage.setItem("yanlan.config.v1", JSON.stringify({
    chatModel: "gpt-4o-mini", chatPath: "chat/completions",
  })));
  await legacy.goto(baseUrl, { waitUntil: "networkidle" });
  await legacy.locator("#sidebarOpen").click();
  await legacy.locator("#openSettingsButton").click();
  await legacy.screenshot({ path: new URL("../artifacts/recommended-providers-mobile.png", import.meta.url).pathname, fullPage: true });
  assert.equal(await legacy.locator("#chatModelInput").inputValue(), "gpt-4o-mini");
  assert.equal(await legacy.locator("#chatProtocolInput").inputValue(), "chat-completions");
  assert.equal(await legacy.locator("#chatPathInput").inputValue(), "chat/completions");
  await legacy.locator("#chatProtocolInput").scrollIntoViewIfNeeded();
  await legacy.screenshot({ path: new URL("../artifacts/responses-settings-mobile.png", import.meta.url).pathname, fullPage: true });
  assert.equal(await legacy.locator("#settingsDialog").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await legacy.close();

  const migrationContext = await browser.newContext();
  const migrationPage = await migrationContext.newPage();
  await migrationPage.addInitScript(() => {
    sessionStorage.setItem("yanlan.asr-key.v1", "legacy-asr-key");
    sessionStorage.setItem("yanlan.chat-key.v1", "legacy-chat-key");
  });
  await migrationPage.goto(baseUrl, { waitUntil: "networkidle" });
  const migrated = await migrationPage.evaluate(() => ({
    config: JSON.parse(localStorage.getItem("yanlan.config.v1") || "{}"),
    legacyAsr: sessionStorage.getItem("yanlan.asr-key.v1"),
    legacyChat: sessionStorage.getItem("yanlan.chat-key.v1"),
  }));
  assert.equal(migrated.config.asrApiKey, "legacy-asr-key");
  assert.equal(migrated.config.chatApiKey, "legacy-chat-key");
  assert.equal(migrated.legacyAsr, null);
  assert.equal(migrated.legacyChat, null);
  await migrationContext.close();

  await page.locator("#settingsButton").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#clearKeysButton").click();
  assert.equal(await page.locator("#asrApiKeyInput").inputValue(), "");
  assert.equal(await page.locator("#chatApiKeyInput").inputValue(), "");
  const cleared = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.doesNotMatch(JSON.stringify(cleared), /asr-test-key|gpt-test-key/);
  assert.doesNotMatch(JSON.stringify(cleared.session), /asr-test-key|gpt-test-key/);
  await page.locator("#settingsDialog header .icon-button").click();

  assert.deepEqual(browserErrors, []);
  console.log("Browser flow passed: branded assets, keyless recorder, persistent local keys, Responses API, meeting and interview workflows, exports, share, and responsive layout.");
} finally {
  await browser.close();
}
