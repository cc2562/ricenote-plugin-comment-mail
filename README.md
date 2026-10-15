# 评论邮件通知 `ccrice.comment-mail`

订阅 `rice.comments` 的评论事件，把「新评论」「有人回复了你」「评论审核结果」三类通知**异步**发成邮件。
发信由插件自己实现（零第三方依赖的 SMTP 客户端），不依赖内核提供邮件能力，也不需要新建任何数据表。

- **插件 ID**：`ccrice.comment-mail` · **版本**：1.0.0 · **宿主**：ricenote `^0.8.0`（Plugin API `^1.0.0`）
- **后台页面**：`/admin/comment-mail`（侧栏「评论邮件」）
- **数据表**：无

---

## 1. 做什么

| 场景 | 触发时机 | 收件人 |
| --- | --- | --- |
| 新评论 | `content.comment.created.v1`（可按状态过滤） | 站长/管理员（可配多个邮箱，逐封单发） |
| 有人回复了你 | 该回复**最终公开**时 | 被回复者（父评论作者） |
| 你的评论已公开 | `content.comment.status.changed.v1` → `approved` | 评论者本人 |
| 你的评论未通过审核 | `status.changed` → `spam` / `trash`（**默认关闭**） | 评论者本人 |

邮件内容含：文章标题、**直达该条评论的链接**（`#comment-<id>`，与 `rice.comments` 插槽的 DOM id 对齐）、
评论者昵称与内容（500 字截断，HTML 侧全程转义）、当前状态；站长通知额外带**后台审核入口**
（`/admin/comments`），并默认把 `Reply-To` 设为评论者邮箱，便于直接回信。
页脚固定注明「本邮件由 {站点名} 自动发送，请勿直接回复」。

### 两条刻意的设计取舍

1. **审核即闸门**：对外（访客）的邮件只在评论「最终公开」时发出。
   若站点开启「新评论先审后发」，回复通知会**等到审核通过那一刻**才发 —— 既不会把待审内容外发，
   也不会给垃圾评论的被回复者发信。
2. **收件人隔离**：多个站长收件人**逐封单发**（一个 RCPT 一封信），收件人之间互相看不到邮箱，
   每条投递也可独立重试与统计。

---

## 2. 清单摘要

```json
"requires": { "rice.comments": "^1.5.0" },
"capabilities": ["events:subscribe", "routes:admin"],
"permissions": [
  { "key": "comment-mail.manage", "label": "管理评论邮件通知", "group": "互动" }
]
```

- **依赖是硬依赖**：评论事件自 `rice.comments@1.5.0` 起发布，缺失或版本过低时本插件不会启动（避免静默失效）；
  相应地，只要本插件启用，`rice.comments` 就不能被停用。
- **能力面最小**：只订阅事件 + 只提供后台管理 API。没有 `database:own`（不建表）、
  没有 `services:consume`（站长收件人直接从设置里读，不去猜谁是管理员）、没有 `slots:register`（不碰前台渲染）。
- **不提供**任何服务契约、扩展点、迁移、前台插槽。

### 后台管理 API

