# CloudBase 初始化

应用已内置环境 ID 和 Publishable Key。首次使用只需完成数据库初始化：

1. 打开腾讯云 CloudBase 控制台中的 Supabase / PostgreSQL SQL Editor。
2. 完整执行 `cloudbase/schema.sql`。
3. 在“身份认证 → 登录方式”确认“用户名密码登录”可用，并允许邮箱验证码注册。
4. 启动应用，在“好友”页面注册。注册时验证一次邮箱，此后使用用户名和密码登录。

旧 Supabase 账号不会自动出现在 CloudBase 中，因为两个系统的用户 ID 不同。原本保存在本机的学习数据不会丢失；用新 CloudBase 账号登录并开启同步后，可把本机数据上传到新环境。

CloudBase for Supabase 暂无 PostgreSQL Realtime。应用会在好友页前台使用自适应轮询，并对学习数据使用低频前台同步。

脚本不会直接给业务表添加指向 `auth.users` 的外键，因为不同 CloudBase 环境中的用户 ID 列可能采用 `uuid` 或 `varchar`。用户归属仍通过 `auth.uid()` 和 RLS 校验，不影响数据隔离。
