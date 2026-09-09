# 音频识别 Harness 的效果提升关键层：源码调研与局部实验

日期：2026-09-09。本文回答：分片、上下文、ASR提示词、识别结果确认和文本重写，分别解决什么问题；当前言澜应先改哪一层。

> 后续已执行同一MiMo模型的全场分片对照、重复实验、增长窗口和重采样对照，见[真实验证结果](asr-window-validation-2026-09-09.md)。小幅分片收益不代表追平，60秒及简单重叠拼接未获得支持。

## 1. 结论

**模型与音频质量决定可识别信息的上限；对当前言澜，优先改初始ASR之前及周围的音频分片、上下文保持、结果确认机制，再评测可控术语偏置。整篇LLM重写的优先级靠后。**

这不是说分片永远比提示词重要。词被切断时，首先需要恢复音频上下文；句子完整但专名持续识别错时，需要更适配的模型、可验证词表或上下文偏置；文本正确但不好读时，才主要是标点和阅读稿组织问题。

本次最重要的新事实：**当前MiMo `mimo-v2.5-asr` 路径明确拒绝文本content块**。同一音频片段，audio-only请求成功，加入词表文本后返回400：`ASR request must not include text parts; text prompt is injected by the gateway`。因此不能把“背景提示没有传入ASR”简单修成增加一个text/system提示。这次没有验证所有可能的`asr_options`扩展参数，不据此断言MiMo永久不支持任何热词能力。

以下严格区分三种依据：固定版本源码可以确认的机制、本录音上的局部实测、尚待完整消融实验确认的工程判断。没有把开源README的宣传数字当成中文会议质量保证。

## 2. 各层改变的是什么

| 层 | 主要控制量 | 直接改善的维度 | 不应期待它单独解决 |
| --- | --- | --- | --- |
| 音频与模型 | 音轨、串音、编码、语言/领域适配、基础ASR模型 | 可辨认语音、总体识别上限 | 在严重缺失的声音中恢复确定事实 |
| 音频分片 | VAD、静音切点、最短/最长窗、首尾padding、重叠 | 断词、漏尾、短窗上下文不足 | 保证所有陌生专名正确 |
| 上下文与词表 | 已确认前文、会话词表、decoder prompt、contextual bias | 跨窗一致性、罕见词进入候选的概率 | 靠角色定义增强声学辨别力 |
| 解码与质量回退 | beam、温度、重复检测、低分检测、no-speech、prompt reset | 错误循环、静音幻觉、部分搜索错误 | 用单一置信度证明内容真实 |
| 确认/融合 | pending与confirmed、多窗口稳定前缀、候选对齐和来源权重 | 过早提交、反复修改、边界重复、候选选择 | 将重复两次的错误变成正确答案 |
| 分人与对齐 | VAD/说话人变化、声学embedding、平台身份、词级对齐 | 谁说的、何时说的、回听定位 | 通过forced alignment直接纠正词义 |
| 文本纠错与阅读稿 | 有证据的局部patch、标点、去冗余、分段 | 明显错词、可读性、统一呈现 | 无约束重写后仍自动保持全部事实 |

需要区分三类“分片”：上传/传输块、模型识别窗、最终句子/话轮。它们不应共享同一边界。每10秒上传一次，不等于每10秒独立识别并永久提交一次，更不等于每10秒显示一个段落。

## 3. 开源项目真正做了什么

### 3.1 Whisper-Streaming：核心是缓冲与确认策略

检查版本：`ufal/whisper_streaming@6da90b44b7e50d79695e68166d2a2c7609c75abb`。

