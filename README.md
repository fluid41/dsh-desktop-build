# DSH Desktop · Windows 自构建

自动跟随 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方预发布标签，在 GitHub Actions 构建 Windows x64 安装包。**官方源码、版本号和根锁文件不改动。**

## 下载和更新

### [下载当前可用版本](https://github.com/fluid41/dsh-desktop-build/releases/tag/current)

[历史版本](https://github.com/fluid41/dsh-desktop-build/releases) · [构建状态](https://github.com/fluid41/dsh-desktop-build/actions/workflows/build.yml)

1. 第一次在仓库 **Watch → Custom → Releases** 开启新版通知。
2. 收到通知后，从固定入口下载 EXE。
3. 完全退出 DSH，再运行安装包更新，之后照常使用。

安装包采用上游未签名模式，Windows 可能提示未知发布者；应用不启用普通自动更新。账号、API Key 和插件配置由你自己管理，本仓库不修改这些配置。

每个版本附带安装包、SHA-256 和 [构建记录](scripts/cli.mjs)。可用 PowerShell 核对下载：

```powershell
Get-FileHash -Algorithm SHA256 .\deepseek-harness-版本-win-x64-unsigned.exe
```

## 自动跟进

- 每小时第 17 分钟检查官方已发布的 `dsh-v*` 预发布标签，按 SemVer 选择最新版本；GitHub 调度可能延迟。
- 自动固定源码提交，在托管 Windows runner 执行上游完整打包和运行时检查。本机无需编译工具。
- 已成功构建的版本不会重复构建。新版失败时，固定入口继续提供上一份可用安装包。
- 完整上传并验证版本化 Release 后，才更新固定入口；历史版本长期保留。
- 原样调用上游 unsigned 打包入口，保留上游运行时完整性及 Office／Host 冒烟检查。

## 手动构建与重试

打开 **Actions → Build unsigned Windows desktop → Run workflow**：`latest` 选择最新预发布，或填完整标签，例如 `dsh-v0.2.1-alpha.5`。运行失败可直接重试；日志在对应运行页面保留 14 天。

自动化由 [workflow](.github/workflows/build.yml) 和零第三方依赖的 [脚本](scripts/cli.mjs) 实现。测试命令：`node --test --test-isolation=none tests/*.test.mjs`。

这是个人构建渠道，不是 DeepSeek 官方发行渠道；上游许可证和第三方声明随应用保留。
