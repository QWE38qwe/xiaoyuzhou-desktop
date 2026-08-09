# Chrome Web Store 发布文案

## 基本信息

- 名称：小宇宙桌面版（非官方）
- 扩展 ID：`jgcegnegoifbcokpipkogolkmodkcceb`
- 主要语言：简体中文
- 类别：生产力工具
- 可见性：公开
- 发布方式：审核通过后自动发布
- 官方网站：https://github.com/QWE38qwe/xiaoyuzhou-desktop
- 支持网址：https://github.com/QWE38qwe/xiaoyuzhou-desktop/issues
- 隐私政策：https://github.com/QWE38qwe/xiaoyuzhou-desktop/blob/main/PRIVACY.md

## 简短说明

在独立桌面窗口中发现、订阅和播放小宇宙播客，并支持音频下载、本地或云端转写与 AI 总结。

## 详细说明

小宇宙桌面版（非官方）将播客发现、订阅、播放和内容整理集中到一个独立的
macOS 桌面窗口中。

主要功能：

- 浏览发现页、搜索节目和查看我的订阅
- 查看节目详情与单集列表
- 播放单集并调整进度和倍速
- 复制节目链接或单集链接
- 下载音频到浏览器下载目录
- 使用本地 Qwen3-ASR、Qwen API 或豆包 API 生成 Markdown 转写稿
- 使用 Qwen、豆包、DeepSeek、Kimi 或 GLM 生成结构化 Markdown 总结
- 管理不同版本的 AI 总结 Prompt

本扩展与小宇宙官方无隶属、授权或合作关系。请遵守小宇宙及所选 AI 服务商的
使用条款，并仅处理你有权访问的内容。

本地文件、macOS Keychain、本地 Qwen3-ASR 和绝对路径保存功能依赖可选的
Native Host。商店安装完成后，请按照开源项目 README 安装本地助手：

https://github.com/QWE38qwe/xiaoyuzhou-desktop

隐私说明：

- 小宇宙登录状态保存在 Chrome 扩展本地存储中
- API Key 由 Native Host 保存到 macOS Keychain
- 本地 Qwen3-ASR 不外发音频，也不会自动回退云端
- 只有用户主动执行转写或总结时，内容才会发送给所选 API 服务商
- 本项目开发者不运营收集扩展用户数据的后端服务器

源代码：

https://github.com/QWE38qwe/xiaoyuzhou-desktop

## 单一用途

在 macOS 独立窗口中浏览和播放用户有权访问的小宇宙播客，并按用户主动选择
提供音频下载、ASR 转写和 AI 总结。

## 权限理由

### storage

保存扩展设置、小宇宙登录状态、独立窗口尺寸和用户主动确认的隐私选项。

### windows

在点击扩展图标时创建或聚焦独立桌面窗口，并恢复用户上次使用的窗口尺寸。

### clipboardWrite

仅在用户点击复制按钮时，将节目链接或单集链接写入系统剪贴板。

### downloads

仅在用户点击下载音频时，将播客音频保存到 Chrome 默认下载目录。

### nativeMessaging

与用户主动安装的 macOS Native Host 通信，用于目录选择、绝对路径文件写入、
macOS Keychain 凭据读写、本地 ASR 和用户配置的 AI API 调用。

### 主机权限

仅用于向小宇宙 API、认证服务和媒体 CDN 请求节目、单集、订阅状态、登录凭证、
封面及音频内容。权限不覆盖任意网站。

## 数据披露

- 身份验证信息：小宇宙访问令牌、刷新令牌和设备标识。
- 网站内容：节目、单集、封面、音频地址和订阅状态。
- 用户活动：用户主动执行的登录、订阅、播放、下载、转写和总结操作。
- 用户提供的内容：API Key、自定义 Prompt、音频、转写稿及本地保存路径。

数据使用限制：

- 不出售或出租用户数据。
- 不将用户数据用于广告、营销或信用判断。
- 不向数据经纪商提供用户数据。
- 不使用远程托管代码。
- 仅在用户主动操作时向其选择的小宇宙、ASR 或 AI 服务商发送完成该功能所需的
  数据。

## 商店审核备注

本扩展的发现、搜索、订阅、节目详情和播放功能直接运行在扩展中。绝对路径下载、
Keychain、ASR 和 AI 总结需要用户另行安装开源 Native Host。Native Host 源码
和安装说明位于：

https://github.com/QWE38qwe/xiaoyuzhou-desktop

审核人员可直接检查未压缩的 `background.js`、`app.js`、`app.html` 和
`app.css`。扩展不包含混淆代码、远程 JavaScript、`eval` 或动态代码执行。