全部挂在 `/api/admin/comment-mail/*`，统一要求 `comment-mail.manage` 权限
（Core 自动套用认证 → CSRF → 权限 → 审计）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/comment-mail/status` | 配置自检 + 生效参数（**不含任何凭据**）+ 队列统计 + 最近投递记录 |
| GET | `/comment-mail/templates` | 模板编辑器的数据源：4 个场景、可用变量、内置默认、**当前生效**的模板与「哪些场景被自定义过」 |
| POST | `/comment-mail/template-preview` | `{ key, subject?, html? }` 用示例数据渲染，返回 `{ subject, html, text, warnings }` —— **与真实发信同一个渲染器** |
| POST | `/comment-mail/test` | `{ to }` 发配置自检邮件；带 `{ template: <场景> }` 时按该模板发预览（同样走真实 SMTP 链路，失败返回真实错误与「是否可重试」判断） |
| POST | `/comment-mail/records/:id/retry` | 重发某条仍在内存里的失败/丢弃记录 |
| POST | `/comment-mail/records/clear` | 清空记录缓冲 |

> 模板的**读取**走本插件自己的接口（上面两个）；**写入**必须走宿主的插件设置接口
> `PUT /api/admin/plugins/ccrice.comment-mail/settings`（要求 `plugin.manage` 权限）——
> 插件自己不能改设置，而设置又是启动期快照，所以保存后需要重启进程。

---

## 3. 设置项

设置分两组，在**扩展中心 → 插件 → 评论邮件通知 → 设置**里修改。
设置是**启动期快照**：改完必须重启服务才生效（同一张表单里的 SMTP 参数与本插件的通知开关都是如此）。

### 通知规则

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `notifyAdminOnNew` | boolean | `true` | 新评论通知站长 |
| `adminRecipients` | stringList | `[]` | 站长收件人（多个邮箱；留空则不发新评论通知） |
| `newCommentFilter` | select | `exclude-spam` | `all` 全部 / `exclude-spam` 排除垃圾（推荐）/ `approved-only` 仅已公开 |
| `notifyParentOnReply` | boolean | `true` | 回复通知被回复者 |
| `notifyCommenterOnApproved` | boolean | `true` | 评论公开时通知评论者本人 |
| `notifyCommenterOnRejected` | boolean | `false` | 判为垃圾/回收站时也通知评论者（默认关，见「安全」一节的取舍） |
| `adminMailReplyToCommenter` | boolean | `true` | 站长通知的 `Reply-To` 用评论者邮箱 |

### 发信（SMTP）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `smtpHost` | text | `""` | 服务器地址，如 `smtp.example.com` |
| `smtpPort` | number | `465` | 1–65535（隐式 TLS 常用 465，STARTTLS 常用 587） |
| `smtpSecure` | select | `ssl` | `ssl` 隐式 TLS / `starttls` 明文连接后升级 / `none` 不加密（仅内网中继） |
| `smtpUser` | text | `""` | 认证账号；留空表示不认证（可用 `RICE_MAIL_USER` 覆盖） |
| `smtpFromAddress` | text | `""` | **必填**：发件地址，多数服务商要求与认证账号同域 |
| `smtpFromName` | text | `""` | 发件人显示名，留空取站点标题 |
| `smtpReplyTo` | text | `""` | 兜底 `Reply-To`（站长通知没有更合适的回复地址时使用） |
| `smtpTimeoutMs` | number | `15000` | 连接与每次等待应答的上限（1000–60000） |
| `rateLimitPerMinute` | number | `30` | 每分发信上限（1–120），超出上限的任务延后投递 |

### 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `RICE_MAIL_PASSWORD` | 配置了 `smtpUser` 时必需 | SMTP 密码。**只从环境变量读取**，绝不落设置、日志或投递记录 |
| `RICE_MAIL_USER` | 否 | 覆盖设置里的认证账号，便于把整套凭据放进部署环境 |

> 为什么密码不进设置：插件设置只有 `text/textarea/boolean/number/select/image/url/color/stringList`
> 九种类型，**没有 secret 类型也没有加密存储**（导出设置时只按字段名过滤，不是加密）。
> 官方文档的结论是「真凭据放环境变量」，本插件遵循该约定。

### 邮件模板（四个场景，可自定义）

在 **后台 → 评论邮件 → 邮件模板** 里编辑：四个场景各一套「主题 + HTML 正文」（共 4 个 HTML 输入框），
支持**点选变量插入到光标处**、**实时预览**（用示例数据渲染，HTML 用沙箱 iframe 展示）与**按模板直接试发**。

| 场景 | 设置键（主题 / HTML） |
| --- | --- |
| 新评论 → 站长 | `templateAdminNewSubject` / `templateAdminNewHtml` |
| 回复 → 被回复者 | `templateReplySubject` / `templateReplyHtml` |
| 已公开 → 评论者 | `templateApprovedSubject` / `templateApprovedHtml` |
| 未通过 → 评论者 | `templateRejectedSubject` / `templateRejectedHtml` |

**留空 = 使用内置默认**（默认模板的内容会直接显示在编辑框里，可在此基础上改）。
只填 HTML 即可：**纯文本版本由 HTML 自动派生**（去标签、保留链接地址与换行），因此后台不需要维护两份内容。
「保存模板」走宿主设置接口，需要 `plugin.manage` 权限；保存后顶栏会出现**重启**按钮 —— 设置是启动期快照，**重启后才生效**
（重启前页面上的状态徽标会显示「已保存，待重启生效」）。

#### 可用变量

| 变量 | 含义 |
| --- | --- |
| `{{siteTitle}}` / `{{siteUrl}}` | 站点标题 / 站点地址 |
| `{{kindLabel}}` | 通知类型（如「新评论 → 站长」） |
| `{{postTitle}}` / `{{postUrl}}` | 文章标题 / 文章**绝对**地址 |
| `{{commentUrl}}` | 直达该条评论的链接（`...#comment-<id>`） |
| `{{adminUrl}}` | 后台评论审核页 |
| `{{commentId}}` | 评论 ID |
| `{{authorName}}` / `{{authorEmail}}` / `{{authorUrl}}` | 评论者昵称 / 邮箱 / 网址（可能为空） |
| `{{content}}` | 评论正文（HTML 里保留换行，等价于把换行换成 `<br>`） |
| `{{contentExcerpt}}` | 评论正文（500 字截断） |
| `{{status}}` / `{{statusShort}}` / `{{statusKey}}` | 状态：待审核/已公开/垃圾评论/回收站 · 待审/已公开/垃圾/回收站 · `pending`… |
| `{{parentAuthorName}}` / `{{parentAuthorEmail}}` | 被回复者昵称 / 邮箱 |
| `{{mailDate}}` / `{{year}}` | 生成时间（`YYYY-MM-DD HH:mm`）/ 年份 |

