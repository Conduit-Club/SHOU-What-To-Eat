# 依赖安全检查（2026-10-04）

本轮将 Astro 5.18.2 更新到 7.2.8、React 集成更新到 6.0.6，并迁移到显式 glob 内容加载器。仅调整构建与校验配置；仓库 JSON 仍是开发样本，普通部署不将样本导入生产 D1。

升级后 `pnpm audit --prod` 从 14 项降到 1 项，已消除 Astro、Sharp 与 esbuild 的已知版本告警。Astro 的 AVIF 公告要求能够处理攻击者提供的图片才可利用；本站生产使用独立 Worker 校验 WebP、R2 存储，不运行 Astro 图片优化服务，不能把包版本告警描述为已证实的线上远程代码执行。

仍有 `http-cache-semantics@4.2.0` 的 GHSA-ch52-4w7c-c8xp，上游尚未发布修复版本。本次不使用审计忽略项掩盖它。依赖来自 Astro 构建时的远程图片缓存；当前组件使用原生图片标签，没有 `astro:assets` 图片优化调用。Wrangler dry-run 的 Worker bundle 不包含该缓存库、Astro 远程图片缓存模块或 Sharp，线上会话响应明确禁止共享缓存。未来启用服务端 Astro、远程图片优化或共享认证响应缓存前，必须重新评估并修复这一依赖边界。

验证包括本地 typecheck、静态构建、独立本地 D1/Worker 的真实浏览器目录搜索与动态详情：React 正常运行，搜索结果和匿名评价表单正常，无控制台错误。完整业务测试由本轮安全修复检查一起执行。所有开发样本写入均只在 `.wrangler/security-ui-state` 本地数据库；没有生产测试投稿或上传。

参考：[Astro AVIF 公告](https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2)、[缓存库公告](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)、[Astro 6 迁移](https://docs.astro.build/en/guides/upgrade-to/v6/)、[Astro 7 迁移](https://docs.astro.build/en/guides/upgrade-to/v7/)。
