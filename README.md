# 小宇宙桌面版（非官方）

一个面向 macOS 与 Windows 的非官方小宇宙 Chrome 扩展，提供独立桌面窗口、节目发现与搜索、订阅管理、音频下载、本地或云端 ASR 转写和多模型 AI 总结。

> 本项目与小宇宙官方无隶属、授权或合作关系。请遵守小宇宙及所选云服务的使用条款，并仅处理你有权访问的内容。

## 在线演示

交互式产品 Demo：

https://qwe38qwe.github.io/xiaoyuzhou-desktop/

Demo 使用虚构数据，可体验发现、节目详情、播放器、ASR 转写和 AI 总结流程，不连接真实账号，也不调用外部模型。

## 功能预览

> 以下截图使用合成演示数据，不包含真实账号、API Key 或本机目录。

### 发现与桌面播放器

![发现页与桌面播放器](docs/images/discover-player.png)

发现页集中展示节目与单集；卡片可直接播放、订阅、下载、转写或复制链接。底部播放器提供进度、倍速和当前单集操作。

### 节目详情与单集列表

![节目详情与单集列表](docs/images/podcast-detail.png)

从发现、搜索或“我的订阅”进入节目详情，查看节目介绍和单集列表，并对指定单集执行播放、下载、ASR 转写和链接复制。

### 下载、ASR 与 AI 总结设置

![下载与 ASR 设置](docs/images/settings-asr.png)

音频、ASR 转写稿与 AI 总结稿可分别指定系统绝对保存目录。ASR 支持本地 Qwen3-ASR（Apple Silicon）、Qwen API 与豆包 API；AI 总结支持 Qwen、豆包、DeepSeek、Kimi 和 GLM，并提供本地 Prompt 版本管理。API Key 由 Native Host 保存到 macOS Keychain 或 Windows DPAPI。

## 功能

- 发现、搜索和查看已订阅节目
- 查看节目详情及单集列表
- 播放单集，复制节目或单集链接
- 下载音频到浏览器默认目录或 macOS 绝对路径
- 使用本地 Qwen3-ASR、Qwen API 或豆包 API 转写音频
- 将转写结果保存为本地 Markdown 文档
- 使用 Qwen、豆包、DeepSeek、Kimi 或 GLM 总结转写稿
- 管理 AI 总结 Prompt 版本，内置结构化总结与按时间戳话题总结
- 自动分段总结长转写稿并输出独立 Markdown 文档
- 折叠侧栏和独立播放器控制

## 环境要求

- macOS 或 Windows 10/11
- Google Chrome 110 或更高版本
- Python 3（macOS 可使用系统 `/usr/bin/python3`；Windows 需加入 PATH）
- 可选：`ffmpeg`。本地 Qwen、豆包或 Fun-ASR 处理 M4A 等格式时需要
- 可选：`uv`。安装本地 Qwen3-ASR 运行时需要
- 如使用 ASR API 或 AI 总结：对应服务的 API Key

安装 `ffmpeg`：

```bash
brew install ffmpeg
```

安装 `uv`：

```bash
brew install uv
```

## 安装

### 1. 获取代码

```bash
git clone https://github.com/QWE38qwe/xiaoyuzhou-desktop.git
cd xiaoyuzhou-desktop
```

### 2. 安装 Chrome 扩展

Chrome Web Store 审核通过前，请使用开发者模式：

1. 打开 `chrome://extensions`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本仓库根目录
5. 记录扩展卡片显示的扩展 ID

### 3. 安装 Native Host

Native Host 用于目录选择、绝对路径下载、系统安全凭据读写，以及转写稿和总结文档落盘。

#### macOS

Chrome Web Store 安装版使用默认商店扩展 ID：

```bash
chmod +x install_native_host.sh
./install_native_host.sh
```

开发者模式需要传入扩展卡片显示的 ID：

```bash
./install_native_host.sh <你的开发版扩展ID>
```

安装后，在 `chrome://extensions` 中重新加载扩展。

如果移动了仓库目录、扩展 ID 发生变化，需使用新 ID 重新运行安装脚本。安装脚本会同时保留商店版和已安装开发版的扩展 ID。

