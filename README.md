# 今日海大吃什么

上海海洋大学校内和周边餐饮目录，记录店铺位置、餐品、价格、来源及不同同学的实际体验。

首页按餐品展示，并支持餐段、价格、校内外范围、已知距离与标签筛选后抽签。餐厅与档口单独位于 `/restaurants/`。详情页下方可直接提交五星评分、最多 256 个 Unicode 字符的文字和最多 3 张照片；评价仍需审核、内容 PR 和生产部署后公开。`/submit/` 负责新增餐厅 / 档口与餐品，可展开默认折叠的随稿评价区，选填评分、文字和最多 3 张评价照片；这些内容与资料一同审核、发布。旧评价链接仍会转至对应详情页。

公开目录另生成静态 `/catalog-index.json`，只含已发布的浏览字段。首页依次展示抽签、餐品好评与上新、店铺好评与上新，不再展开全部目录。餐品与店铺的完整筛选分别位于 `/foods/`、`/restaurants/`，默认按评分排序，每批显示 12 项；IntersectionObserver 触发后续卡片，图片使用原生 `loading="lazy"`。封面照片的宽高决定卡片宽窄，旧照片缺少尺寸时由图片加载后的自然尺寸补充布局。旧 `/search/` 保留条件并跳转到对应目录。

投稿表单与 Worker 共用字段限制和结构验证：店铺 / 餐品名称 120 字、地址 300 字、餐品描述 1000 字、店铺介绍 2000 字，价格为整数分且必须注明来源；距离与依据成对填写，校内不记录校外距离。必填项与条件必填项标红星，浏览器列出问题并聚焦首个字段，成功提示明确表示等待审核。图片在浏览器通过 createImageBitmap → Canvas → WebP 重编码（最长边 2000px，逐级降低质量到 2MiB 内），Worker 再校验 WebP 文件、尺寸、来源、授权、槽位和版本。

审核入口是 `/admin/`，投稿进度页也提供链接。本站没有默认管理员密码；Cloudflare Access 仅允许配置的审核员邮箱，通过邮件验证码登录，Worker 再验证 Access JWT 与邮箱。快捷入口不会授予额外权限。

仓库保存 `src/content/restaurants/`、`foods/`、`reviews/` 下的 JSON；没有提交独立 SQLite 数据库文件。流程为私有 D1 投稿与 R2 图片 → 审核 → GitHub 内容 PR → dev 预览 → main 构建生成种子 SQL 并同步 D1 → 签名部署回调确认公开。`dates.addedAt` 是首次创建内容 PR 时的建档日期，未知旧记录为 null；现有酸菜鱼与档口按各自首次 Git 入库提交补齐 2026-10-01。它不表示用餐或现场核验日期。

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


### 首页、目录与内容管理

- `/`：随机餐品、好评餐品、最近收录餐品、好评店铺、最近收录店铺；不再展示全量食单。
- `/foods/` 和 `/restaurants/` 分别提供本类型的关键词、范围、预算、标签、有图与评分筛选。默认按评分、评分人数排序，无评分排最后；首页好评推荐采用五条中性评分先验，公开显示的实际均分不变。旧 `/search/` 带条件跳转到对应目录。
- 新餐品至少声明并完成上传一张非示意照片。旧无图资料和既有待审稿件保持兼容；店铺图片、评价图片仍选填。上传者授权本站选作封面的新照片保留 `coverEligible` 声明，历史照片不补造授权。
- `/admin/` 继续由 Cloudflare Access 保护，没有默认密码。工作区包括待审核、内容管理、图片管理、发布记录；管理员仍为既有单邮箱名单。所有管理 API 位于已受 Access 保护的 `/api/v2/admin` 下。
- 已有内容编辑通过 `catalog_mirror` 读取公开源版本，新增 `entity_type=management` 的私有修改任务、原因与审计记录。D1 唯一约束阻止同一实体同时存在多个待发布修改；导出时再核对 GitHub `dev` 的内容哈希。修改仍生成内容 PR，沿 `dev → main` 发布并经签名部署回调标记完成。
- `status: archived` 表示可恢复下架；实体 JSON 保留。公开目录、详情页和评价按关联过滤；D1 的归一化状态在部署时同步。还有上架餐品或子档口的店铺不能直接下架，先迁移或下架关联内容。
- `cover: { url, reviewId, x, y }` 独立引用本实体原图或同一实体已审核、明确允许封面的评价实拍图。来源图片被隐藏、评价下架或授权撤回时，构建自动回退到实体可用照片；`hidden` 不删除原图与来源记录。隐藏用于本站展示控制，不等同于清除已传播的图片副本。
- 管理界面可选择封面焦点、隐藏或恢复照片、编辑资料和迁移餐品所属店铺。新增餐品或店铺通过投稿入口进入审核；评价保留原作者文字和评分，管理员可下架或管理其照片。
- 发布失败可重试；失败且无开放 PR、或 PR 已关闭的管理任务可取消后重新编辑。版本冲突应取消旧修改、刷新再编辑，不覆盖其他人的版本。
