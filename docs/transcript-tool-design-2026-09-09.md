# 逐字稿纠错工具：开源机制对照与当前实现

本轮直接由美团面试录音实测驱动。重点是让 Agent 获得可核查的证据并受到提交约束，不把 role 提示或模型说“supported”当作充分证明。参考项目于2026-09-09读取，以下链接固定到检查的源码版本。

## 借鉴的具体机制

| 项目与源码 | 核实机制 | 言澜的落点及边界 |
| --- | --- | --- |
| [Vexa transcript contract](https://github.com/Vexa-ai/vexa/blob/59e2c413a53479125b70b712ade12ab470d55512/core/meetings/contracts/transcript.v1/README.md) | 逐字稿有segment ID、时间、来源、confidence/words；区分confirmed与pending | 提案/接受/撤回分开，保留原始片段、证据、待核项；不把接口成功等同于内容确认 |
| [Vexa chunked-transcriber](https://github.com/Vexa-ai/vexa/blob/59e2c413a53479125b70b712ade12ab470d55512/core/meetings/modules/mixed-pipeline/src/chunked-transcriber.ts) | 音频时间索引、未确认窗口持续复识别、LocalAgreement、说话人/语音边界切分；有上下文和静音后prompt重置 | 新增扩大音频窗口复核，比较稳定词面；同模型不同窗口是相关证据，不声称独立金标准。未移植其完整实时采集/分人栈 |
| [LiveKit MultiSpeakerAdapter](https://github.com/livekit/agents/blob/e9a3422f47f070fbecfb5e8580d9803f48e1b6d6/livekit-agents/livekit/agents/stt/multi_speaker_adapter.py) | 包装具备diarization能力的STT，处理主说话人/背景声音；不是凭文本生成分人 | 明确分人能力缺失和request-local标签，不能以默认“发言人1”推断整场单人。尚未完成本面试声学分人 |
| [Pipecat FunASR example](https://github.com/pipecat-ai/pipecat/blob/8a7a7d7ff302dc153a88660f73be3fa44055ab7c/examples/transcription/transcription-funasr.py) 与 [VAD analyzer](https://github.com/pipecat-ai/pipecat/blob/8a7a7d7ff302dc153a88660f73be3fa44055ab7c/src/pipecat/audio/vad/vad_analyzer.py) | 识别、VAD、中间/最终帧、观察器分层，VAD使用置信度和起止时间条件 | 音频工具、识别结果比较、质量审核分别建模；本轮新增工具不等同于已上线VAD自适应切分 |

这些是架构和工具设计参考，没有将项目的性能宣传转成言澜的实测分数；源码未直接复制。此前的WhisperX、pyannote、FunASR、Meetily、anarlog对照见[总体计划](feishu-parity-gap-plan-2026-09-08.md)。

## 已实现的工具与强制约束

| 工具 | 真正执行的操作 | 不允许的捷径 |
| --- | --- | --- |
| `read_repair_window` | 读取不可变原稿与相邻上下文，登记覆盖 | 只看几段就完成 |
| `search_recording_terms` | 扫描全文精确词面，返回计数、片段、偏移、上下文 | 用常见项目名代替本录音的专名 |
| `inspect_transcript_boundary` | 返回前段尾部、当前首尾、后段头部和真实拼接 | 把“工作/车辆”改为“工作/工作量” |
| `review_transcript_audio` | 不带候选答案地复识别目标音频，绑定片段与review ID | 用另一位置的音频给此处修改背书 |
| `review_audio_context` | 前后各扩15秒、最长90秒的第二窗口；复用缓存 | 把完全相同的音频窗口包装成新的证据 |
| `compare_audio_hypotheses` | 并列展示主识别、扩展窗口、另一ASR的原文及候选词命中 | 将字符串命中解释为声音真值 |
| `locate_suspect_audio` | 利用有时间的ASR词，在疑点前后找两侧未变原文锚点，返回短音频范围 | 用拟改答案找位置；在锚点缺失/多义时猜时间 |
| `review_focused_audio` | 只截取已定位的最多16秒音频，绑定目标原文偏移 | 用这一短片段授权同段其他位置的修改 |
| `plan_audio_reviews` | 扫描尚未处理的疑点，计算可定位、能放入剩余预算的短片段计划 | 因整段预算不足就跳过只需要几秒的可核查疑点 |
| `propose_transcript_patch` | 唯一词面自动定位；原文校验；多视图词面支持；独立语义/位置/最小性复核 | 只因模型说“正确”就提交；全局替换同音词 |
| `propose_transcript_patches` | 一次监督调用提出多个修订，每项仍分别验证 | 任一失败导致其他未核验项混入结果 |
| `retract_transcript_patch` | 撤回被后续证据推翻的已接受提案，保留待核状态 | 覆盖原稿、隐藏被撤回的修改 |
| `finalize_transcript_repair` | 全篇覆盖、疑点处置覆盖、来源未变化、多视图检查后原子重放 | 把“已读”作为“已纠正”；带着已知证据缺口声称完整完成 |

`src/agent/profiles/transcript-evidence-tools.js`实现只读证据工具；`transcript-repair.js`持有音频、提案、撤回和提交状态；`src/api.js`提供独立疑点诊断和修订复核回调；仍由已有`runAgent`与严格工具注册器执行。

新出现且原稿中没有其他出现的英文标识符，必须额外取得扩展音频窗口支持。这个门可以降低把模糊词改成熟悉品牌的风险，但不能保证识别正确：多个相同模型窗口仍可能重复同一错误。未解决项需要回听或用户确认，不能藏进“成功”统计。

## 实测暴露并修复的问题

- 默认100k累计Token预算在长稿多轮上下文回传时用尽：调整有界预算，增加checkpoint与恢复；用量跨恢复累计，不清零规避预算。
- 一个音频复核导致“工作工作量”：增加确定性跨段重复检查，返回具体违例。
- 逐个修订造成重复模型轮次，模型常算错中文offset：新增批量提案与唯一词面自动定位，多义出现仍要求精确offset。
- 读取完整原稿后仍漏掉“分摊算法”等明显疑点：独立生成带片段ID和精确原文的疑点清单，完成时必须逐项落实为修改或待核。
- 辅助ASR也有错字，不能一律否决主ASR；反过来，单个主ASR命中也不能确认陌生专名：增加多窗口/多模型比较工具与额外词面支持门。
- 被后续证据推翻的提案原先没有撤回路径：新增单处撤回工具。

## 真实测试入口

支持言澜Key备份文件，密钥不写入结果或日志：

```powershell
node scripts/transcript-repair.mjs --input "美团 - Agent Infra - AI Infra会议纪要.md" --audio "美团 - Agent Infra .m4a" --config "本地Key备份.json" --chat-base-url "你的文本API地址" --model gpt-6-astra --second-asr artifacts/transcript-repair/meituan-sensevoice.json --output artifacts/transcript-repair/result.json
```

`--resume`从工具完成边界恢复；`--revisit-unresolved`允许继续一个明确为partial的结果。恢复检查音频哈希、原稿签名和模型配置，保留已接受补丁、证据与用量。检查点包含真实逐字稿和模型工具历史，仅放在本地`artifacts/`，不进入公开trace报告。

飞书稿只在运行完成后用`transcript-comparison.mjs`计算差异并辅助人工检查；不输入纠错模型。单录音差异率不是CER金标准，不能据此宣称追平。