设置页会显示实际扩展 ID、Manifest 路径、Host 路径和安装命令。macOS 默认路径为：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.xiaoyuzhou.desktop.json
~/Library/Application Support/Xiaoyuzhou Desktop Native Host/native-host
```

显示“本地助手未连接”时，复制设置页给出的安装命令，在仓库目录执行后重新加载扩展。

#### Windows

以 PowerShell 打开仓库目录，开发者模式传入扩展卡片显示的 ID：

```powershell
powershell -ExecutionPolicy Bypass -File .\install_native_host.ps1 -ExtensionId <你的开发版扩展ID>
```

商店安装版可省略 `-ExtensionId`。脚本会：

- 将 Host 安装到 `%LOCALAPPDATA%\Xiaoyuzhou Desktop Native Host`
- 生成 Native Messaging 可执行桥接器
- 写入 Chrome 和 Edge 当前用户注册表
- 使用 Windows DPAPI 加密 API Key

Windows 支持目录选择、绝对路径保存、Qwen/豆包 ASR API 与 AI 总结 API。Windows
暂不支持基于 MLX 的本地 Qwen3-ASR，请在“语音转写”中选择 API 模式。

### 4. 可选：安装本地 Qwen3-ASR

本地模式仅支持 Apple Silicon macOS。运行时安装在 Native Host 专属目录，不修改系统 Python：

```bash
chmod +x install_local_asr.sh
./install_local_asr.sh
```

模型在首次使用时下载到 Hugging Face 缓存。设置页可选择：

- `Qwen3-ASR 0.6B`：默认，约 1.2GB 运行内存
- `Qwen3-ASR 1.7B`：精度更高，约 3.4GB 运行内存

每次转写都会启动独立 Worker，任务完成后退出并释放模型内存，不常驻后台。

## 使用

1. 点击扩展图标打开桌面窗口
2. 登录小宇宙账号
3. 在“设置”中分别配置音频、ASR 转写稿和 AI 总结稿保存目录
4. 选择本地 Qwen3-ASR、Qwen API 或豆包 API；API 模式需保存对应 API Key
5. 点击“AI 总结”自动执行缺失的 ASR 转写并生成总结；已有总结的单集会显示“已 AI 总结”，再次点击需确认
6. 也可以在设置页选择已有 Markdown 转写稿直接总结

默认 Qwen 长音频模型：

```text
qwen-audio-3.0-asr-flash-filetrans
```

Qwen ASR 的接口地址可以填写 Base URL：

```text
https://dashscope.aliyuncs.com/api/v1
```

也可以填写 Workspace 专属 Base URL 或任一完整 Qwen ASR Endpoint。程序会根据模型自动选择正确路径：

- `qwen-audio-3.0-asr-flash-filetrans`、`qwen3-asr-flash-filetrans`、`fun-asr`：异步文件转写
- `fun-asr-flash-*`、`qwen-audio-3.0-asr-flash`：DashScope 同步识别
- `qwen3-asr-flash`：OpenAI-compatible

Fun-ASR-Flash 单次最多处理 5 分钟，长播客请使用 `qwen-audio-3.0-asr-flash-filetrans`。

新转写稿保存为：

```markdown
# 节目名称 - 单集名称

## 转写正文

### 开场

节目第一个话题前的连续转写内容……

### [02:04](小宇宙时间点链接) 话题一：……

