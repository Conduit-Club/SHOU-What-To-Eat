# Content migration

本次迁移把旧的嵌套餐厅 JSON 拆为 Venue、Food 和 Review 三个集合。旧文件仍可通过 Git 历史追溯；公开目录只保留能够清楚定位的实体，不为模糊条目补造店名、地址、距离、价格、星级或用餐日期。

## Retained venues

| 旧 ID | 新实体 | 处理 |
| --- | --- | --- |
| `first-canteen` | `first-canteen` | 保留一食堂，坐标改为合同要求的 `[latitude, longitude]`；酸菜鱼只保留在 Venue 描述和原评价中，不预建酸菜鱼 Food。 |
| `second-canteen` | `second-canteen` | 保留二食堂并拆出明确的窗口品类。 |
| `third-canteen` | `third-canteen` | 保留三食堂并拆出手册明确列出的早餐、面食和窗口品类。 |
| `flavor-restaurant` | `flavor-restaurant` | 保留为二食堂的 `stall` 子实体。 |
| `mixue-second-canteen` | `mixue-second-canteen` | 保留为二食堂的一楼 `cafe` 子实体，具体饮品菜单仍待补充。 |
| `area-a-711` | `area-a-711` | 保留 A 区 7-11；楼栋、商品和熟食未明确，暂不生成 Food。 |
| `area-b-711` | `area-b-711` | 保留 B 区 7-11；仅记录其与三食堂同栋，未把它错误归为三食堂子档口。 |

旧坐标文件使用 `[longitude, latitude]`，迁移到 Location 时统一改为 `[latitude, longitude]`：一食堂 `[30.8826037, 121.8934382]`、二食堂 `[30.8826095, 121.8912025]`、三食堂 `[30.8893715, 121.8918594]`。没有明确坐标的实体保持 `null`。

## Removed public entries

这些旧文件只有模糊地址、店名、经营关系或未用餐记录，无法安全绑定到一个公开 Venue，因此从新集合移除；旧文件内容仍在 Git 历史中可查。

| 旧 ID | 移除原因 |
| --- | --- |
| `big-pizza` | 只有“万达附近”和历史活动价，没有明确门店位置。 |
| `burger-king` | 具体门店和当前经营状态不明，只有历史优惠与经销商讨论。 |
| `changfen` | 仅有“学校里面”的评价，无法确认食堂或档口；明确的二食堂肠粉已由 `second-changfen` 承载。 |
| `dessert-bbq-pork-rice` | 店名和门店均不明，评价只说“今年刚开业”。 |
| `jiangxi-stir-fry` | 只有“六院对面一家”，缺店名、门牌和可核位置。 |
| `jinniu` | 店址、菜品和营业信息均缺失。 |
| `jiuguozi` | 只有“新天地那边”，缺具体门店地址。 |
| `nanchang-pot-soup` | 具体门店不明，无法把体验绑定到一个实体。 |
| `pizza-hut-burger` | 具体门店不明，旧记录只有个人性价比评价。 |
| `shantou-beef-noodles` | 只有“学校旁边”，缺店名和地址。 |
| `taima` | 具体门店不明，旧评价还与另一家店共用归属。 |
| `taorui` | 只有酒店名称，且原文明确表示未吃过，不构成可用体验或菜品记录。 |

## Reviews and future submissions

能够明确归属一、二、三食堂或风味餐厅的旧文字评价已按原文迁入 Review，星级保持 `null`，访问和核验日期保持 `null`。一食堂旧的“铁板烧真的好好吃”评价因原注释明确表示无法确认具体食堂，未迁入一食堂 Review，并在此表中保留移除理由。旧的独立“肠粉”文字评价同理未直接绑定档口，但二食堂资料明确列出的肠粉仍保留为 Food。

未来通过投稿新建的“一餐二楼酸菜鱼档口”及其“酸菜鱼 19 元/份”不在此次迁移中预置，避免与实测投稿重复。原来明确提及酸菜鱼的 Venue 描述和 Review 保持原文，并不把这段文字伪装成已核实的档口实体。
