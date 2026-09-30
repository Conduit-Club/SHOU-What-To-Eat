# 今日海大吃什么

上海海洋大学校内和周边餐饮目录，记录店铺位置、餐品、价格、来源及不同同学的实际体验。

## 开发

项目使用 Astro、React 与 TypeScript，Node.js 和 pnpm 由 Pixi 管理。安装 Pixi 后运行：

```bash
pixi install --locked
pixi run --locked dev
```

内容位于 `src/content/restaurants/`，一条餐厅记录对应一个 JSON 文件，schema 位于 `src/content/config.ts`。内容来源、许可状态、核验时间与用餐时间单独记录。不得将整理日期当成用餐或核验日期。

## 架构

- Astro 静态 HTML 与 React 筛选卡片构成手机优先的网站。
- Pages Static Assets 提供公共静态资源；Worker 只负责匿名投稿、审核 API 和 GitHub 发布队列。
- D1 使用 SQLite 语法，私有保存待审原稿、编辑稿、审核审计和 PR 状态。公共浏览不查询 D1。
- Turnstile 限制自动投稿；Cloudflare Access 邮箱策略保护 `/admin/*`，Worker 验证 JWT 签名、受众、签发者和有效期。
- 批准稿通过 GitHub App 创建到 `dev` 的内容 PR。PR 合并到 `dev` 后进入 Preview；发布 PR 合并到 `main` 并部署成功后才标记已发布。
- 默认图片模式为 `external`，接受经过人工核验的 HTTPS 外链，不抓取或代理任意图床。R2 图片适配尚未实现；默认配置不绑定 R2，也不产生 R2 调用。切换到 `r2` 前需完成适配与权限测试。

投稿状态查询使用只向投稿者显示一次的回执令牌。D1 只保存其 SHA-256 哈希。投稿、原稿和审核员私有笔记不得写入公开内容或日志。

## 配置与部署

复制 `.dev.vars.example` 到 `.dev.vars` 仅用于本地 Worker，不能提交真实值。GitHub Actions / Wrangler Secrets 设置在部署说明中列出。配置 D1 数据库 ID、Access、Turnstile 和 GitHub App 后，先部署 Preview，再按维护者流程发布到 `main`。不要设置付费自动升级。

免费额度是账号共享的使用上限，不代表超限后服务一定正常。请求超限时投稿接口会拒绝或暂停，静态餐厅目录仍可访问。部署前须检查 Cloudflare 账号已有用量和当期官方额度。

```bash
pixi run --locked typecheck
pixi run --locked test
pixi run --locked build
```

`test` 覆盖迁移条目、数据完整性、图片地址和稿件校验；完整 Worker 与 GitHub 云端联调还需配置 Cloudflare、Turnstile、Access 和 GitHub App 测试凭据。

## 来源与许可

来源许可按条目标注：旧美食站内容遵循其 `CC BY-NC-SA 4.0` 来源声明；SHOU-Online-Manual 内容遵循其 `CC BY-SA 4.0` 来源声明。混合来源条目必须保留每个来源的作者、链接、署名与许可边界。未获许可的原图片不迁移。新提交由投稿人保留权利；发布前由审核员按贡献者实际授权确认可发布范围。
