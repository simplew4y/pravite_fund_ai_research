# PageIndex Hybrid 阶段性目标与协作计划

日期：2026-06-03

## 你的阶段性目标

当前阶段的目标不是把 Zeekr 某一套题库继续刷满，而是证明一个更重要的工程判断：

在不微调模型的前提下，PageIndex Hybrid + 可审计 skills 可以把 SEC RAG 从“纯检索后交给 LLM 生成”升级成“检索、结构化校验、风险分桶、guarded promotion”的工业化系统。

这个阶段要证明三件事：

1. 目标公司链路已基本打通
   - protected small30 已经作为目标公司 sanity set 通过。
   - 说明系统在已知目标公司基础题上不是随机可用，而是已经进入可控状态。

2. 系统不是单次手工调参
   - 已有 skill registry、candidate cards、dry-run/auto-guarded manifest、validation gates。
   - 工作流已经从“人工看错题后改代码”转成“失败分桶 -> 候选 skill -> deterministic/judge evidence -> guarded approve”。

3. 下一步要补横向证据
   - rotating20 已暴露新风险，并推动 component mix table skill。
   - 但还需要同事独立做泛化和瘦身审计，证明这些 skills 不是 Zeekr answer patch，也不是过度堆规则。

## 已完成能力概览

当前已经形成 10 个 registry skills/capabilities：

- PageIndex Hybrid Retrieval
- Parameter Slimming / Cap2 Runtime Control
- Period-Aware Cutoff and Backfill
- Answer Coverage Repair
- Deterministic Table Verification and Repair
- Source Conflict / Discrepancy Reporting
- Component Mix Table Verification and Repair
- Learning-Based Rescue Scorer
- Company Fact Registry
- Skill Evolution MVP

其中最近新增的 `component_mix_table_v1` 修复了 annual cost-of-revenues mix 和 R&D expense mix 两类结构化表格问题：

- q134/q135 targeted judge: 2/2 CORRECT
- rotating20: 6C/7P/7I -> 8C/7P/5I
- protected/cross-company gates: PASS

## 为什么需要同事参与

你的主线是“纵向打通和迭代系统”。同事应该做“横向审计和抽象化”，避免系统看起来像：

- 只针对 Zeekr；
- 只针对已有答案打补丁；
- 规则太多、太死、太像人工校验；
- skills 之间会互相打架；
- 维护成本越来越高。

同事参与不是接管主线，而是从旁边做独立挑战：

- 这些 skills 是否能迁移到另一家公司？
- 哪些 skill 是 SEC 通用结构，哪些像公司定制？
- 哪些规则可以合并、参数化、瘦身？
- 哪些 strict gate 过度保守，会伤害泛化？

## 推荐分工

### 同事 A：泛化 / 反过拟合审计

目标：

- 用 NVIDIA 或另一家公司做横向检查。
- 判断现有 skills 是否误触发、是否有跨公司收益、是否 Zeekr-only。
- 输出 `GENERALIZATION_AUDIT.md`。

不要求：

- 不要求继续优化 Zeekr 分数。
- 不要求直接改主链路。
- 不要求证明所有新公司题都答对。

### 同事 B：瘦身 / 抽象化审计

目标：

- 看 skills 是否过细、过硬、过多 if-else。
- 把规则归并成更少的抽象能力模块。
- 输出 `SKILL_SLIMMING_AUDIT.md`。

不要求：

- 不要求删掉已经有证据的 safety gate。
- 不要求为了好看牺牲 correctness。
- 不要求直接合并代码。

## 协作边界

同事不直接改你的主线目录和 production config。建议每个人新建自己的审计目录：

- `/root/autodl-tmp/dir_myz/review_generalization_<name>/`
- `/root/autodl-tmp/dir_myz/review_slimming_<name>/`

输入材料从当前主目录复制或只读引用：

- `test/colm/retrieval/skill_registry_manifest_20260603.json`
- `test/colm/retrieval/skill_registry_manifest_auto_guarded_component_mix_20260603.json`
- `test/colm/retrieval/SKILL_CANDIDATE_CARDS_WITH_COMPONENT_MIX_20260603.md`
- `test/colm/retrieval/ROTATING20_SKILL_EVOLUTION_REPORT_20260603.md`
- `test/colm/retrieval/COMPONENT_MIX_TABLE_SKILL_V1_20260603.md`
- `test/colm/retrieval/SKILL_REGISTRY_AUTO_GUARDED_COMPONENT_MIX_VALIDATION_20260603.md`

## 主线继续推进什么

你的主线下一步继续做：

1. period answer coverage repair
   - 针对“核心数值答对但漏 USD / YoY / driver context”的 partial。

2. rotating diagnostics
   - 每次只选 1-2 个结构化 failure bucket。
   - 不在同一 bucket 无限局部优化。

3. blind holdout 暂不碰
   - 等候选 skill 通过 rotating + protected + cross-company gate 后再用。

## 对外表达

可以这样说：

当前我负责纵向主线，目标是把 PageIndex Hybrid 的 SEC RAG 链路和 skill evolution 闭环跑通；同事会并行做横向泛化和瘦身审计，专门验证系统是否过拟合 Zeekr、是否过度依赖人工规则、以及哪些 skills 可以抽象成更通用的 SEC 结构化能力。这样系统从“能答对”推进到“可迁移、可维护、可审计”。