模板引擎是**纯文本替换**（自实现，绝不 `eval`）：不支持条件与循环；**未识别的变量原样保留**（便于一眼看出写错）
并在后台页高亮告警、同时记一条 `warn` 日志。HTML 模式下所有变量都会转义，因此变量无法注入标签；
主题行不做 HTML 转义但会清理换行与控制字符（防邮件头注入）。

---

## 4. 触发矩阵与去重

| 事件 | 条件 | 收件人 | 去重键（进程内） |
| --- | --- | --- | --- |
| `content.comment.created.v1` | 开关开 + 状态符合过滤器 + 收件人非空 | 站长（逐封） | `admin:{评论id}:{邮箱}` |
| `created`（已公开）/ `status.changed`→`approved` | 是回复 + 父评论作者有合法邮箱 + 不是自己 + 不是站长收件人 | 被回复者 | `reply:{评论id}:{邮箱}` |
| `status.changed`→`approved` | 开关开 + 评论者有合法邮箱 + 不是站长收件人 | 评论者本人 | `comment-approved:{评论id}:{邮箱}` |
| `status.changed`→`spam`/`trash` | 开关开（默认关）+ 同上 | 评论者本人 | `comment-rejected:{评论id}:{邮箱}` |

同一评论对同一收件人**只发一次**（哪怕「创建即通过」后又经历状态反复）。

---

## 5. 投递机制与可靠性

```
rice.comments 事件 ──► 事件处理器（只做决策 + 入队，立即返回）
                              │
                              ▼
                       内存 FIFO 队列 ──► worker（单并发）
                              │             │
                              │             ├─ 失败：1s / 5s / 30s（±20% 抖动）退避重试，最多 3 次
                              │             ├─ 4xx / 网络 / 超时 → 可重试
                              │             └─ 5xx（含 535 认证失败）→ 不可重试，直接落记录
                              ▼
                        投递记录环形缓冲（最多 200 条）──► 后台页查看 / 手动重发 / 清空
```

- **为什么异步**：内核的事件总线在 `emit` 时会 `await` 全部订阅者，一旦在处理器里直接发信，
  评论提交与审核接口就会跟着等一次 SMTP 会话。因此处理器只「去重 + 入队」，投递交给常驻 worker。
- **限速**：滑动窗口（默认 30 封/分钟）避免被邮件服务商限流；队列上限 200 条，超出则丢弃并留下可见记录。
- **排空**：插件停用/关机时先停止接单、忽略限速与退避在 5 秒内尽量发完，仍未发完的会写入日志告警
  （记录只在内存里，进程结束后不再保留）。
- **可观测**：成功 `info`、可重试失败 `warn`、不可重试失败 `error`；错误信息**先脱敏**（密码与疑似 base64 凭据都会被替换）再进日志与记录。

---

## 6. 安全与隐私

- 评论正文是**访客可控的原文**：进入 HTML 时逐字符转义，纯文本版保留原样；邮件头字段统一清理控制字符，杜绝头注入。
- 链接只由插件按「站点地址 + 文章路径 + `#comment-<id>`」拼装，不接受访客提供的地址。
- 密码不落库、不进日志、不进接口响应；后台只显示「是否已配置」。
- 收件人彼此不可见（逐封单发）；同一地址在同一评论上不会重复收信。
- `notifyCommenterOnRejected` **默认关闭**：向未验证的地址回信既容易被用来探测邮箱有效性，
  也会给垃圾评论发送者反馈信号。确有需要再手动开启。
