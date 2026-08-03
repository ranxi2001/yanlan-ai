# 会议转录产品、开源语音栈与 Agent 架构调研

> 调研日期：2026-08-03。闭源产品没有公开完整内部实现。本文将表格中的“官方公开能力”视为来源事实；“架构启示”“适用位置”以及包含“应/建议/适合”的内容均为本文推断，不代表厂商披露的内部实现。

## 结论

言澜不应复制某一个竞品，而应组合三条路线：

1. 借鉴飞书妙记、Teams、Google Meet 和 Zoom 的“录音、逐字稿、时间定位、纪要、问答、协作”产品闭环。
2. 借鉴 Meetily、FunASR、faster-whisper、WhisperX 和 pyannote 的本地优先、分层且可替换的语音处理管线。
3. 借鉴 Vexa 的会议 Bot、MCP 和隔离 Agent 边界，但不让个人用户承担它的完整服务端复杂度。

核心差异化应是：录音优先增量持久化并显式显示未落盘状态、逐字稿可从录音重建、术语修正可审计、回答能回到具体时间。Agent 可以路由异常和提出建议，不能自由重写事实。

## 闭源产品公开方案

| 产品 | 官方公开的处理与产品能力 | 对架构的可靠启示 |
| --- | --- | --- |
| 飞书妙记 | 支持录音、上传、实时转写、中英文混说、发言人区分、时间轴、实时总结、要点/待办/风险、片段分享、评论和多格式导出。[飞书官方说明](https://www.feishu.cn/content/article/7578773484596153570) | 录音、逐字稿、洞察和协作不是四个页面，而是共享同一条带时间证据的数据链。声纹和实名说话人属于平台能力，不能从一个混合音轨轻易复刻。 |
| Microsoft Teams Intelligent Recap | notes/tasks 来自 transcript；章节还会使用 recording 和 PowerPoint Live；参会、提及和说话人时间线来自不同会议资产；内容继承组织的留存与权限策略。[Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/privacy/intelligent-recap) | 事实资产要分层保存，不能把“总结 JSON”当唯一状态。会议权限、保留期限和派生内容应绑定同一 meeting identity。 |
| Google Meet | “Take notes for me”可在会中展示 summary so far，会后生成 Google Doc；支持可配置的总结、决策和下一步，官方建议用于约 15 分钟到 8 小时的会议，并明确录制/记笔记同意状态。[Google Meet Help](https://support.google.com/meet/answer/14754931?hl=en) | 长会议应增量归纳并在结束时合并，不应等整篇逐字稿完成后才启动单次总结。会中状态与最终纪要应是两个版本。 |
| Zoom AI Companion | Meeting Summary 以 speech-to-text 为基础；保留 transcript 后可继续做会后问答和文档，VTT 可下载；Voice Recorder 允许编辑/恢复 speaker name。[Meeting Summary](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058013)、[Transcript retention](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0076631)、[Voice Recorder](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0080794) | 逐字稿是后续 AI 能力的事实索引；说话人身份必须允许人工纠正和回退。 |
| Otter | 官方建议使用 custom vocabulary、custom names，并通过人工标记 speaker 改善之后的识别。[准确率指南](https://help.otter.ai/hc/en-us/articles/18934488820887-Tips-on-improving-speech-transcript-accuracy)、[Speaker identification](https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification) | 专有名词和说话人不是纯后处理问题。用户词表应尽早进入 ASR，人工确认结果应沉淀为以后可复用的上下文。 |

推断：成熟产品普遍把会议看成一组有共同权限和生命周期的资产，而不是“一段音频调用两个模型”。言澜当前纯前端形态可以保留隐私优势，但数据结构也应逐步升级为版本化资产。

## 开源产品与基础组件

| 方案 | 可以从官方代码或文档确认的能力 | 限制与适用位置 |
| --- | --- | --- |
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | 本地桌面录音，Whisper/Parakeet 可在本机处理；外部 provider 失败时录音仍保存在本机并可重转录。[Provider 文档](https://docs.meetily.ai/features/transcription-providers)、[重转录](https://docs.meetily.ai/features/retranscription)、[Releases](https://github.com/Zackriya-Solutions/meetily/releases) | 云 provider 会接收音频；重转录覆盖旧稿且不自动更新总结；speaker diarization 仍为 beta。崩溃恢复目前只有 release-note 级说明，不能据此推断分片或原子提交机制。 |
| [FunASR](https://github.com/modelscope/FunASR) | ASR、VAD、标点、时间戳、热词、speaker verification/diarization、流式服务和 OpenAI 兼容接口可组合，但能力取决于具体模型和 checkpoint。[API](https://modelscope.github.io/FunASR/api.html) | 并非所有 checkpoint 都支持时间戳、热词和说话人能力；工具代码与模型权重许可也可能不同，部署前必须逐个检查模型卡。 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 批处理、Silero VAD、词级时间戳；segment 暴露 `avg_logprob`、`compression_ratio`、`no_speech_prob`，并支持 hotwords、重复抑制、上下文开关和 hallucination silence threshold。[transcribe.py](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py) | 是 ASR 引擎，不负责会议状态、可靠实名说话人或协作。它证明质量门应使用模型信号，而不只是 HTTP 成功。 |
| [WhisperX](https://github.com/m-bain/whisperX) | VAD 预切分、faster-whisper 批处理、wav2vec2 强制对齐和 pyannote diarization，可生成更细的词级时间。[README](https://github.com/m-bain/whisperX) | 适合会后精修，不应阻塞实时逐字稿。官方也明确重叠语音、数字/符号对齐和 diarization 并不完美。 |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | 可在本地运行 speaker diarization，输出匿名说话人时间段，并可使用已知说话人数约束。[README](https://github.com/pyannote/pyannote-audio) | 聚类结果是 `SPEAKER_00`，不是人的姓名。姓名需要会议平台参与者事件、独立音轨、用户命名或经过同意的声纹注册。 |
| [Vexa](https://github.com/Vexa-ai/vexa) | Bot 加入 Meet/Teams/Zoom/Jitsi，实时转录；gateway、meeting-api、agent-api、runtime、Redis、Postgres、MinIO 分层，Bot 与 Agent 使用隔离 workload；会议可沉淀为 Markdown 知识库。其 release 还记录了 MediaRecorder 每 30 秒向 MinIO 增量上传，以及 draft/confirmed transcript 去重。[Releases](https://github.com/Vexa-ai/vexa/releases) | 这些公开实现支持“追加式录音分片与逐字稿状态分层”的方向。完整栈要求明显高于个人本地应用，而且当前 README 明确标注部分实时 Copilot/WebSocket 能力尚未在 open-core 路径接通，不能只依赖宣传描述。 |
| [Attendee](https://github.com/attendee-labs/attendee) | 官方 README 描述 Zoom SDK 与 Google Meet 全 Chrome Bot 的实现差异，并提供统一 REST 抽象；但同一 README roadmap 仍将 Google Meet support 标为未完成，默认 Zoom 转录还依赖外部凭据和 Deepgram，因此仅作架构参考，不作成熟度证据。 | 自动入会本身就是独立基础设施产品，不应塞进当前静态前端。 |

会议平台能直接提供参与者事件或每人独立音轨时，说话人身份通常比混合音轨聚类可靠。Recall 官方说明独立音轨通常更准确：一人一设备是推荐的“perfect”路径，共享设备更适合 hybrid diarization；同一音轨里多人仍只能得到匿名标签。active-speaker 事件并不完整，实时独立音轨也会增加转录用量。[Recall diarization](https://docs.recall.ai/docs/diarization)

## 推荐语音管线

```mermaid
flowchart LR
    A[浏览器录音 / 文件导入 / 会议 Bot] --> B[追加式录音分片与 manifest]
    B --> C[媒体探测 + VAD 切片]
    C --> D[可替换 ASR provider]
    D --> E{质量门}
    E -->|正常| F[原始逐字稿版本]
    E -->|异常| G[缩短切片 / 关闭上下文 / 换模型]
    G --> D
    F --> H[词级对齐 + 匿名说话人]
    H --> I[显式 alias 补丁与审计台账]
    I --> J[修订逐字稿版本]
    J --> K[增量 Map 总结]
    K --> L[最终 Reduce + 带时间引用问答]
    L --> M[导出 / 分享 / MCP]
```

每个阶段都应输出结构化 artifact，至少包含：

- `meetingId`、`chunkId`、绝对时间范围和输入哈希；
- provider、模型版本、语言、参数和运行时间；
- 原始响应派生的质量指标，不保存 secret；
- 输入 artifact 版本、输出 artifact 版本和失败状态；
- 术语补丁的 `from`、`to`、时间、接受状态和原因。

这样才能安全地重跑一个失败片段，而不是覆盖整场会议。

## Agent 方案

Agent 应是受约束的控制面，不是逐字稿的事实作者。推荐职责如下：

| 能力 | Agent 权限 | 约束 |
| --- | --- | --- |
| 异常路由 | 可在固定策略内选择缩短切片、关闭历史上下文或切换已配置 provider | 不得将未通过质量门的文本晋升为可信逐字稿；保留隔离的原始输出、失败原因和重试历史供人工检查 |
| 术语校正 | 可提出最小 patch | 只有用户显式 `alias -> canonical` 可自动应用；其他实体变化等待人工批准 |
| 总结与问答 | 可读取修订逐字稿并并行 Map/Reduce | 金句、决策和面试证据必须回指现有时间片与原话 |
| 分享与外部写入 | 默认无权限 | 生成公开链接、加入会议、发消息或写任务前必须展示目标和内容并确认 |

长会议后台作业可以采用类似 LangGraph 的 checkpoint/thread/interrupt 模型：生产环境使用持久化 checkpointer，高风险补丁暂停等待 approve/edit/reject。恢复会重放节点，因此网络调用和写操作必须封装为可 checkpoint 且带幂等键的 task。[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)、[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

MCP 适合放在最外层，把言澜能力提供给 Codex、Claude、Cursor 等 Agent；它不是内部任务调度器。MCP 官方架构只定义上下文与工具交换，不规定应用如何编排模型；当前 Tools 规范建议始终保留人工拒绝工具调用的能力，并要求把非可信服务器的 tool annotations 当作不可信输入。[Architecture](https://modelcontextprotocol.io/docs/learn/architecture)、[Tools](https://modelcontextprotocol.io/specification/draft/server/tools)

建议逐步提供这些只读或本地写入工具：

- `transcribe_audio`：生成原始逐字稿 artifact；
- `get_transcript`：按时间或关键词读取片段；
- `ask_with_timestamps`：只基于检索片段回答；
- `propose_term_patches`：返回建议，不直接覆盖；
- `export_meeting`：写入用户明确指定的本地路径；
- `inspect_job` / `retry_chunk`：查看状态并只重跑失败节点。

Vexa 官方 MCP 文档展示了如何把“加入会议、读取 transcript、管理 recording”暴露为 Agent tools；是否能用于生产仍需结合当前 README、release 状态和实测判断。这些工具也不会自动获得正确性、幂等性或授权边界。[Vexa MCP](https://docs.vexa.ai/vexa-mcp)

## 言澜落地顺序

### 当前纯前端版

- 配置和 BYOK 设置保存在 localStorage；大体积录音分片保存在 IndexedDB，不把 Blob 写入 localStorage。
- MiMo chat 路径对未知时长且超过阈值的文件在 Web Audio 完整解码前失败；标准 `/audio/transcriptions` 路径不依赖这项限制。
- MiMo 分片结果经过每秒字符数、每秒 completion token 数和重复 n-gram 质量门，异常片段缩短后重试。
- 事实层只对重复的无语义口头填充词做可回放去重；普通文本重叠和英文词干都保留原文，避免删除条件、模态或事实语境。
- GPT 只返回术语 patch；明确 alias 可自动应用，其余保留原文。
- 长总结使用有上限并发和稳定顺序，后续把每层结果写入 checkpoint。

### 可选本地 companion

- 中文面试优先验证 Paraformer/ContextualParaformer + FSMN-VAD + 标点；需要解码偏置时使用其模型级 hotword。SenseVoice 作为快速多语种/CPU 基线；`错误词 -> 目标词` 显式后处理作为独立、可审计的公共层。
- 国际化可选 faster-whisper；会后按需运行 WhisperX + pyannote。
- 用 OpenAI-compatible transcription API 让网页、CLI 和 Agent Skill 共用一个适配层。
- 原始 ASR、修订稿、speaker label、总结分别版本化，不覆盖历史。

### 团队托管版

- 只有用户需要自动入会时，才引入 Vexa/Attendee 式 Bot runtime。
- 使用 Postgres 保存任务状态、对象存储保存录音分片、队列执行 ASR/总结。
- 平台参与者事件和独立音轨优先于机器猜测姓名。
- Agent runtime 与录音/凭据隔离，采用 deny-by-default egress，只能通过受审计、白名单化的模型与工具代理访问外部服务；不直接持有录音存储凭据。

## 不应复制的做法

- 不宣称混合音轨的匿名聚类等于可靠实名说话人识别。
- 不让 GPT 为了改一个词重写完整逐字稿。
- 不把 `finish_reason=stop` 或 HTTP 200 当作转写正确的证据。
- 不在没有原话和时间引用时生成确定性的关键决策或面试结论。
- 不让 Agent 自动决定候选人录用、淘汰，或依据声音、口音和敏感属性推断能力。
- 不为追求“自动入会”过早引入重型服务端，从而破坏个人版的本地隐私与易用性。
