# Private Fund AI Research Desktop

这是当前 TypeScript/Pi 架构的 canonical Electron 桌面发行版，不依赖已经退役的
Omnigent Electron 或 cc-haha Electron 壳。

macOS 应用内置：

- React 生产前端；
- Electron 自带的 Node 运行时；
- TypeScript API、Job Worker、Obsidian Worker 和按需 Pi Agent Worker；
- 由 PyInstaller 冻结的 Python Compute Worker，以及 PyMuPDF、openpyxl、
  ReportLab 和 AKShare；
- 用户数据、日志、进程启停与崩溃清理。

安装后的应用不要求系统预装 Node.js、npm 或 Python。模型推理仍然需要用户自己的
模型服务或 API 凭证，联网行情功能仍然需要网络。

## 构建 Apple Silicon 版本

首次构建：

```bash
npm install
npm run setup
npm run desktop:setup-build
npm run desktop:package:mac
```

产物位于 `apps/desktop/dist/`：

- `Private Fund AI Research-0.1.0-arm64.dmg`
- `Private Fund AI Research-0.1.0-arm64.zip`
- `mac-arm64/Private Fund AI Research.app`

执行打包态隔离冒烟：

```bash
npm run desktop:smoke
```

冒烟脚本把 `.app` 完整复制到系统临时目录后启动，避免误用仓库中的
`node_modules` 或 Python 环境。它验证 React 渲染、API、项目与会话创建、文件上传、
Job Worker、冻结的 Python Compute、Pi Agent Worker 启动和 Obsidian Worker 健康。

## 模型配置

首次启动会创建：

```text
~/Library/Application Support/Private Fund AI Research/desktop.env
```

也可以从应用菜单选择 **Open Configuration…**。按所用 provider 填写一组配置，
例如：

```dotenv
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
```

支持 OpenAI、Anthropic、Google/Gemini 和 AWS 相关环境变量，以及 HTTP(S) 代理。
配置文件权限为 `0600`，修改后需要重启应用。

本地数据和日志分别位于应用支持目录下的 `data/` 与 `logs/`；应用菜单提供直接打开
入口。

## 签名说明

本地构建会进行完整 ad-hoc 签名，并通过 `codesign --deep --strict` 校验，但没有
Apple Developer ID 和公证票据。从网络下载到其他 Mac 后，Gatekeeper 仍可能要求
用户在“隐私与安全性”中确认打开。正式对外分发应在 CI 中配置 Developer ID 并增加
Apple notarization。

当前构建目标是 Apple Silicon (`arm64`)。Intel Mac 需要独立的 x64 Python 依赖和
对应 Electron 构建，不能直接使用该 DMG。
