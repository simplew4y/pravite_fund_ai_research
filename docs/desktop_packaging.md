# 私募研究工作台 — Electron 桌面打包（WSL 构建）

## 目标

- Windows / macOS 安装包
- **用户零配置**：安装后打开即可（本阶段 Windows 安装包在 WSL 构建）
- **FinSagent 仅接入**：LLM 配置三字段 + `data_pipeline` 入库闭包（不打包 deploy/UI/评测等）

## 在 WSL 里构建 Windows 安装包

前置：Node 22+、`wine64`（NSIS 跨平台打包需要）。

```bash
cd /home/code/pravite_fund_ai_research

# 首次若无 wine：
# sudo apt-get install -y wine64 wine

# 可选：注入密钥（默认读取 FinSagent/config/production.yaml）
# export LITELLM_TARGET_API_KEY=sk-...
# export LITELLM_TARGET_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
# export LITELLM_TARGET_MODEL_NAME=qwen3-max

bash scripts/desktop/build_windows_package.sh

# 加快迭代（web-ui 已有时）：
DESKTOP_SKIP_WEB_BUILD=1 bash scripts/desktop/build_windows_package.sh
```

产物：

| 路径 | 说明 |
|---|---|
| `omnigent/web/electron/dist/PrivateFundWorkbench-Setup-0.3.0-x64.exe` | NSIS 安装包（约 128MB） |
| `omnigent/web/electron/dist/win-unpacked/` | 免安装目录，可直接运行 `私募研究工作台.exe` |

Windows 本机访问（不拷贝也能测）：

```text
\\wsl$\Ubuntu\home\code\pravite_fund_ai_research\omnigent\web\electron\dist\
```

或拷贝 `.exe` 到任意目录双击安装。

### 复制 win-unpacked 到本机（重要）

必须**整目录完整复制**，`resources\app.asar` 不可丢（约 4MB）。缺这个文件时双击 exe **完全无窗口、无报错**。

推荐用 PowerShell 完整复制（比资源管理器拖拽更可靠）：

```powershell
$src = "\\wsl$\Ubuntu\home\code\pravite_fund_ai_research\omnigent\web\electron\dist\win-unpacked"
$dst = "$env:USERPROFILE\Desktop\win-unpacked"
robocopy $src $dst /E /NFL /NDL /NJH /NJS
# 核对
Test-Path "$dst\resources\app.asar"   # 必须为 True
Test-Path "$dst\PrivateFundWorkbench.exe"  # 或中文名 exe
```

不要只拷贝 `.exe`，也不要用损坏的半截拷贝。

### 跳过前端重建（加快迭代）

```bash
DESKTOP_SKIP_WEB_BUILD=1 bash scripts/desktop/build_windows_package.sh
```

## 运行时策略（当前：零依赖 native）

| 策略 | 说明 |
|---|---|
| **native（默认/产品路径）** | 安装包内嵌 Windows embeddable Python + Omnigent + LiteLLM + 瘦身 data_pipeline。目标机 **不需要** WSL / Python / Node。 |
| **WSL fallback** | 仅开发：`DESKTOP_ALLOW_WSL_FALLBACK=1` 时才启用。 |

数据目录（用户机）：

```text
%APPDATA%\PrivateFundWorkbench\data\private_fund_datasets   ← 对应原 output/private_fund_datasets
%APPDATA%\PrivateFundWorkbench\config
%APPDATA%\PrivateFundWorkbench\logs
```

LLM Key 由构建期写入 `resources/runtime/config/desktop.env`（**不要**提交真实 Key 到 git）。

## 目录结构

```text
omnigent/web/electron/
  boot/                 # 零配置启动页
  src/desktop_mode.js
  src/process_supervisor.js
  resources/runtime/    # assemble_runtime.sh 生成（gitignore 建议忽略 desktop.env）
    bin/start_stack_wsl.sh
    config/desktop.env
    project/            # slim monorepo 子集
      FinSagent/data_pipeline/
      src/pdf_research_demo/
      omnigent/
scripts/desktop/
  assemble_runtime.sh
  build_windows_package.sh
```

## 开发调试（不打包）

```bash
cd omnigent/web/electron
DESKTOP_MODE=bundled npm start
```

需本机/WSL 已有可健康检查的 `http://127.0.0.1:6767`，或 runtime 已组装且 WSL bridge 可用。

## FinSagent 边界

**允许：**

- `llm_model_name` / `llm_base_url` / `llm_api_key` → `desktop.env`
- `FinSagent/data_pipeline/*`（不含整仓 deploy/remotion/evaluation/vllm…）

**禁止打进安装包：**

- `FinSagent/deploy`
- remotion / evaluation / lightgbm / web-search-agent 等

## 验收清单（本机 Windows）

1. 安装 `PrivateFundWorkbench-Setup-*.exe`
2. 打开应用 → 启动页 → 自动起服务 → 进入工作台
3. 无需填写 Server URL / API Key
4. 对话 / 资料上传 / 笔记 基本可用
5. 退出后无残留异常进程（或 WSL tmux stack 由 stop 脚本清理）

## 体积与注意

- `resources/runtime/project` 含 omnigent 源码，安装包可能 **>500MB**
- macOS 安装包需在 macOS runner 上构建（WSL 不能可靠签 DMG）
- 内部分发：安装包内含 API Key，注意分发范围

## 源码同步说明（WSL monorepo 为准）

本地 I:\\code\\res\\win-unpacked 只是构建/热修产物。逻辑修改必须进入仓库后再打包：

| 组件 | 仓库路径 |
|---|---|
| 进程监督 / LiteLLM / Claude PATH | omnigent/web/electron/src/process_supervisor.js |
| bundled 模式与 userData | omnigent/web/electron/src/desktop_mode.js |
| 启动页 | omnigent/web/electron/boot/ |
| 项目根路径解析 | omnigent/omnigent/server/routes/private_fund_pdf.py（_desktop_private_fund_root） |
| 组装 Windows 全栈 | scripts/desktop/assemble_win_native.sh |
| runtime 热修（sitecustomize/examples/claude） | scripts/desktop/apply_runtime_fixes.sh + 	emplates/ |
| 只重打 asar | scripts/desktop/repack_electron_only.sh |

`ash
# 同步 runtime 垫片到已组装的 resources/runtime
bash scripts/desktop/apply_runtime_fixes.sh omnigent/web/electron/resources/runtime
# 更新 Electron asar
bash scripts/desktop/repack_electron_only.sh
`

业务数据（阳光电源等）**不是**打包默认内容；AppData 中的副本是排查时从 WSL output/ 手动拷贝的。

