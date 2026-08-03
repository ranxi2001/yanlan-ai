# 云原生周会评测切片

本目录中的音频从本地会议录音按原始时间轴截取，用于固定样本的迭代测评。`data/` 故意保留在 Git 跟踪范围内，不写入 `.gitignore`；它不属于网页静态资源，Vite 构建生成的 `dist/` 不包含这些音频。

- 源文件：`录音-云原生实习周会.webm`
- 源文件 SHA-256：`133e0ff4af14f8fc450547ca1e6816cc4c65b5e8069d3a7f9201822cd9e812f2`
- 源时长：`01:01:35.808`
- 输出格式：WebM / Opus，48 kHz，单声道
- 截取方式：直接复制原始 Opus 音频包，不做二次编码

| 文件 | 原录音区间 | 实测时长 | 大小 | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `cloud-native-weekly-01_00-00-00_to_00-05-00.webm` | `00:00:00` - `00:05:00` | `300.000s` | 8.03 MiB | `30ad20a77a8a084fabdd9ac6ddd3089698e39b595531e9564a29d668e3ec016a` |
| `cloud-native-weekly-02_00-18-30_to_00-23-30.webm` | `00:18:30` - `00:23:30` | `299.999s` | 7.79 MiB | `1b89193df6aab4ebd84a02238a7b9d381d4ed9cf13cb464e2ad61d6f5ca525b1` |
| `cloud-native-weekly-03_00-37-00_to_00-42-00.webm` | `00:37:00` - `00:42:00` | `299.999s` | 7.42 MiB | `cd75add1e52ffa0ec078b93b171d5b2d246f327e60966a6c1d14e23990e7567e` |
| `cloud-native-weekly-04_00-56-30_to_01-01-30.webm` | `00:56:30` - `01:01:30` | `299.999s` | 7.93 MiB | `94031df162805c4f96dcabc98aa6d6188f52a8620fb07d5e54bf70fc813a9d22` |

后 3 段与 300 秒相差 1 毫秒，是原始 Opus 包时间戳对齐造成的，不是音频缺失。四段均已通过完整解码检查。

## 术语一致性评测

`cloud-native-weekly-01.terminology-eval.json` 将首段音频、历史分享稿及其 `Descheduler` 预期绑定为一个可复现 corpus。运行：

```bash
npm run eval:terminology
```

评测会先校验音频 SHA-256，再从历史分享稿提取原始逐字稿，通过离线模型 mock 运行正式术语校正管线，并检查 7 次历史变体是否全部统一、时间与说话人是否不变，以及每次替换是否都有可回放 offset 台账。

离线 mock 会从 gold spec 读取 aliases，因此只验证确定性归一化，不代表 Agent 的发现召回率。真实 Luna Agent 评测不会在提示中提供 `Descheduler` 或 aliases：

```bash
YANLAN_LUNA_BASE_URL="https://example.com/v1" \
YANLAN_LUNA_API_KEY="your-key" \
npm run eval:terminology:agent
```

可选设置 `MIMO_API_KEY`；Agent 判断文字证据不足时，可通过本机 `ffmpeg` 截取不超过 30 秒的范围交给 MiMo-V2.5-ASR 复核。gold spec 只在 Agent 完成后用于评分。
