# 逐字稿 Harness 改造与实测状态

> 后续更新：原音频与Key备份已由用户提供，真实测试已执行；最新交付、耗时和未解决问题见[美团逐字稿实测报告](meituan-transcript-live-test-2026-09-09.md)。下文保留第一阶段记录，不代表最新阻塞状态。

2026-09-09。用户要求以优质逐字稿证明核心 Harness 的效果，因此后续验证重心从摘要/展示转为音频纠错产物。

## 核心改动

新增 `src/agent/profiles/transcript-repair.js`，复用现有 `runAgent`、严格工具注册、不可变状态、预算、trace、终态提交。它补充现有术语监督的两项限制：普通错词不一定进入术语信号库存；全局 alias mapping 不适用于只错在某一处的词。

工具闭环：

1. `read_repair_window`：全篇分窗读取，检查普通语义错词、实体、数字、否定与断词；未全覆盖不能完成。
2. `review_transcript_audio`：绑定目标片段，盲复识别原音频，不向 ASR 发送拟修改答案；每次最多90秒，整场预算有界。
3. `propose_transcript_patch`：绑定片段、原文精确偏移、音频 review ID；只修改此处，要求替换词出现在复识别结果，并通过独立上下文复核，避免借另一句话的词给当前错误背书。
4. `finalize_transcript_repair`：原子重放最小补丁，保留文本以外的时间和说话人；保存原稿、修订依据、音频复核和未解决疑点。失败音频与被独立复核拒绝的疑点必须披露。

入口为 `src/api.js` 的 `repairTranscript` 和 `scripts/transcript-repair.mjs`。这是目前可单独运行的新 Harness profile，**尚未自动接入浏览器的默认转写流程**。避免未经真实录音验证就改变所有用户的逐字稿。

## 实际运行方式

准备时间戳逐字稿（Markdown 或含 segments 的 JSON）、对应原音频及本地模型配置。配置结构与言澜一致，至少包含 `chatBaseUrl`、`chatApiKey`、`chatModel`、`asrApiKey`，文本端点需支持 Responses 工具调用。也可使用既有 YANLAN_LUNA_* / OPENAI_* / MIMO_API_KEY 环境变量。不要把真实密钥提交到仓库。

```powershell
node scripts/transcript-repair.mjs --input transcript.md --audio path/to/original.webm --config path/to/local-config.json --output artifacts/transcript-repair/result.json
```

输出 JSON 保存原稿、修订稿、每处修改的音频依据和 trace；同名 Markdown 提供逐字稿、修订列表、待人工回听位置。控制台仅输出状态、数量、时间与用量，不打印密钥或原文。

## 验证边界

- 已建立 Harness 回归：普通词 occurrence-local 修改、同词不同语境不误改、音频其他句子中的词不作为当前替换依据、无音频不提交、未全覆盖不提交。
- 这些测试使用模拟工具/模型响应，只证明控制契约，不能证明真实 ASR 或监督模型的准确率。
- **尚未生成本次面试的真实音频复核逐字稿，也尚未证明性能追平飞书。** 当前仓库有面试的两份文字稿，但没有发现对应面试音频；另有云原生周会录音及其公开样本。
- 当前终端没有发现文本/ASR API 配置。已向用户询问本地配置位置和面试音频路径；不能把人工润色稿冒充 Harness 的实际运行结果。

## 下一轮必须交付的证据

拿到原音频与模型配置后，先保留原始基线，再运行新 Harness；交付修订逐字稿、逐处改动前后与回听区间、保留的疑点、误改检查、耗时和模型用量。使用飞书稿作为差异线索，回听裁决，不直接把飞书稿喂给监督模型作为答案。

优先核对本次面试的姓名/HRBP、工作量、风控算法、量化策略、策略失效以及贡献项目名，同时抽查未修改区域，避免只看命中的几个例子。对缺少声学支持的位置保留疑点；清理停顿词不计入纠错成功率。
