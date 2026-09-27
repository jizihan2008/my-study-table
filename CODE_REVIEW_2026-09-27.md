# 代码审查记录 — 2026-09-27

补充审查见 `CODE_REVIEW_2026-09-27_ROUND2.md`：新增 11 项，两轮合计 17 项。

审查对象为当前工作区，包括原有未提交修改。未修改业务代码。重点检查了启动顺序、localStorage/IndexedDB 持久化、云同步与冲突处理、Electron 权限与网页读取、插件隔离、插件市场，以及当前 AI/笔记/日历改动。并运行现有语法、单元和界面测试。这不是对所有执行路径或生产云环境的无缺陷保证。

## 已确认问题

### 1. [P1] 存储降级会静默丢失新数据

位置：`js/platform.js:51–54`（`setRaw` 也相同），`js/data-store.js:131–139`。

localStorage 写入因容量不足失败时，代码异步调用 StudyData.put 后立即报告 `ok: true`，没有检查实际持久化结果。即使 IndexedDB 成功写入，下次 initialize 仍无条件将 localStorage 的旧值写回 IndexedDB。调用方会认为保存成功，重启后却恢复旧内容；同步从 localStorage 读取时也只能看到旧值。

隔离复现结果：`{ reportedOk: true, beforeInitialize: 'new', afterInitialize: 'old' }`。另一个故障注入中 IndexedDB 也返回失败，平台仍返回成功。

建议：统一持久化事实来源；异步保存确认成功后才报告成功。缓存失效必须明确标记，恢复时依据有效版本协调，不能把旧缓存覆盖到最新持久化记录。

### 2. [P1] AI 默认对话在恢复前写入，覆盖可恢复的历史

位置：`js/settings.js:318–337`，`js/bootstrap.js:14–18`。

settings.js 在脚本加载阶段读取 localStorage；发现没有对话就立即创建并保存默认对话。IndexedDB 恢复稍后才在 bootstrap 中执行。因此 localStorage 的对话键缺失而 IndexedDB 中仍有历史时，默认对话会覆盖两处数据，破坏本应可用的恢复副本。

真实 Electron 隔离复现：先保存含标记的历史到 IndexedDB，移除 localStorage 的同名键，再刷新。结果 localStorage 和 IndexedDB 中都没有历史标记。

建议：在读取业务状态、迁移和创建默认数据之前完成持久化恢复；恢复失败时也不要立即用默认值覆盖已有数据库。

### 3. [P1] 沙箱宿主没有校验插件权限

位置：`js/ext-sandbox.js:76–102`、`js/ext-sandbox.js:132–133`。

权限检查仅存在于插件 iframe 内的 API 包装。宿主收到具有正确来源和 token 的 command 后直接转发给 extAPI，没有检查 manifest.permissions。插件代码与包装代码同处 iframe，可自行发 boot 消息、监听宿主返回的 init 获取 token，然后构造 command，绕过内部包装。

真实 Electron 隔离复现：manifest 设置 `permissions: []`，插件仍成功触发宿主 external 操作。探针把 external 替换成记录函数，没有实际打开外部网站。

建议：将可信权限集合保存在宿主 runtime，在 handleCommand 中按每一种操作强制校验；不要把 iframe 内的检查视为权限边界。

### 4. [P1] 插件数据命名空间存在拼接碰撞

位置：`js/ext-api.js:53–58`、`js/ext-sandbox.js:59–67`。

存储键直接拼接 `study_ext_<id>_<key>`，而插件 ID 和数据键都允许下划线。插件 `review_a` 的 `b_secret` 与插件 `review_a_b` 的 `secret` 是同一个键。前者可以读写、删除后者的数据；沙箱初始化按同一前缀枚举，也会直接把后者的数据提供给前者。

隔离复现：为 `review_a_b` 写入 secret 后，`review_a` 读取 b_secret 得到了另一插件的私有值。

建议：使用结构化复合键或无歧义的编码/分隔规则，并迁移旧存储键。读取枚举也必须使用相同的精确边界规则。

### 5. [P2] 删除的插件数据会在恢复时重新出现

位置：`js/ext-api.js:180–182`、`js/data-store.js:140–143`。

启动初始化会镜像插件 localStorage 数据到 IndexedDB，但 extAPI.removeData 只删除 localStorage，未写入 IndexedDB 删除标记。下一次初始化把键缺失当作需要恢复，导致已经删除的数据重新出现。同步日志清理也存在类似直接 removeItem 的调用，需要一并排查。

隔离复现：插件键写入并镜像后调用 removeData，值为 null；再次 initialize 后值变回 `'old value'`。

建议：所有受镜像管理的删除统一经过 StudyPlatform.storage.remove，或统一接入具备删除墓碑的仓库接口，禁止各模块自行绕开。

### 6. [P2] IPv4 映射 IPv6 地址绕过私网限制

位置：`electron/security.js:53–60`，调用点 `main.js:1957`。

isPrivateIpv6 检查 `::ffff:127.` 等十进制前缀，但在此之前 new URL 已把映射地址规范化为十六进制。比如 `http://[::ffff:127.0.0.1]/` 变成 `http://[::ffff:7f00:1]/`，不匹配拦截规则，网页读取的本机/私网限制因此可绕过。

实际执行当前校验函数，127.0.0.1 和 192.168.1.2 的 IPv4 映射 IPv6 形式均被接受。本次没有向这些地址发出网络请求。

建议：先规范化并解析 IP 地址，对映射 IPv6 提取其 IPv4 后统一检查网段；补充 URL 规范化之后的测试，而非只测试原始地址字符串。

## 验证结果与限制

- `node scripts/check-project.js`：160 个 JavaScript 文件语法检查通过。
- `node --test tests/*.test.js`：302 项通过，0 项失败。
- 完整 Playwright：86 项通过，2 项失败，10 项未运行。
- 凭据迁移失败：当前运行环境报告“当前系统无法使用安全凭据存储”。尚未证明在普通用户桌面环境也失败，未把它归为已确认业务缺陷。
- 外观测试失败：`preset, material and sliders compose and survive a renderer reload` 报 `Target crashed`，单独重跑同一测试文件仍失败，其余 10 项未运行。根因尚未定位，不能据此断定具体外观函数有错。
- 系统 npm 启动器找不到 `npm-cli.js`，因此直接运行对应 Node 入口；这属于本机工具环境问题。
- 未连接或修改真实云端数据库；云端行为主要依据源码和现有模拟测试判断。未执行生产发布、更新安装或真实外部通信。

## 可重复执行的证据

- `review-probes.cjs`：最小复现脚本，使用独立临时 Electron profile，不使用个人应用数据。
- `review-probes.log`：6 个问题的复现输出。
- `review-tests.log`：单元测试结果。
- `review-e2e.log`：完整界面测试结果。
- `review-appearance.log`：外观测试独立复跑结果。

建议先处理两项持久化数据丢失问题，再修复插件宿主授权和数据隔离，随后处理删除恢复与私网地址校验。同时应定位可复现的外观渲染器崩溃，补跑被阻断的 10 项测试。
