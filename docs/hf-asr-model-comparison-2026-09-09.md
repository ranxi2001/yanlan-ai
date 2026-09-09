# 三路 ASR 实测：公开人工标注固定子集

2026-09-09。已完成 MiMo、Whisper turbo、SenseVoice 各 320 段真实推理，共 960 次；另完成 Whisper 固定中文的 192 段诊断。**当前配置下 MiMo 三类主指标均最好，暂不替换主 ASR。** 这次检验了后端选择与语言设置，尚未证明长会议 Harness 或飞书妙记的端到端差距已消除。

## 同一批音频的结果

错误率越低越好。CER 按字符，MER 按中文字符、英文词和数字 token 计算。总错误数除以总参考单位数，不平均各句百分比。

| 数据及主指标 | 样本 | MiMo v2.5 ASR | faster-whisper large-v3-turbo | SenseVoice Small int8 |
| --- | ---: | ---: | ---: | ---: |
| AISHELL-1 普通话 CER | 128 | **0.87%**（16/1839） | 11.53%（212/1839） | 6.09%（112/1839） |
| ASCEND 全部 MER | 128 | **10.50%**（149/1419） | 21.78%（309/1419） | 16.28%（231/1419） |
| AISHELL-4 会议 CER | 64 | **6.88%**（166/2414） | 36.37%（878/2414） | 9.86%（238/2414） |

ASCEND 全部样本不等于全部中英混说，分层结果如下：

| ASCEND 分层 MER | 样本 | MiMo | Whisper turbo | SenseVoice |
| --- | ---: | ---: | ---: | ---: |
| 中英混说 | 64 | **10.81%** | 22.05% | 17.90% |
| 中文 | 32 | **3.50%** | 20.23% | 8.17% |
| 英文 | 32 | **16.67%** | 22.36% | 18.70% |

三个后端主评测均完成 320/320，没有空输出。按主指标 S/D/I（替换/删除/插入）核对：

| 数据 | MiMo S/D/I | Whisper S/D/I | SenseVoice S/D/I |
| --- | --- | --- | --- |
| AISHELL-1 CER | 14/1/1 | 148/13/51 | 100/8/4 |
| ASCEND MER | 107/22/20 | 184/103/22 | 155/50/26 |
| AISHELL-4 CER | 101/32/33 | 370/270/238 | 142/72/24 |

## 语言判定的实测影响

Whisper 自动语言在 AISHELL-1 的 128 段中将 1 段判成越南语；AISHELL-4 的 64 段中将 3 段判成英语、1 段判成越南语。存在无关订阅文案输出，也有繁体输出。

保持音频、模型、解码配置、评分规则不变，仅将这两个纯中文语料的 `language=None` 改成 `language=zh`，重新推理全部 192 段：

| Whisper 中文诊断 CER | 自动语言 | 固定中文 | 变化 |
| --- | ---: | ---: | ---: |
| AISHELL-1 | 11.53% | 8.81% | -2.72 个百分点 |
| AISHELL-4 | 36.37% | 22.12% | -14.25 个百分点 |

语言控制可以显著降低此配置的错误，但仍不足以超过 MiMo。固定中文后，会议插入错误从 238 降到 26，删除错误从 270 增到 280；不能把减少胡话理解为内容覆盖已经完整。这是看到基线后的诊断，同样本上的变化不等于独立留出集上的收益，也没有验证固定中文对中英混说的影响。

主评测保留原成绩，没有补加简繁、数字或同义表达转换。Whisper 的繁体文字会计入错误，因此这里比较的是当前直接输出配置，不能解释为各基础模型经过最佳调参后的声学能力排名。

## 错例揭示的短板

下面只是人工标注与输出之间的文本差异，尚未逐条人工听音仲裁，不能凭多个模型一致就改金标准。

| 样本 | 参考文字或局部内容 | 观测 |
| --- | --- | --- |
| `aishell1:BAC009S0769W0351` | 安娜莱纳法拉塞 | MiMo 写成“安纳莱纳法拉塞”；SenseVoice 写成“安娜莱那法拉塞”；Whisper 自动语言输出越南语订阅文案。人名与语言误判是两类不同问题。 |
| `ascend:01102` | 还有ipad | MiMo 输出“Are you iPad?”，其他两路也未正确保留中文。短混说语音需要更充分的声学上下文。 |
| `ascend:01124` | 都得学R语言 | MiMo 输出“然后也学阿语”；Whisper 保留了“R语言”，但句子也不完全正确。第二路可能补回局部术语，整句替换仍可能引入错误。 |
| `ascend:00194` | ok | MiMo/Whisper 输出“Okay”，严格计分也算差异；不能将所有编辑距离都当成用户感知的识别失败。 |
| `aishell4:L_R003S01C02-0286` | 小偷小摸、小区不法活动等内容 | Whisper 自动语言输出“请不吝点赞 订阅 转发 打赏支持明镜与点点栏目”；另外两路也有多处文字差异。需要空白/噪声和无关文案检测。 |

主评测逐句比较相对 MiMo 的“错误更少/相同/更多”：

| 第二路 | AISHELL-1 CER | ASCEND MER | AISHELL-4 CER |
| --- | --- | --- | --- |
| Whisper 自动语言 | 2/66/60 | 9/49/70 | 0/3/61 |
| SenseVoice | 1/90/37 | 16/54/58 | 11/20/33 |

SenseVoice 有互补性，但全量替换或无条件采纳分歧会退步。上述判定用到了金标准，只能做离线分析；产品中的复核触发与采纳规则必须在不读取参考答案的前提下另测。

