# Hugging Face 人工标注 ASR 基准已落地

2026-09-09。已下载公开测试数据，建立固定抽样、源版本和音频/参考文本哈希清单。后续可直接对人工标注计算CER及中英混说MER，飞书输出不再承担金标准角色。

## 已下载内容

本地目录：`artifacts/hf-asr-benchmark/`。下载缓存和衍生音频合计约1.83GB（约1.71GiB），位于Git忽略目录。仓库只记录来源规格、抽样锁和工具，不自动发布第三方音频。

| 数据 | 下载/抽样 | 标注与用途 |
| --- | --- | --- |
| AISHELL-1 | 缓存测试集3个Parquet分片；从7176条中固定抽取128段，629.940秒，20位说话人 | 普通话ASR；镜像中的测试句ID与文字逐条对照官方转写表，全部通过后才抽样 |
| ASCEND | 缓存官方1315条测试集所在Parquet；固定128段，430.622秒 | 64段中英混说、32段中文、32段英文；人工/专家转写，保留会话、说话人和主题字段 |
| AISHELL-4 | 两场完整八声道会议，4708.853秒，约78分29秒；保留FLAC、TextGrid、RTTM | 长会议、话轮和分人；另外固定提取64段无标注重叠的ASR语音，597.539秒，9个不同说话人标签 |

固定ASR子集共 **320段、1658.101秒（约27分38秒）**，无重复音频SHA-256。完整会议音频另外保留，64个片段是它们的派生样本，不应与完整会议时长相加当成互不重叠的数据量。

ASCEND所选官方test数据涉及2位说话人，不能把128段视为128个独立说话人。AISHELL-4两场会议也不等同于64场独立会议。后续置信区间和分组比较应考虑说话人/会话相关性。

## 来源与固定版本

| 数据 | Hugging Face来源 | 固定revision |
| --- | --- | --- |
| AISHELL-1音频镜像 | [TwinkStart/AISHELL-1](https://huggingface.co/datasets/TwinkStart/AISHELL-1) | `2a509ef3a7a88d3234205eaeecba39fdd9d50518` |
| AISHELL-1官方转写表 | [AISHELL/AISHELL-1](https://huggingface.co/datasets/AISHELL/AISHELL-1) | `bbe295d530192a4cd41644b711c9aecd087df653` |
| ASCEND | [CAiRE/ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) | `737e9800ae31be9932ba8464c80366559bd28424` |
| AISHELL-4 | [AISHELL/AISHELL-4](https://huggingface.co/datasets/AISHELL/AISHELL-4) | `aada72727856313b19d4a030383c426364931dbf` |

AISHELL-1官方HF音频镜像在检查时只提供部分早期说话人归档，没有所需测试集。没有将训练数据冒充测试数据；改用保留原始测试句ID的镜像，并核对官方`aishell_transcript_v0.8.txt`。中文空白分词差异在核对时被去除，原始官方文件也保存在provenance中。

下载最初使用Viewer逐条音频接口，遇到429限流后改用固定revision的Parquet批量下载、本地抽样，减少请求。无需加载数据集仓库提供的Python脚本。

许可证记录：AISHELL-1上游[OpenSLR 33](https://www.openslr.org/33/)标明Apache-2.0；ASCEND数据卡标明CC-BY-SA-4.0。AISHELL-4的HF卡片写Apache-2.0，但上游[OpenSLR 111](https://www.openslr.org/111/)写CC-BY-SA-4.0，此处按上游数据说明记录，保留两份来源信息，不将音频视为言澜MIT代码的一部分。

## 可复用文件

- [来源规格](../data/hf-asr-benchmark-sources.json)：数据版本、split、样本量、下载文件与选择种子。
- [320条样本锁](../data/hf-asr-benchmark-lock.json)：样本ID、源revision、音频哈希、参考文字哈希；不包含音频或完整参考文本。
- `artifacts/hf-asr-benchmark/aishell1/manifest.jsonl`
- `artifacts/hf-asr-benchmark/ascend/manifest.jsonl`
- `artifacts/hf-asr-benchmark/aishell4/utterance-manifest.jsonl`
- `artifacts/hf-asr-benchmark/aishell4/manifest.jsonl`：两场完整会议及标注路径。
- `artifacts/hf-asr-benchmark/verification.json`：320个WAV的哈希、有效帧载荷、参考非空及样本统计。

每个ASR样本记录真实音频路径、采样率、时长、源split、参考来源类型及哈希。会议片段另外记录原会议、声道0、精确截取区间和TextGrid区间。原八声道音频保留，后续可以独立比较单通道、声道选择和波束形成。

## 会议标注处理边界

TextGrid按IntervalTier提取说话人、起止时间和原文，保留带标签或重叠的完整原始标注。用于简单ASR评分的64个片段单独要求：3～15秒、参考非空、无特殊标签、与其他说话人标注不重叠（包括截取时前后50ms边距）。使用固定随机种子，尽量轮流覆盖不同说话人。

片段只取原始声道0并重采样到16kHz，不平均混合8个通道以免引入相位抵消。这个子集不是完整AISHELL-4官方评测协议，也没有涵盖重叠语音的难度。完整会议/RTTM仍可用于分人、重叠与带说话人的ASR评测；不能简单把重叠说话人的文本按开始时间拼接后当普通CER金标准。

## 评测已接通

`src/asr-benchmark-metrics.js`提供：

- CER：Unicode NFKC、小写化、去空白/标点/符号后的字符编辑错误率。
- MER：中文按字、英文按词、数字按token混合计数，避免把一个英文词的拼写差异扩大成多个中文字符错误。
- 分别统计替换、删除、插入；整体按参考单位数加权汇总，避免短句和长句简单平均。

`scripts/eval-hf-asr-benchmark.mjs`在请求前核对固定样本锁和音频SHA-256，只将音频发送给ASR；参考文本只在本地评分，不传给模型。默认语言`auto`，不加词表或角色提示。不同模型比较时需固定语言与预处理设置。

```powershell
# 首次下载：Python环境需要pyarrow，ffmpeg/ffprobe需在PATH。
python scripts/download-hf-asr-benchmark.py
python scripts/prepare-hf-meeting-benchmark.py

# 无API调用，检查320条固定清单与参数。
npm run eval:asr:benchmark -- --dry-run

# 每类2条的联调检查。
npm run eval:asr:benchmark -- --keys "本地Key备份.json" --per-dataset 2 --output artifacts/hf-asr-benchmark/evaluation/mimo-smoke.json

# 正式运行完整固定子集。
npm run eval:asr:benchmark -- --keys "本地Key备份.json" --output artifacts/hf-asr-benchmark/evaluation/mimo-full.json
```

已完成三路各320条真实模型对照（MiMo、Whisper turbo、SenseVoice），以及Whisper固定中文的192条诊断，共1152次推理。主结果：MiMo在AISHELL-1 CER为0.87%、ASCEND MER为10.50%、AISHELL-4 CER为6.88%。完整配置、各路结果、耗时与错例见[三路模型实测报告](hf-asr-model-comparison-2026-09-09.md)。

当前具备了公共人工标注基线，可以开始冻结配置后比较ASR后端。它仍不能单独覆盖Agent/AI Infra稀有项目名；公开测试集也不能证明基础模型从未在训练中见过这些数据。
