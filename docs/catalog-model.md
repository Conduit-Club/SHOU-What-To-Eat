# Catalog model

公开目录由三个 Astro data collections 组成：`restaurants`（实体为 Venue）、`foods`（餐品）和 `reviews`（评价）。三者都使用 schema version `2`，共享 schema、类型、关系校验和快照/seed 生成器：

```ts
import {
  deriveDistanceTags,
  generateCatalogSnapshot,
  generateSeedSql,
  loadCatalog,
  type Catalog,
  type Food,
  type Review,
  type Venue,
} from '../src/lib/catalog/index';
```

`loadCatalog({ restaurants, foods, reviews })` 会补齐可空默认值并校验 ID、外键、档口父子关系、食物归属、价格、日期、评价长度和图片来源。`generateCatalogSnapshot` 生成按 ID 排序的公开快照，并把距离标签重新从明确的距离事实派生；异步的 `generateSeedSql` 生成写入 `catalog_snapshots`/`catalog_mirror` 的供 Worker/D1 镜像使用的 SQL。脚本 `node scripts/prepare-catalog.mjs` 读取三个目录并写入 `.generated/catalog.json` 与 `.generated/seed.sql`，这两个文件属于生成物，不应提交。

## Venue

Venue 保留在 `restaurants` 目录中，字段如下：

- `schemaVersion`: 固定为 `2`。
- `id`: 小写、连字符分隔的稳定 slug；`name` 是公开名称。
- `kind`: `cafeteria`、`stall`、`restaurant`、`cafe` 或 `convenience`。
- `parentId`: 父食堂或容器实体的 ID，可为 `null`。
- `category`: `on-campus` 或 `off-campus`。
- `aliases` 与 `tags`: 公开检索词；标签去重。
- `location`: `address`（最多 300 字符）、可空的 `campusArea`、`floor`、`landmark`、按 `[latitude, longitude]` 存储的 `coordinates`、可空的 `distanceMeters` 与 `distanceBasis`。距离依据只能是 `reported`、`walking` 或 `straight-line`，两者必须同时存在或同时为空。
- `averagePrice`: 可空的人均价格区间 `{ minCents, maxCents, currency: 'CNY', unit: '人', source, verifiedAt }`。
- `description`、`openingHours`、`images`、`sources` 和 `dates`。
- `foods`: 该 Venue 直接拥有的 Food ID 列表。Food 的 `venueId` 必须反向指向同一个 Venue。

没有明确地址、店名或可定位关系的旧条目不进入公开目录。未知信息使用 `null` 或待补充文字，不能用猜测的距离、星级或日期填充。

## Food

Food 位于 `foods` 目录中，通过 `venueId` 绑定到一个 Venue。`mealTypes` 只能使用 `breakfast`、`meal`、`snack`、`dessert`、`drink`。`price` 可为空；有价格时货币固定为 CNY，金额使用分，`unit`、`source` 和 `verifiedAt` 必须保留。

为保留旧资料中的“约 1 至 1.5 元”而不伪造单价，Food price 允许在 `amountCents` 以外使用成对的 `minCents`/`maxCents`；两者不能与 `amountCents` 同时出现，且最高价不得低于最低价。没有可靠数值时使用 `price: null`，把来源中的限定说明放入 `description` 或 `sources[].note`。

## Review

Review 位于 `reviews` 目录，`targetType` 为 `venue` 或 `food`，`targetId` 必须引用实际实体。`rating` 是 `1..5` 的整数或 `null`；历史资料没有星级时保持 `null`，不从文字推荐推算。`text` 按 Unicode code point 限制为最多 256 个，保留原文和原意，不在迁移时擅自截断。`authorAlias`、访问/核验/更新时间、图片和来源均可为空或为空数组。

## Images and provenance

Image 的 `url` 和可选 `sourceUrl` 必须是 HTTPS；`alt`、作者、许可、可选的 `sourceNote`（最多 500 字符）和 `permission`（`approved` 或 `pending`）随图保存。外部作品的 `sourceUrl` 必须保留原始 HTTPS 来源页；用户本人尚未公开发布的原创照片可以在本站批准后使用本站公开原稿资产 URL，但 `sourceNote` 必须明确本人拍摄/使用权声明及 WebP 转码，`author` 与 `license` 仍须保留。上传不要求投稿人拥有个人网站。`generateCatalogSnapshot` 只输出 `approved` 图片，因此待授权图片不会进入公共快照。未知许可的图片不应迁移；没有可复用授权的外链只保留文字来源说明。

## Distance tags

`deriveDistanceTags` 只对 `off-campus` Venue 使用明确的 `distanceMeters` 和 `distanceBasis` 派生累计标签：不超过 500 米得到 `within-500m`，不超过 1 km 得到 `within-1km`，不超过 2 km 得到 `within-2km`。未知距离不匹配任何距离标签；校内 Venue 不从校园坐标推导校外距离。

## Submission boundary

投稿请求是 Worker 的可变草稿协议，不应直接当作静态目录 JSON 写入：外层包含 `schemaVersion`、`entityType`、`snapshotId`、`payload`、可选 `parent` 回执、`expectedImages`、`expectedReviewImages`、Turnstile token 和可选 `attachedReview`。服务端负责把它写入待审状态，清除 token、回执和私有字段后才产生公开 payload；审核发布再映射为本目录实体。

当前 API 载荷与静态字段的适配关系是：Venue 的 `type/campusScope/address` 对应 `kind/category/location.address`；Food 的单值 `mealType` 对应目录的 `mealTypes[]`；API 价格使用 Worker 约定的 major-unit `amount`，目录价格使用 cents 的 `amountCents`/范围字段；API 数组坐标按 Worker 旧协议解释为 `[longitude, latitude]`，目录文件固定为 `[latitude, longitude]`。Review 的 `rating` 在目录可以为 `null`，以保留没有星级的历史文字；投稿校验若要求必填星级，发布适配必须显式处理该差异，不能把缺失星级伪造为 1 分。