- 不发送退订链接：邮件页脚注明「系统通知，请勿直接回复」。
- 模板是**数据**不是代码：`{{变量}}` 由自实现的替换器处理，没有 `eval` / `new Function`，也不支持条件与循环；
  HTML 模式下所有变量转义（正文额外把换行换成 `<br>`），主题行清理换行与控制字符（防邮件头注入）。
  因此后台即使填入恶意模板，也无法借变量把访客内容变成可执行代码。
- TLS：隐式 TLS 与 STARTTLS 均**默认校验证书**，没有提供「跳过证书校验」的选项；仅内网中继才建议 `none`（后台自检会给出明文凭据告警）。

---

## 7. 部署

插件必须放在 ricenote 仓库树内 —— `@ricenote/plugin-sdk` 是从仓库根的 `node_modules` 解析的，
放到仓库外会加载失败。

### 7.1 手动复制（本地开发 / 自建）

```bash
# 1. 放进第三方插件目录
cp -r ccrice.comment-mail  <ricenote>/plugins/third-party/

# 2. 纳入工作区并构建（plugins/third-party/* 已在 pnpm-workspace.yaml 中）
cd <ricenote> && pnpm install && pnpm build
#    只想构建这一个包：pnpm --filter ./plugins/third-party/ccrice.comment-mail build

# 3. 配置环境变量（.env）
RICE_MAIL_PASSWORD=你的SMTP密码
# RICE_MAIL_USER=可选，覆盖设置里的认证账号

# 4. 校验 → 启动
pnpm validate && pnpm start
```

### 7.2 以 Git 仓库直装（`pnpm plugin install --git`）

仓库根就是插件根（`manifest.json` 在最外层），可直接用安装器的 Git 来源安装：

```bash
pnpm plugin install --git https://github.com/cc2562/ricenote-plugin-comment-mail.git --ref v1.0.0
pnpm plugin enable ccrice.comment-mail        # 安装**不会**自动启用
# 重启进程
```

> 仓库：<https://github.com/cc2562/ricenote-plugin-comment-mail>（`--ref` 可省略，默认取默认分支的 HEAD）。

安装器行为与我们这份布局的对应关系（三点都是刻意设计的，改动前请先读第 8 节）：

1. **仓库必须提交构建产物 `dist/`。**
   本插件以 `plugins/third-party/*` 参与 ricenote 工作区，所以 `package.json` 的 `devDependencies`
   用的是 `workspace:^`；安装器识别到 `workspace:` 协议后会**跳过依赖安装与构建**，直接使用仓库里已有的产物
   —— 这恰好也是唯一可行的做法：安装器的构建发生在 `<ricenote>/storage/cache/plugin-install-*/` 的临时目录里，
   在那里 `tsconfig.json` 的 `extends: "../../../tsconfig.base.json"` 会解析到不存在的 `storage/tsconfig.base.json`。
   产物缺失会在安装校验阶段以「插件包缺少入口文件」直接失败。
2. **宿主包只能写在 `peerDependencies`**（+ `peerDependenciesMeta.optional = true`）；
   写进 `dependencies` 会被安装器明确拒绝（会装出第二份 `@ricenote/plugin-sdk`，属高危事故）。
3. **插件不能放在更深的子目录**：安装器没有 `--subdir`，只认「仓库根」或「唯一一层包装目录」里的 `manifest.json`。

安装后的状态：目录落在 `plugins/third-party/comment-mail/`（目录名取 `manifest.id` 的短名），
来源记录写入 `rn_plugins`（`source_type/source_spec/source_ref/resolved_version`）。
`pnpm plugin updates` 用 `git ls-remote` 比较**提交短哈希**（不比较语义化版本），
因此往同一个 ref 推送新提交就会被认作可更新；`pnpm plugin update ccrice.comment-mail` 会按记录的来源重建目录。
`pnpm plugin remove ccrice.comment-mail` 会删除该目录并清掉来源记录（存在已启用的反向依赖时会被拒绝）。
安装第三方插件等同授予服务器代码执行权，请只装可信来源；`--no-scripts` 只关依赖 lifecycle 脚本，
**关不掉构建步骤**（本插件因为 workspace 协议本来也不会构建）。

### 7.3 其它来源

`--dir <本地目录>` 与 `--zip <压缩包>` 走同一条「跳过构建、直接用产物」的路径，因此同样要求压缩包/目录里**带着 `dist/`**。
本地开发时把目录登记到 `.env` 的 `RICENOTE_LOCAL_PLUGINS`，即可免「安装」动作、改完 `pnpm build` 后自动重启生效。

