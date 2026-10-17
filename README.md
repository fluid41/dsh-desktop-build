# DSH Desktop · Windows 自构建

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

跟随 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方预发布版本，自动构建并发布 Windows x64 安装包。保留官方源码、版本号和依赖锁文件，不修改账号或插件配置。

## 下载与更新

### [下载最新版](https://github.com/fluid41/dsh-desktop-build/releases/tag/current)

[历史版本](https://github.com/fluid41/dsh-desktop-build/releases) · [构建状态](https://github.com/fluid41/dsh-desktop-build/actions/workflows/build.yml)

1. 下载 EXE 安装包。
2. 从系统托盘完全退出 DSH；如有使用 Desktop 运行时的 CLI，也先退出。
3. 运行安装包，安装到原目录。更新或从官方版迁移都无需先卸载，已有会话和配置继续使用；首次迁移前建议备份数据。

在仓库 **Watch → Custom → Releases** 订阅新版通知，以后从同一入口下载更新。

安装包未签名，Windows 可能提示未知发布者。此构建需手动更新，保留上游强制更新策略。

### 校验下载

每个版本附带安装包、[构建清单](https://github.com/fluid41/dsh-desktop-build/releases)（`build.json`）和 SHA-256 校验值（`SHA256SUMS`）。用 PowerShell 计算安装包哈希，与发布页校验值核对：

```powershell
Get-FileHash -Algorithm SHA256 .\deepseek-harness-版本-win-x64-unsigned.exe
```

## 自动构建

- **每 6 小时检查一次**：北京时间每天 **00:00、06:00、12:00、18:00**（UTC 04:00、10:00、16:00、22:00）。GitHub Actions 按整点计划触发，实际启动可能延迟。
- 从官方已发布的 `dsh-v*` 预发布标签中，按版本号选择最新版并固定源码提交。
- 在 GitHub 托管的 Windows 环境中，使用上游完整打包流程和运行时检查，本机无需编译工具。
- 已发布的版本不重复构建；安装包上传并校验完成后才更新下载入口。构建失败时继续提供上一可用版本，历史版本保留。

## 手动检查与重试

打开 **Actions → 构建 Windows 安装包 → Run workflow**，保留 `latest` 检查最新版，或填写完整官方标签，例如 `dsh-v0.2.1-alpha.5`。

失败后可重试对应任务。构建日志和诊断文件保留 14 天。

## 项目维护

[构建工作流](.github/workflows/build.yml)负责调度，[构建脚本](scripts/cli.mjs)负责版本选择、校验和发布，无第三方运行依赖。使用 Node.js 24 或更高版本运行测试：

```sh
npm test
```

这是个人构建项目，并非 DeepSeek 官方发布渠道。上游许可证和第三方声明随应用保留。
