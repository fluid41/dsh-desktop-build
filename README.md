# DSH Desktop · Windows 自构建

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

手动触发，基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方预发布版本构建 Windows x64 安装包。保留官方源码、版本号和依赖锁文件，不修改账号或插件配置。

## 下载与更新

### [下载当前可用版本](https://github.com/fluid41/dsh-desktop-build/releases/tag/current)

[历史版本](https://github.com/fluid41/dsh-desktop-build/releases) · [构建状态](https://github.com/fluid41/dsh-desktop-build/actions/workflows/build.yml)

1. 下载 EXE 安装包。
2. 从系统托盘完全退出 DSH；如有使用 Desktop 运行时的 CLI，也先退出。
3. 运行安装包，安装到原目录。更新或从官方版迁移都无需先卸载，已有会话和配置继续使用；首次迁移前建议备份数据。

在仓库 **Watch → Custom → Releases** 订阅构建发布通知，以后从同一入口下载更新。

安装包未签名，Windows 可能提示未知发布者。此构建需手动更新，保留上游强制更新策略。

### 校验下载

每个版本附带安装包、构建清单（`build.json`）和 SHA-256 校验值（`SHA256SUMS`）。用 PowerShell 计算安装包哈希，与发布页校验值核对：

```powershell
Get-FileHash -Algorithm SHA256 .\deepseek-harness-版本-win-x64-unsigned.exe
```

## 构建新版

**仅手动触发，不定时检查。**

打开 [Actions](https://github.com/fluid41/dsh-desktop-build/actions/workflows/build.yml) → **构建 Windows 安装包 → Run workflow**：

- 保留 `latest`：选择官方最新预发布版本。
- 填写完整标签：构建指定版本，例如 `dsh-v0.2.1-alpha.5`。

已发布的版本不会重复构建。新版构建、上传和校验完成后，自动更新固定下载入口；失败时继续提供上一可用版本，历史版本保留。

失败后可重试对应任务。构建日志和诊断文件保留 14 天。

## 构建方式

[构建工作流](.github/workflows/build.yml)在 GitHub 托管的 Windows 环境中运行上游完整打包流程，保留上游运行时检查。本机无需编译工具。

[构建脚本](scripts/cli.mjs)负责版本选择、校验和发布，无第三方运行依赖。

这是个人构建项目，并非 DeepSeek 官方发布渠道。上游许可证和第三方声明随应用保留。
