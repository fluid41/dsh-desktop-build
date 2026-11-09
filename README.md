# DSH Desktop · Windows 自构建

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方预发布版本原样构建的 Windows x64 安装包，未签名。

### [下载当前版本](https://github.com/fluid41/dsh-desktop-build/releases/tag/current) · [历史版本](https://github.com/fluid41/dsh-desktop-build/releases) · [构建状态](https://github.com/fluid41/dsh-desktop-build/actions/workflows/build.yml)

退出 DSH，运行安装包，装到原目录即可，更新无需卸载。版本页附 SHA-256 校验值。在 **Watch → Custom → Releases** 订阅更新通知。

## 构建新版

仅手动触发：[Actions → Run workflow](https://github.com/fluid41/dsh-desktop-build/actions/workflows/build.yml)，填 `latest` 或官方标签（如 `dsh-v0.2.2-rc.1`）。`source_sha` 留空则构建标签提交，填写则改用指定的上游提交。已构建的版本不重复构建，失败时保留上一可用版本。

在 GitHub 托管环境运行上游完整打包流程，本机无需编译工具。个人构建，非官方渠道。