- [HypothesisBuffer](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/whisper_online.py#L359)比较连续两次假设的最长公共前缀，只确认稳定部分；新尾部继续放在buffer里。
- `insert()`结合时间和最多5个词的边界匹配去掉与已提交内容重合的部分，并非直接把每次结果拼接。
- [prompt()](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/whisper_online.py#L458)取已经滑出音频buffer的已确认前文，保留约200字符的尾部作为下一次识别上下文。
- buffer按已完成的segment或sentence裁剪，而非每到固定秒数就把未完成的词切走。默认15秒是buffer trimming阈值，不能直接理解成所有ASR请求固定15秒。

启示：让下一小段音频有机会澄清上一段末尾，避免第一次识别就把残缺词锁死。LocalAgreement的“稳定”是提交依据，不是声学真值证明。它也会增加重复计算和确认延迟，实时与离线要分开评价。

[README](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/README.md#L220)直接说明固定短窗可能切断词；其3.3秒延迟属于特定研究测试，不是本项目中文面试的保证值。

### 3.2 WhisperLiveKit / SimulStreaming：判断“音频是否已经够了”

检查版本：`QuentinFuxa/WhisperLiveKit@363e4f6d029694d9c81ae548beddd9d3c88a3637`。

- [README](https://github.com/QuentinFuxa/WhisperLiveKit/blob/363e4f6d029694d9c81ae548beddd9d3c88a3637/README.md)区分LocalAgreement、SimulStreaming/AlignAtt，以及不同模型的专用流式策略。
- [AlignAtt实现](https://github.com/QuentinFuxa/WhisperLiveKit/blob/363e4f6d029694d9c81ae548beddd9d3c88a3637/whisperlivekit/simul_whisper/align_att_base.py#L245)读取decoder cross-attention。当注意力已经靠近当前音频末尾时，停止继续提交；发生attention rewind时处理回退。
- 某些后端支持session context，某些流式后端能缓存encoder特征，降低每次重新计算完整音频的成本。

启示：不仅要决定在哪切，还要决定哪些字已经有足够未来上下文，可以最终确认。**AlignAtt需要模型内部信息，不能直接移植到只返回文字的MiMo API。** 黑盒API可借鉴重叠窗口和稳定假设策略，但无法假装已经获得cross-attention。

其README区分精确对齐与插值时间，也注明部分实验后端的语言限制。不能因为接口返回`word timestamps`就将它们全部视作精确声学对齐；也不能把英语流式模型收益外推到中文夹英文会议。

### 3.3 WhisperX：VAD打包与后续对齐各司其职

检查版本：`m-bain/whisperX@2cfd7b7c5c7bba144954364db747319b50e8232b`。

- [asr.py](https://github.com/m-bain/whisperX/blob/2cfd7b7c5c7bba144954364db747319b50e8232b/whisperx/asr.py#L220)先检测语音，再通过`merge_chunks`打包到有界窗口；并非把每个很短的VAD区间独立送入ASR。
- 默认配置中[condition_on_previous_text=False](https://github.com/m-bain/whisperX/blob/2cfd7b7c5c7bba144954364db747319b50e8232b/whisperx/asr.py#L371)，与Whisper-Streaming的有前文模式不同。这说明“所有项目都应该一直带历史”并不成立：批处理、并行吞吐、跨段一致性、幻觉传播之间存在取舍。
- 识别后使用语言相关对齐模型定位字词，再结合分人结果。**对齐主要回答何时说，不等于证明说了这个词。**

启示：离线文件应采用适合批处理的语音窗口，保留长句完整性与绝对时间映射。对于中文夹英文，必须单独测对齐覆盖；不能把对齐失败词的插值时间包装成“精确时间”。

### 3.4 faster-whisper：提示词与解码回退有具体语义

检查版本：`SYSTRAN/faster-whisper@ed9a06cd89a93e47838f564998a6c09b655d7f43`。局部实测安装版本为1.2.1，不能把当前主分支所有行为都当作该安装版本行为。

- [condition_on_previous_text](https://github.com/SYSTRAN/faster-whisper/blob/ed9a06cd89a93e47838f564998a6c09b655d7f43/faster_whisper/transcribe.py#L818)的文档明确写出：开启可增加跨窗一致性，关闭可减少重复循环和时间失步。
- [generate_with_fallback](https://github.com/SYSTRAN/faster-whisper/blob/ed9a06cd89a93e47838f564998a6c09b655d7f43/faster_whisper/transcribe.py#L1402)根据压缩比、平均log probability等判断是否尝试其他温度；温度升高时beam与sampling逻辑不同。
- [get_prompt](https://github.com/SYSTRAN/faster-whisper/blob/ed9a06cd89a93e47838f564998a6c09b655d7f43/faster_whisper/transcribe.py#L1532)把hotwords和previous tokens编码进decoder历史上下文；有长度限制，hotwords与prefix的关系也有具体规则。

启示：Whisper的`initial_prompt`首先是一种decoder文本上下文，不是ChatGPT式system role。输入“你是专业会议专家”与输入可用术语，机制和收益不能混为一谈。长prompt还会占用解码长度或把错误先验带入结果。

注意API参数兼容性：普通`WhisperModel.transcribe`与批处理路径并不保证所有参数产生相同行为。要检查实际调用路径，不能看到参数名就假设已生效。

### 3.5 FunASR：真正的热词偏置与识别后替换不同

检查版本：`modelscope/FunASR@130e57a6fdb9661e2b0cc59199fb31ef81f2b9e9`。

- [ContextualParaformer](https://github.com/modelscope/FunASR/blob/130e57a6fdb9661e2b0cc59199fb31ef81f2b9e9/funasr/models/contextual_paraformer/model.py#L45)具有context encoder / bias embedding，将热词表示送入decoder；推理中有`hw_list`与`clas_scale`。这是需要相应模型支持的上下文偏置。
- [postprocess_hotwords.py](https://github.com/modelscope/FunASR/blob/130e57a6fdb9661e2b0cc59199fb31ef81f2b9e9/funasr/utils/postprocess_hotwords.py)则是识别后的显式映射或拼音模糊匹配，可以改文本，但不因此新增声学证据。
- [AutoModel与README](https://github.com/modelscope/FunASR/blob/130e57a6fdb9661e2b0cc59199fb31ef81f2b9e9/README.md)提供ASR、VAD、标点和说话人组件组合。不能将普通Paraformer、ContextualParaformer、SenseVoice和后处理词表视作一种能力。

启示：若专业术语是重点，应比较“支持contextual bias的模型”与当前MiMo，而不仅是比较模型大小。配置中要标明provider到底支持decoder上下文、训练过的热词偏置，还是仅支持后处理替换。

### 3.6 Vexa、会议产品与预处理界面

- [Vexa mixed pipeline](https://github.com/Vexa-ai/vexa/blob/59e2c413a53479125b70b712ade12ab470d55512/core/meetings/modules/mixed-pipeline/src/chunked-transcriber.ts)采用音频时间索引buffer、语音/说话人变化切点、未确认窗口重新识别、LocalAgreement和pending/confirmed状态。名称来源还可能是平台active-speaker提示，不等于从混音中准确识别实名。
- [Meetily摘要处理器](https://github.com/Zackriya-Solutions/meetily/blob/0281737d87d26352fb0adc78c8c0975f691b23d1/frontend/src-tauri/src/summary/processor.rs)有分块概括、合并和报告生成。它证明了会议文档综合能力，不证明这些LLM步骤降低了原始ASR错误率。
- [Whisper-WebUI](https://github.com/jhj0517/Whisper-WebUI/blob/c3bb3b18e959826b28b1192486a8d5b361b6a4e0/README.md)包含可替换识别后端和UVR背景音乐预处理等功能。对有音乐的视频可能有价值；对这场普通面试不应默认套人声分离，处理伪影也可能损害辅音与专名。

共同启示：许多“Agent会议项目”的优势在采集、状态管理、文档与协作层。不能把这些产品功能全部归因为ASR更准，也不能仅按工具数量衡量识别质量。

## 4. 三种“提示词”应分别讨论

| 名称 | 示例性质 | 合理作用 | 主要风险 |
| --- | --- | --- | --- |
| 角色/行为指令 | “你是专业转写助手，不要出错” | 在支持指令的音频模型上约束格式或任务 | 不会增加实际音频信息；在Whisper上不等同system role |
| 已确认语境/词表 | 前文、参会人确认姓名、项目名 | 帮助解析音近词，改善实体一致性 | 错误前文污染后续；不相关热词被插入 |
| 模型内部contextual bias | 专门训练的热词编码器、解码偏置权重 | 调整词序列候选的概率 | 需要特定后端/权重；过强偏置仍会误识别 |

另外，音频识别后的“把A改成B”是文本修订，不应再称作ASR热词效果。

言澜要管理两种不同上下文：音频上下文（词两侧实际声音）与文本上下文（已有可靠词面）。文本不应替代音频；独立复听默认不灌入拟改答案，词表辅助识别应单列模式与评测结果。

## 5. 本录音的局部对照实验

音频：美团面试1035–1095秒，共60秒。模型：本机`faster-whisper-large-v3-turbo`，faster-whisper 1.2.1，CUDA/float16，beam=5，temperature=0，关闭跨调用前文。VAD使用300ms最短静音、200ms padding、最长28秒语音段，再按最长28秒打包。每种条件仅运行一次，无人工逐字金标准。

[原始结果](../artifacts/asr-layer-research/ablation-results.json)与[可复现脚本](../artifacts/asr-layer-research/ablation.py)保存在本地。词表从已提供旧稿可见的技术词构建，是**已知词表辅助条件**，不能算盲测。

| 条件 | 外部识别调用数 | 本样本中观察到的表现 |
| --- | ---: | --- |
| 固定10秒 | 6 | 出现`Lokelo/Camado/Kamala/Kamaran`，并有`成品线`等普通错词 |
| 固定30秒 | 2 | 某些普通表述不同，但仍出现`Localo/Canada/Kamala`；不是简单延长就解决专名 |
| VAD合并到约28秒 | 3 | 出现`Kamada/Worker/Kamaran`；VAD不是语义分句器，仍可能在词列举中间结束窗口 |
| 相同VAD窗＋已知词表 | 3 | 后两段出现3次`Karmada`与1次`Volcano`；第一段却出现30次重复`K8s`及异常字符 |
| 相同VAD窗＋角色提示 | 3 | 输出格式有所变化，未恢复上述两个专名的标准拼写 |

这些只是可观察词面，**不构成准确率、召回率或速度排名**。词表与role长度不同，音频只有一个片段，不能推导固定收益百分比。五个条件的解码时间约0.94–1.49秒，未计入加载和VAD预处理，不用这个单次差异排名吞吐。

对重复片段进一步检查：一次同名义区间的补充probe中，`initial_prompt`与`hotwords`路径都出现重复；配置多温度fallback后仍在temperature=0返回，压缩比约2.313，低于默认2.4阈值，平均logprob约-0.139。这个probe从原文件重新解码切片，不与第一组声称PCM逐位相同；其内部两条件使用相同PCM。

**含义：模型可以很自信地重复；默认单一阈值未必抓住所有错误。** 言澜现有`assessTranscriptionQuality`对第一组词表循环判定为`repetitive_generation`，说明重复质量门有实际价值。但正常流畅的专名错词均未被该门发现。

### MiMo文本提示词能力实测

对同一259.1–263.0秒音频，用当前配置的MiMo端点测试：

| 请求 | 返回 |
| --- | --- |
| 仅input_audio | HTTP 200，返回`Cloud Code/Cloud X`等识别文字 |
| input_audio加text背景词表 | HTTP 400，明确要求ASR请求不包含text parts |

[原始探测记录](../artifacts/asr-layer-research/mimo-context-probe.json)不含密钥。此结论只针对本次测试的请求路径；没有为未知hotword字段猜测支持程度，也没有据此修改生产请求。

## 6. 对言澜现状的判断

1. `src/app.js:1139`将文件处理块设为录音分片配置的3倍；默认10秒会成为约30秒文件识别块。直播仍按约10秒累计样本触发。它首先是传输/并发策略，没有完整的VAD与稳定尾部确认设计。
2. `src/api.js:210`的MiMo请求只含音频及语言参数。`contextHint`进入后续文本校正；鉴于本次400结果，不能直接给当前ASR请求补text字段。
3. `src/asr-quality.js`主要覆盖空结果、重复和密度异常；`src/asr-pipeline.js`在失败时细分重试。它适合恢复异常结果，但不能保证分片越小效果越好。对断词或音近歧义，扩大上下文可能比继续切小更有效。
4. 本次10处正式修订中，至少4处直接涉及块边界：工作/车辆、不是很平/匹配、模/行、区块/关联。这支持优先研究分片与拼接，但不是“全部错误由分片造成”的证明。
5. 上一阶段52轮监督、约91万累计上下文Token，只换来局部修订与15个待核位置，说明末端Agent微修订的性价比有限。它增加了可审计性，却没有充分改善初次识别的信息条件。这个研发重心需要前移。

### 应如何排优先级

| 问题类型 | 第一优先 | 第二优先 |
| --- | --- | --- |
| 词在边界断裂、开头/末尾缺字 | 保留声学上下文的分片与重叠对齐 | 只复核边界的二次识别 |
| 专名连续错且每次写法不同 | 中文/领域模型对照、后端支持的可验证词表 | 全文实体登记与有声学约束的候选裁决 |
| 重复循环或静音幻觉 | 语音检测、重复/时长质量门、改变prompt/解码/窗口回退 | 问题音频定位，不直接重写抹除 |
| 问答角色混在一起 | 声学分人或可信平台身份；保留话轮 | 角色映射复核，不从30秒块猜人 |
| 文字基本正确但冗长难读 | 标点和独立阅读稿 | 场景化纪要，不改原始逐字稿 |
| 单个业务词有多种合理识别 | 更有信息量的音频窗口、不同模型候选 | 约束式纠错/候选重排，必要时留疑点 |

## 7. 重写应放在哪里

应把三件事分开：

- **阅读整理**：标点、句子组织、可回放的停顿词清理，主要评价可读性和事实保留。
- **候选纠错/重排**：使用原始音频窗口、多个识别假设及可信术语；输出局部patch和证据，评价误改率与实体准确率。
- **自由改写**：把一篇错误稿“润色通顺”，更适合明确标注的整理文档，不宜作为原始逐字稿的替代。

可以在有人工金标准的集合上测oracle候选上限：正确词是否已经存在于某个ASR候选里？如果存在但选错，重点优化候选融合；如果所有候选都错，继续增加文本审核轮次的收益通常受限，需要改模型、音频上下文或可靠领域条件。oracle只用于离线评测，不能在生产选择时偷看参考答案。

多路识别也不能简单多数投票。同一模型两个窗口的错误高度相关；不同模型的分数没有统一标尺；弱ASR的残字不应该一票否决更强证据。应保存`audio_hash/window/model/prompt_version`及来源关系，避免把相关证据重复计票。

## 8. 建议下一轮只验证这些改动

先冻结开发/盲测语料和人工标注，再逐项比较，避免同时改模型、提示词、切片与重写后无法归因。

1. **音频分片对照**：在同一ASR上比较现有硬切、VAD-aware有界窗口、带首尾音频上下文的窗口。分别统计边界词错误、总体CER、请求数和耗时。
2. **确认机制对照**：实时模式比较即时提交与稳定前缀确认；离线模式比较一次识别与只复识别相邻边界。离线无需照搬持续每2秒重算的实时方案。
3. **词表能力对照**：只对正式支持该能力的后端测试无词表、短可信词表、错误词表；同时统计专名召回与虚假插入，不能只看命中术语数。当前MiMo文字content路径不进入该实验。
4. **解码回退对照**：同一音频、词表和窗口下改变解码策略，验证重复、静音、异常字符和时序质量门；失败时优先选择有因果针对性的回退，不永远固定“切小重试”。
5. **纠错层对照**：统一初始ASR，比较无修订、约束式局部纠错、自由重写；人工裁决主体、数字、否定、条件、专名。纠错层净收益应计算修对数减去误改损失。

建议的工程起点是独立实现`plan_asr_windows`与`commit_stable_transcript`，将录音块和识别窗解耦；把目前的13个纠错工具定位为有选择的二次处理工具，而不是让每一段正常语音都经历长Agent循环。可靠术语登记与provider能力声明随后接入。

初始实验可以比较约15–30秒目标窗和有限首尾上下文，但具体时长、padding、静音阈值不是已验证最佳值。VAD会漏弱声或切在术语中间，过长上下文会增加延迟和错误传播，必须通过中文混说语料选择参数。

本轮没有修改生产识别策略或自动推送研究文档。核心新增证据是源码机制对照、受控局部实验、MiMo接口能力探测，以及基于这些结果修正下一步优先级。
