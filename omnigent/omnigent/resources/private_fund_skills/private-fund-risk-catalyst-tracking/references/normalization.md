# 归一化与去重

为每个事件提取稳定字段：`entity`、`event_type`、`subject`、`expected_start/expected_end`。

`canonical_key` 使用小写英文事件类别和规范化主体，例如：

- `sungrow/product_launch/sst/2026-09`
- `sungrow/margin_pressure/energy_storage`
- `sungrow/order_award/uae_7.5gwh`

中文、英文、简称和完整公司名称指向同一实体。相同事件的不同表述应共享 canonical key；金额、概率、状态或日期变化应形成同一研究项的新版本，不应创建新项目。

不要把同一句中并列的不同事件强行合并。不要用整句原文或随机摘要作为 canonical key。
