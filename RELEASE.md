# 发布检查清单

1. 执行 `npm ci`、`npm run verify` 和 `npm run test:e2e`。
2. 在 Supabase SQL Editor 审阅并执行 `supabase/schema.sql`，随后验证 RLS 与 Storage policy。
3. 在 GitHub Actions 配置 `WINDOWS_CSC_LINK` 和 `WINDOWS_CSC_KEY_PASSWORD`。证书应来自受信任的 Windows 代码签名机构，私钥不得写入仓库。
4. 创建 `v<package-version>` 标签触发签名发布任务。缺少签名凭据时，标签发布应失败，不应分发未签名安装器。
5. 从干净账户安装上一版本，写入待办、笔记、AI 配置和邮箱配置，再升级验证 IndexedDB 与 safeStorage 迁移。
6. 验证自动更新包的 SHA-512 元数据与 Windows 签名，测试升级失败后的旧版本回退。
7. 检查 `%USERPROFILE%\.my-study-table\logs\diagnostics.log`，确认错误信息不含用户凭据。

本地目录构建可使用 `npm run build:dir`，不要求签名；面向用户的 NSIS/portable 发布必须通过标签 CI 和代码签名。
