# 可转发给同事的话术

下面这段可以直接发给同事：

```text
我现在 PageIndex Hybrid + skills 的主线已经跑到一个阶段：目标公司 protected small30 已通过，rotating20 暴露了新 failure buckets，并且已经有 skill registry / candidate cards / guarded promotion 的闭环。

但我现在不想只继续刷 Zeekr 分数，因为这样容易变成单公司定制或者看答案补规则。所以想让你帮我从横向角度审计一下，不需要接手我的主线，也不要直接改 production config。

我希望你做其中一个方向：

方向 A：泛化 / 反过拟合审计
- 看现有 skills 是否能迁移到 NVIDIA 或另一家公司；
- 哪些是 SEC 通用结构，哪些像 Zeekr-only；
- 哪些规则可能误触发或过严；
- 输出 GENERALIZATION_AUDIT.md。

方向 B：skill 瘦身 / 抽象化审计
- 看现有 skills 是否太细、太多 if-else、太像人工校验；
- 哪些可以合并成更通用的 table schema / period policy / source conflict reporter；
- 哪些必须保留 hard gate，哪些应该降级 review-only；
- 输出 SKILL_SLIMMING_AUDIT.md。

你可以只读参考这些材料：
- skill registry manifest
- candidate cards
- rotating20 report
- component mix skill report
- auto-guarded validation report

目标不是证明现在已经完美，而是帮我回答一个更关键的问题：这个系统是不是有可迁移的 SEC RAG 工业价值，而不是单公司 benchmark patch。
```

## 给老板/组会的说法

```text
我现在继续做纵向主线：从 failure bucket 里提可审计 skills，并用 protected / rotating / cross-company gate 做 guarded promotion。

同时会让同事做两个横向审计：一是泛化审计，验证 skills 是否能跨公司迁移；二是瘦身审计，把已经验证有效的规则抽象成更少、更通用的模块。这样可以避免系统陷入单一公司过拟合，也能证明它不是简单看答案补规则，而是 SEC RAG 的结构化能力积累。
```
