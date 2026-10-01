# 今日海大吃什么

上海海洋大学校内和周边餐饮目录，记录店铺位置、餐品、价格、来源及不同同学的实际体验。

首页按餐品展示，并支持餐段、价格、校内外范围、已知距离与标签筛选后抽签。餐厅与档口单独位于 `/restaurants/`。详情页下方可直接提交五星评分、最多 256 个 Unicode 字符的文字和最多 3 张照片；评价仍需审核、内容 PR 和生产部署后公开。`/submit/` 只负责新增餐厅 / 档口与餐品，旧评价链接会转至对应详情页。

## 开发

项目使用 Astro、React 与 TypeScript，Node.js 和 pnpm 由 Pixi 管理。安装 Pixi 后运行：

```bash
pixi install --locked
pixi run --locked dev
```

内容位于 `src/content/restaurants/`，一条餐厅记录对应一个 JSON 文件，schema 位于 `src/content/config.ts`。内容来源、许可状态、核验时间与用餐时间单独记录。不得将整理日期当成用餐或核验日期。

## 架构

- Astro 静态 HTML 与 React 筛选卡片构成手机优先的网站。
- Workers Static Assets 提供公共静态资源；Worker 负责 `/api/*` 投稿、审核 API、GitHub 发布队列和 `/media/*` 媒体路由。`/media/{assetId}.webp` 只返回已经通过生产部署回调公开的不可变 R2 对象。
- D1 使用 SQLite 语法，私有保存待审原稿、编辑稿、规范化 venue/food/review、媒体元数据、审核审计和 PR 状态。公共浏览不查询 D1；目录同步只更新已发布的 `catalog_mirror` 快照，不覆盖待审实体。
- Turnstile 限制自动投稿；Cloudflare Access 邮箱策略保护 `/admin/*`，Worker 验证 JWT 签名、受众、签发者和有效期。
- 批准稿通过 GitHub App 创建到 `dev` 的内容 PR。PR 合并到 `dev` 后进入 Preview；发布 PR 合并到 `main` 并部署成功后才标记已发布。
- 图片模式为 `r2`。投稿只接受客户端重编码的 WebP（每张最多 2 MiB、最多 4096×4096、拒绝 EXIF/XMP 与动画），R2 对象先保持私有；投稿回执或 Access 审核预览才可读取。审核通过的内容 PR 只写入不可变 `/media/{assetId}.webp` 引用与来源元数据，生产部署回调核对仓库、完整 commit 和内容哈希后才切换 R2 对象为公开。应用自身保留 100 MiB 总媒体容量、每日 100 次上传尝试和每月 1000 次媒体写入（包含上传及发布等操作）限制；这些限制不代表 Cloudflare 账号费用上限。

投稿状态查询使用只向投稿者显示一次的回执令牌。D1 只保存其 SHA-256 哈希。投稿、原稿和审核员私有笔记不得写入公开内容或日志。

## 配置与部署

复制 `.dev.vars.example` 到 `.dev.vars` 仅用于本地 Worker，不能提交真实值。根目录 `wrangler.jsonc` 保留可审查的占位符；部署脚本从环境变量生成被忽略的 `wrangler.generated.*.jsonc`，不会把账号 ID 或 D1 ID 写入仓库。生产与预览必须使用不同的 D1 数据库：

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"
$env:CLOUDFLARE_D1_DATABASE_ID = "<production-d1-uuid>"
$env:CLOUDFLARE_PREVIEW_D1_DATABASE_ID = "<preview-d1-uuid>"
$env:CLOUDFLARE_R2_BUCKET_NAME = "<production-r2-bucket>"
$env:CLOUDFLARE_PREVIEW_R2_BUCKET_NAME = "<preview-r2-bucket>"
pixi run --locked config-check
pixi run --locked d1-migrate-local
pixi run --locked workers-dev
```

生产配置将 Worker 绑定到 `eat.shoumc.com` Custom Domain，并由 Cloudflare 自动管理 DNS 与证书；预览配置使用独立 Worker 名称和 D1。已登录 Wrangler 的维护者可直接运行 `pixi run --locked workers-deploy`，在 CI 中还需提供 `CLOUDFLARE_API_TOKEN`；脚本会先检查配置、生成忽略的运行配置、应用可重试迁移，再部署 Worker 与 `dist` 静态资源。发布队列默认关闭，只有把部署环境变量 `PUBLICATION_ENABLED=true` 后才会启用 Cron、校验发布凭据并要求部署回调：

```powershell
pixi run --locked workers-deploy-preview
pixi run --locked workers-deploy
```

GitHub Actions 的 `preview` 环境需要 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_PREVIEW_D1_DATABASE_ID`；`production` 目录首发需要 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_D1_DATABASE_ID`。目录首发模式不要求投稿凭据或 R2 bucket；启用 `PUBLICATION_ENABLED=true` 且使用 `MEDIA_MODE=r2` 时，生产环境还需要对应的 R2 bucket、`DEPLOY_WEBHOOK_URL` 和 `DEPLOY_WEBHOOK_SECRET`。Cloudflare Worker Secrets 在对应 Worker 环境中单独保存，投稿审核功能启用时名称为 `TURNSTILE_SECRET_KEY`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ACCESS_REVIEWER_EMAIL`、`GITHUB_APP_ID`、`GITHUB_PRIVATE_KEY`、`GITHUB_INSTALLATION_ID`、`GITHUB_WEBHOOK_SECRET` 和 `DEPLOY_WEBHOOK_SECRET`；公开变量为 `MEDIA_MODE=r2`、`TURNSTILE_HOSTNAME`、`PUBLIC_TURNSTILE_SITE_KEY`。预览配置固定为目录首发关闭模式（`PUBLICATION_ENABLED=false`），不要求 Turnstile、Access 或 GitHub App Secret；不把这些值写入 Wrangler `vars` 或 GitHub 日志。GitHub App 使用仓库级 `contents: write`、`pull_requests: write`、`metadata: read`，安装 ID 由维护者配置到 Worker Secret。R2 bucket 通过忽略的 generated Wrangler 配置绑定为 `IMAGES`。