AISHELL-1 按 20 位说话人做 2000 次配对 bootstrap：相对 MiMo，Whisper 自动语言 CER 增加 10.66 个百分点，95% 区间为 +5.68～+19.11；SenseVoice 增加 5.22，区间为 +3.41～+7.56。区间仅针对这个公开子集。ASCEND 只有 2 位说话人、AISHELL-4 只有 2 场会议，不给出具有误导性的逐句独立置信区间。

## 耗时与配置

320 段共 1658.101 秒（27 分 38 秒）。以下是各后端本次运行耗时，不是同硬件吞吐排名：

| 后端 | 总墙钟耗时 | 请求/推理累计 | 模型加载 | 环境 |
| --- | ---: | ---: | ---: | --- |
| MiMo | 301.29 秒 | 300.18 秒 | 服务端未知 | 顺序远端 API 请求，包含网络与服务端处理 |
| Whisper turbo | 103.49 秒 | 99.04 秒 | 4.27 秒 | RTX 5080 Laptop GPU，CUDA float16 |
| SenseVoice | 36.82 秒 | 35.12 秒 | 1.47 秒 | Core Ultra 9 275HX，CPU 4 线程，int8 |

Whisper 实现 faster-whisper 1.2.1，beam=5，温度回退 `[0,.2,.4,.6,.8,1.0]`，`task=transcribe`，关闭 VAD 和前文条件化，因为输入已经按人工语音区间裁好。SenseVoice 实现 sherpa-onnx 1.13.7，`use_itn=True`。主评测三路语言均为 auto，无词表、重写、角色提示或参考答案输入。MiMo 为音频请求；接口不接受 ASR 文本 prompt。模型内部解码与数字格式化仍有差别。

本次没有采集服务端算力、费用、峰值显存或多次运行的耗时分布；不推导成本排名和延迟 SLA。

## 对核心 Harness 的决策

1. **保留 MiMo 主识别。** 当前实测不支持用这两个本地默认配置全量替换。SenseVoice 可作为低成本第二路候选，但路由收益尚未验证。
2. **语言设置与异常输出检测先于大规模重写。** 本次固定中文对照已有收益；应把用户指定语言传递给支持的后端，并检测非预期语言、重复文案、异常长度。自动检测只能触发复核，不能直接删掉疑似错误原文。
3. **下一项应测长音频分片与补听。** 用保留的完整 AISHELL-4 会议比较固定窗口、静音边界和带上下文但明确输出归属的窗口。人工裁句成绩不能回答分片好坏；重叠语音另用合适的带说话人评测，不能串接参考冒充普通 CER。
4. **术语修复要同时测纠错与误改。** 只对风险片段补听，保留音频位置和原始输出；在新的开发/留出会话划分上验证采纳策略。当前公开集没有覆盖 Agent Infra 稀有项目名，也没有支持先全稿 LLM 重写的结论。

这些是实测支持的取舍与后续实验方向，本次没有修改生产 ASR 的默认配置或宣称已经实现这些路由策略。

## 可复现产物与验证

数据版本、来源许可证、固定抽样方法见[数据说明](hf-asr-benchmark-2026-09-09.md)。本地完整推理与逐句评分位于 `artifacts/hf-asr-benchmark/evaluation/`：

- `mimo-full.json`、`whisper-full.raw.json`、`sensevoice-full.raw.json`：三路完整输出。
- `whisper-full.json`、`sensevoice-full.json`：统一重新计分后的结果。
- `model-comparison.json`：主评测、分层、配对统计及固定中文诊断。
- `whisper-zh-diagnostic.raw.json`、`whisper-zh-diagnostic.json`：192 条诊断输出与评分。
- `error-examples.json`：每类 MiMo CER 最高的 8 条及三路文本，不是随机错例抽样。

本地推理脚本逐条校验实际 WAV SHA-256、参考文本锁及音频格式；远端运行校验同一锁与实际音频哈希。汇总再次检查三路完整覆盖、样本去重、音频哈希、数据集、时长和参考文本一致性。参考文字只参与本地计分。

```powershell
# 主评测：远端需要本地凭据，路径参数不包含 Key 内容。
node scripts/eval-hf-asr-benchmark.mjs --keys "本地Key备份.json" --output artifacts/hf-asr-benchmark/evaluation/mimo-full.json

# Python 环境须具备 faster-whisper、sherpa-onnx 和可用 CUDA；模型需已下载。
python scripts/eval-hf-local-asr.py --plan artifacts/hf-asr-benchmark/evaluation/mimo-full.json.plan.json --whisper-model "本地Whisper模型目录" --sensevoice-model artifacts/models/sensevoice

# 固定中文诊断，独立产物，保留原基线。
python scripts/eval-hf-local-asr.py --plan artifacts/hf-asr-benchmark/evaluation/mimo-full.json.plan.json --whisper-model "本地Whisper模型目录" --backend whisper --whisper-language zh --chinese-corpora-only --run-label zh-diagnostic

# 只读已有推理结果并重新计分，无模型/API 调用。
node scripts/compare-hf-asr-models.mjs --whisper-zh-diagnostic
```

`npm run check` 已通过（286 个测试通过、1 个跳过，生产构建成功）；新增比较脚本语法检查、Python 脚本编译检查通过。实际调用 1152 次完整推理作为本轮集成验证。

这些是公开 test 的固定子集，非官方全量榜单；不能证明基础模型没在预训练中见过它们。AISHELL-4 的 64 段排除了人工标注重叠、使用单声道 0。没有测全长分片、说话人归属、重叠语音和同一批音频上的飞书结果，因此不能据此声称“追平飞书”。