### 7.4 启用与权限

- 安装不会自动启用：用 `pnpm plugin enable ccrice.comment-mail`，或到 **后台 → 扩展中心 → 插件** 里启用（改完需重启）。
- 启用后后台入口出现在侧栏「评论邮件」。权限点 `comment-mail.manage` 由本插件声明，
  内置的 `administrator` 角色（`*`）天然可用；其它角色需要在权限管理里显式授予。
- 只要本插件启用，`rice.comments` 就不能被停用（`requires` 是硬依赖）。

### 上线自查清单

1. 「评论邮件」页第一屏**配置自检**全绿（服务器 / 发件地址 / 密码环境变量 / 收件人）。
2. 填一个自己的邮箱点「发送测试邮件」，能看到成功回执。
3. 前台发一条评论 → 站长收到通知（若开启先审后发，会收到「待审核」主题）。
4. 用另一个邮箱回复该评论 → 审核通过后被回复者收到「回复了你」。
5. 后台把一条待审评论改为「已通过」→ 评论者收到「你的评论已公开」。
6. 故意填错一次 SMTP 密码（改环境变量后重启）→ 测试发信给出「535 …」错误且提示为配置问题。

---

## 8. 已知限制

- **不持久化**：投递记录只在内存中，重启即清空；平台也没有插件可用的持久化队列或定时任务，
  因此「失败重试」只能靠进程内退避 + 后台手动「重发」。
- **不能由安装器构建**：`devDependencies` 用了 `workspace:^`（工作区内插件的写法），
  安装器据此跳过依赖安装与构建、直接使用仓库里已提交的 `dist/`（见 7.2）。
  若要让安装器或 CI 自行构建，需按官方 `scripts/split-plugin-repos.mjs` 的镜像仓库形态改造：
  `tsconfig.json` 改为**自包含**（不 `extends` 仓库外的文件）、`devDependencies` 换成普通版本区间
  （`@ricenote/plugin-sdk: ^0.8.0` / `@ricenote/shared: ^0.8.0`，这两个包已在 npm 上发布）、
  并且仓库里不再提交 `dist/`。
- **不做退订**：页脚固定为「系统通知」提示（见第 6 节）。
- **模板无条件与循环**：只有 `{{变量}}` 替换；想做「是回复才显示某段」这类分支，只能拆成两套场景模板。
- **纯文本版本是派生的**：由 HTML 去标签生成，若模板里用了复杂布局/嵌套表格，降级后的纯文本可能不够漂亮
  （大多数客户端展示 HTML 版本，影响有限）。
- **改模板要重启**：模板存在插件设置里，保存后必须重启进程（与其它设置一致）。
- **删除评论不通知**：平台只在状态真正改变时发布事件，删除没有事件。
- **设置改动需重启**：`ctx.config` 是启动期快照（站点标题/地址除外，它们是动态读取的）。
- **仅支持纯文本正文**：与 `rice.comments` 的正文处理保持一致（评论不存 HTML）。
- **未在真实服务器上验证的部分**：隐式 TLS / STARTTLS 的具体握手细节、各家服务商的退信与限流策略、
  邮件在主流客户端的渲染效果 —— 请在真实 SMTP 上按第 7 节清单确认。

---

## 9. 本插件是怎么被验证的

| 层级 | 手段 | 结论 |
| --- | --- | --- |
| manifest | 用 ricenote 自带的 JSON Schema（`packages/shared/manifests/*.schema.json`）+ Ajv 实际校验 | 通过（含版本一致性与入口文件存在性） |
| 类型/构建 | `tsc`（宿主 `^0.8.0` 的真实 `.d.ts`） | 通过，产物在 `dist/` |
| 单元 | `node --test`：MIME/RFC2047/dot-stuffing、模板引擎与转义、HTML→纯文本降级、四套默认模板的可渲染性、触发矩阵与去重、队列退避与排空、本地假 SMTP 服务器上的完整会话与错误分类 | 66 项用例全部通过 |

上述校验用的是工作区里的辅助脚本（位于插件目录**之外**，不属于插件交付物）：
`typecheck.mjs`（生成临时 tsconfig，把 `@ricenote/*` 映射到你的安装并对齐宿主配置后调用其 tsc）、
`validate-manifest.mjs`、`tests/*.test.mjs`。