首发目录模式（`PUBLICATION_ENABLED=false`）只开放静态目录与 Worker 健康检查：`/api/health` 返回 200 并标明 `catalog-only`，投稿、回执、审核、Webhook 和发布队列均返回 503，即使环境中残留相关 Secret 也不会启用。启用完整发布模式后，若凭据缺失，`/api/health` 返回 503；静态餐厅目录与静态 `/admin` 页面仍可部署。`/admin` 与 `/admin/` 由静态资源提供，正式环境须在 Cloudflare Access 中保护该路径；Worker API 没有 JWT 时返回 401，并在完整模式下继续验证 `Cf-Access-Jwt-Assertion` 的签名、受众、签发者和有效期。Access、Turnstile 或 GitHub App 尚未配置时不要报告投稿已发布。启用发布链后，部署回调必须使用 HTTPS，并且只在 Worker 部署命令成功后发送；目录首发不发送回调，也不标记私稿为已发布。

免费额度是账号共享的使用上限，不代表超限后服务一定正常。请求超限时投稿接口会拒绝或暂停，静态餐厅目录仍可访问。部署前须检查 Cloudflare 账号已有用量和当期官方额度。

## v2 投稿接口

`POST /api/v2/submissions` 接受 `schemaVersion: 2` 的 venue、food 或独立 review。页面使用构建生成并发布到 `/catalog-snapshot.json` 的实际 `catalog-v2-<hash>`；Worker 会在入库时再次解析并锁定该快照。坐标只接受 canonical `[latitude, longitude]`；价格只接受整数分字段 `amountCents` 或完整的 `minCents`/`maxCents`，并且必须带来源。独立 review 必须有 1–5 的整数 rating；附带 review 可以只有 rating，文本按 Unicode code point 限制为 256。

带图稿件先声明 `expectedImages`（实体最多 6）和 `expectedReviewImages`（附带评价最多 3），再用回执令牌调用 `POST /api/v2/submissions/{id}/images`，图片请求需带槽位、版本、替代文本、来源、版权人、许可、权利确认和许可初始状态；`POST /api/v2/submissions/{id}/finalize` 校验精确数量与版本后才进入待审。状态查询仍使用私有回执。审核 API 位于 `/api/v2/admin/*`，由 Access JWT 保护，并只接受维护者通过 Worker Secret 注入的审核邮箱。

GitHub App 回调保持 `POST /api/v1/webhooks/github`，仅处理 `pull_request` 事件；生产部署回调保持 `POST /api/v1/webhooks/deploy`，请求必须携带 `{repository, commit, contentHash, jobId}`，四者与 D1 中对应的待发布任务完全匹配后才会标记发布。发布清单保存在仓库根 `.publication-manifest/`，部署脚本只读取当前提交新增的清单，不会把历史任务重新回调，也不会进入 Astro `dist`。旧 `/api/v1` 投稿、审核编辑、审核决定和发布重试写入口默认以 `410 v2_required` 关闭。

```bash
pixi run --locked typecheck
pixi run --locked test
pixi run --locked build
git diff --check
```

`test` 覆盖迁移条目、数据完整性、图片地址、稿件校验、投稿回执、重复提交、未知 API、Access 权限和服务未配置时的静态/健康检查；完整 Worker 与 GitHub 云端联调还需配置 Cloudflare、Turnstile、Access 和 GitHub App 测试凭据。投稿的 `Idempotency-Key` 会按来源地址哈希并写入私有 D1，重复的相同请求返回 409 且不重新发放回执令牌，换正文复用同一标识也返回 409；D1 只保存回执令牌哈希。

## 来源与许可

来源许可按条目标注：旧美食站内容遵循其 `CC BY-NC-SA 4.0` 来源声明；SHOU-Online-Manual 内容遵循其 `CC BY-SA 4.0` 来源声明。混合来源条目必须保留每个来源的作者、链接、署名与许可边界。未获许可的原图片不迁移。新提交由投稿人保留权利；发布前由审核员按贡献者实际授权确认可发布范围。