该话题对应的连续转写内容……
```

章节只采用节目 Show Notes 已有的话题时间戳。ASR 返回的句级或字级时间仅用于把
内容归入对应章节，不会逐条显示；节目没有提供时间轴时输出一份连续正文。

AI 总结默认使用 OpenAI-compatible Chat Completions 接口：

| Provider | 默认接口 | 默认模型 |
| --- | --- | --- |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-plus` |
| 豆包 | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | `doubao-seed-2-1-pro-260628` |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `deepseek-v4-flash` |
| Kimi | `https://api.moonshot.cn/v1/chat/completions` | `kimi-k2.6` |
| GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-5.2` |

接口地址和模型均可在设置页修改。支持填写 API Base URL 或完整 `chat/completions` 地址，Native Host 会在对应 Provider 的官方 HTTPS 域名上自动补全路径。

下载音频是独立操作，用户不需要在 ASR 前手动下载。Qwen API 可直接使用音频 URL；本地 Qwen 会把音频下载到临时目录，任务结束即清理；豆包处理部分 M4A 时会在后台下载并转换音频。点击“AI 总结”时，扩展会复用同一单集已有的转写稿；没有转写稿时按 `ASR → AI 总结` 自动执行。

“AI 总结”设置可选择是否补充评论，默认关闭。开启后读取当前单集公开评论，过滤“终于更新、沙发、我来啦、多多更新、等了好久”等低信息内容，最多发送 80 条、总计 20000 字符，不发送评论者昵称。内置 Prompt 会把评论严格标注为听众观点，不作为节目事实。

总结结果按单集记录在 Chrome 本地存储中。已有结果的按钮显示“已 AI 总结”，再次执行前会确认，且新文件不会覆盖旧文件。内置 Prompt 包含：

- `播客结构化总结`：输出一句话摘要、核心结论、内容脉络、行动项等完整结构。
- `按时间戳话题总结`：保留原始时间戳链接，逐个话题总结所有有价值内容，不跨话题混合。

内置版本只读，可复制为自定义版本后编辑、切换或删除。长转写稿会自动分段总结并统一去重，结果保存为：

```text
原转写稿名称 - AI总结.md
```

AI 总结稿目录留空时沿用 ASR 转写稿目录，已有用户升级后不会改变原来的输出位置。

## 隐私与安全

完整隐私政策：[PRIVACY.md](PRIVACY.md)

- 小宇宙登录凭证保存在 Chrome 扩展本地存储中
- ASR 和 AI 总结 API Key 由 Native Host 保存到 macOS Keychain 或 Windows DPAPI，扩展存储和项目文件中不保存明文 Key
- 从旧版本升级时，Native Host 仅在 Keychain 写入并校验成功后删除旧的 `asr_credentials.json`；迁移失败会保留原文件
- 选择本地 Qwen3-ASR 时，音频和转写均留在本机，不会自动回退到云端 API
- 只有主动点击“ASR 转写”或“AI 总结”后，音频 URL 或音频内容才可能发送给所选 ASR 服务
- 只有主动点击“AI 总结”后，转写稿才会发送给所选 AI 服务；开启评论补充时，首次执行前还会明确说明筛选后的公开评论将被发送
- 评论补充默认关闭；评论原文不写入总结历史，仅记录实际采用条数
- 选择已有 Markdown 时，文件会先复制到已配置的转写稿目录；Native Host 只允许总结该目录内的 Markdown
- 长转写稿按片段发送，Provider 的数据保留策略以对应服务条款为准
- 项目不会把 API Key 写入扩展存储或仓库

请勿将调试日志或包含用户数据的下载文件提交到 Git。

## Chrome 权限

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存扩展设置和登录状态 |
| `windows` | 创建和管理独立桌面窗口 |
| `clipboardWrite` | 复制节目和单集链接 |
| `downloads` | 保存到浏览器默认下载目录 |
| `nativeMessaging` | 调用本地 Native Host |

`host_permissions` 仅覆盖小宇宙 API、认证服务和媒体 CDN。

## 开发检查

```bash
node --check app.js
node --check background.js
/usr/bin/python3 -m py_compile native_host.py
/usr/bin/python3 -m json.tool manifest.json >/dev/null
sh -n install_native_host.sh
sh -n install_local_asr.sh
```

Windows 安装脚本可在 Windows PowerShell 中执行验证。

## 卸载 Native Host

先从 Chrome 删除扩展，然后执行：

```bash
rm -rf "$HOME/Library/Application Support/Xiaoyuzhou Desktop Native Host"
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.xiaoyuzhou.desktop.json"
security delete-generic-password -s com.xiaoyuzhou.desktop -a asr.qwen 2>/dev/null || true
security delete-generic-password -s com.xiaoyuzhou.desktop -a asr.doubao 2>/dev/null || true
for account in summary.qwen summary.doubao summary.deepseek summary.kimi summary.glm; do
  security delete-generic-password -s com.xiaoyuzhou.desktop -a "$account" 2>/dev/null || true
done
```

Windows 卸载：

```powershell
Remove-Item "$env:LOCALAPPDATA\Xiaoyuzhou Desktop Native Host" -Recurse -Force
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.xiaoyuzhou.desktop" -Recurse -Force
Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.xiaoyuzhou.desktop" -Recurse -Force
```

## 已知限制

- 本地 Qwen3-ASR 当前仅支持 Apple Silicon；Intel Mac 请使用 API 模式
- Windows 暂不支持本地 Qwen3-ASR；目录和云端 API 功能可用
- 本项目依赖非公开稳定性承诺的小宇宙接口，接口变化可能导致部分功能失效
- 当前未发布到 Chrome Web Store，需要通过开发者模式安装

### Qwen ASR 404

`0.3.1` 起，扩展会根据模型自动补全 Qwen ASR 的服务路径。`0.3.2` 起，若 Workspace 专属域名明确不支持异步查询，文件转写会自动切换到同地域官方通用域名。若仍返回 404 或 403：

1. 确认接口域名与 API Key 属于同一地域或 Workspace。
2. 优先填写 Base URL，不要手工混用 `audio/asr/transcription`、`multimodal-generation/generation` 和 `chat/completions`。
3. 重新运行 `install_native_host.sh`，并在 `chrome://extensions` 重新加载扩展。

## License

[MIT](LICENSE)
