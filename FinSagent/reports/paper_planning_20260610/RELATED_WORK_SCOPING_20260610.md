# Related Work Scoping

Date: 2026-06-10

This is a pre-writing related-work map. It is not the final related-work section.

## Related Work Buckets

### Bucket A: Financial Document QA Benchmarks

Use these to position the task difficulty and benchmark scale.

| Work | What It Is | Relevance | How We Differ |
|---|---|---|---|
| FinanceBench | Open-book financial QA over public-company filings, 10,231 questions with answers/evidence strings | Shows SEC/financial QA is a serious benchmark area and that evidence-backed QA matters | Our current set is smaller and internal; our contribution is SkillOps workflow and promotion governance, not a new large benchmark |
| FinQA | Numerical reasoning over financial reports with structured/unstructured evidence | Supports motivation that finance QA needs table/text numerical reasoning | FinQA focuses on reasoning dataset/modeling; we focus on long-document SEC RAG and skill evolution |
| TAT-QA | Hybrid tabular/textual finance QA requiring numerical operations | Supports table alignment and hybrid evidence challenge | Our focus is operational QA over filings with retrieval, evidence preview, and skill governance |
| SECQUE | SEC filing analysis benchmark with expert questions and LLM judge evaluation | Relevant because it targets real-world financial analysis over SEC filings | Our contribution is not benchmark construction; it is an auditable SkillOps layer |

Key citations / links:

- FinanceBench: https://arxiv.org/abs/2311.11944
- FinanceBench repo/sample: https://github.com/patronus-ai/financebench
- FinQA: https://finqasite.github.io/
- FinQA paper: https://aclanthology.org/2021.emnlp-main.300/
- TAT-QA: https://arxiv.org/abs/2105.07624
- TAT-QA project: https://nextplusplus.github.io/TAT-QA/
- SECQUE: https://aclanthology.org/2025.gem-1.16/

## Bucket B: Financial / Regulatory RAG Systems

Use these to position PageIndex Hybrid and multi-aspect SEC RAG as the substrate.

| Work | What It Is | Relevance | How We Differ |
|---|---|---|---|
| FinSage / multi-aspect RAG for financial filings | Multi-aspect RAG framework for regulatory/financial filing QA | Strong nearby work: retrieval over heterogeneous filing content | Our novelty is failure-to-skill lifecycle and promotion governance, not only multi-aspect retrieval |
| FinanceBench system papers/blogs | Purpose-built retrieval performs better than generic vector RAG on SEC filings | Supports motivation that finance-specific retrieval matters | We add SkillOps on top of retrieval |
| GraphRAG | Graph-based retrieval and summarization over private data | Shows structured retrieval improves complex corpus reasoning | Our PageIndex/grep side channels are document-structure/evidence oriented, not graph community summarization |

Key citations / links:

- Multi-aspect RAG for filings: https://arxiv.org/html/2504.14493v3
- GraphRAG project: https://www.microsoft.com/en-us/research/project/graphrag/
- GraphRAG paper: https://arxiv.org/abs/2404.16130

## Bucket C: RAG Reliability, Faithfulness, and Hallucination Mitigation

Use these to argue why answer correctness requires evidence checks and failure diagnosis.

| Work | What It Is | Relevance | How We Differ |
|---|---|---|---|
| RAG hallucination mitigation surveys | Categorize hallucination causes in retrieval and generation | Supports our failure taxonomy and need for detection/correction | We instantiate a domain-specific SEC QA workflow with skill promotion |
| Faithfulness / hallucination benchmarks | Evaluate whether generated answers are grounded in retrieved context | Supports need for evidence-grounded answers | We focus on exact evidence probes, fiscal periods, and table/accounting scope |
| Corrective RAG / self-correcting RAG | Uses feedback or corrective retrieval to improve answers | Related to our failure diagnosis loop | Our loop produces persistent skill candidates and gated promotion, not only per-query correction |

Key citations / links:

- RAG hallucination review: https://www.mdpi.com/2227-7390/13/5/856
- Trustworthiness in RAG: https://arxiv.org/html/2409.10102v1
- Corrective RAG: https://openreview.net/pdf?id=JnWJbrnaUE

## Bucket D: Self-Evolving Agents and Skill Libraries

Use these to position SkillOps against fully automatic or skill-centric agent evolution.

| Work | What It Is | Relevance | How We Differ |
|---|---|---|---|
| MUSE-Autoskill | Skill-centric self-evolving agent lifecycle: creation, memory, management, evaluation, refinement | Very relevant; provides language for skills as long-lived assets | MUSE emphasizes autonomous lifecycle and skill memory; we emphasize evidence-grounded, human-governed promotion for high-stakes SEC QA |
| SAGE / RL with skill library | Uses RL to improve agents with a skill library | Shows skill libraries can support self-improvement | Our system is training-free and governance-first |
| Memento-Skills / self-evolving skills | Autonomous skill/memory evolution for agents | Related in self-improving skill systems | Our contribution is narrower but safer: auditable skills, protected suites, and promotion gates |
| Self-evolving agent surveys | Taxonomies of model-centric and environment-driven co-evolution | Helps position our system as environment/workflow-driven evolution | Our work is a domain-specific instantiation with evidence and governance |

Key citations / links:

- MUSE-Autoskill: https://arxiv.org/abs/2605.27366
- MUSE-Autoskill HTML: https://arxiv.org/html/2605.27366v1
- SAGE / RL skill library: https://arxiv.org/html/2512.17102v1
- Self-evolving agents survey list: https://github.com/XMUDeepLIT/Awesome-Self-Evolving-Agents
- Memento-Skills discussion: https://venturebeat.com/orchestration/new-framework-lets-ai-agents-rewrite-their-own-skills-without-retraining-the

## Bucket E: Evaluation and Governance for Agentic Systems

Use these to justify why human-governed promotion is not a weakness.

| Theme | Relevance |
|---|---|
| Unit-test-driven skills | Automatic evaluation can prevent many bad skills, but tests must be admitted and maintained |
| Human-in-the-loop governance | High-stakes domains need accountability for promotion decisions |
| Regression gates | Protect against local fixes that break previous behavior |
| Failure banks | Convert confirmed failures into durable regression assets |

This bucket may use broader software-engineering analogies if literature is thin:

- CI/CD gate
- regression tests
- staged rollout
- human code review

## How Related Work Changes Our Experiment Setting

### Change 1: Include fair auto baselines as a required experiment.

Because MUSE-Autoskill and similar work emphasize automatic skill lifecycle/evaluation, our paper must not compare only against naive auto-promotion. We now include:

- naive auto
- self-review proxy
- static guarded auto
- governed SkillOps

### Change 2: Add "static guarded" as a serious baseline, not a strawman.

Static guarded reaches 0 false triggers on the current controlled suite. This is important. It means our claim should shift:

Bad claim:

> Human governance is required because automatic gating cannot work.

Better claim:

> Automatic gates can block known-suite failures, but human-governed SkillOps is needed to decide what enters the suite, how new failure types are represented, and when a candidate is accountable enough for production promotion.

### Change 3: Keep financial QA benchmark claims conservative.

FinanceBench and SECQUE are much larger. Our paper should say:

- protected cross-company validation set
- internal stage proof
- workflow/evidence protocol

It should not say:

- new state-of-the-art financial QA benchmark
- broad SEC QA generalization result

### Change 4: Make evidence preview / grep probe a reliability mechanism.

Related RAG faithfulness work supports the need for grounding. Our grep probe contribution is not "grep beats embeddings"; it is:

- exact evidence side channel
- period and number anchor detection
- failure diagnosis support
- lightweight evidence preview for human review

## Draft Related Work Section Outline

### 1. Financial Document QA

Mention FinanceBench, FinQA, TAT-QA, SECQUE. Emphasize that finance QA requires evidence, tables, numerical reasoning, and real filings.

### 2. Retrieval-Augmented Generation for Complex Documents

Mention financial/regulatory RAG, GraphRAG/structured retrieval, and RAG reliability. Position PageIndex Hybrid as part of this family.

### 3. Self-Evolving Agents and Skill Libraries

Discuss MUSE-Autoskill and skill-library work. Position SkillOps as domain-specific, evidence-grounded, and governed rather than fully autonomous.

### 4. Evaluation and Governance

Discuss regression gates, unit tests, failure banks, and human review. This can be shorter, but it is central to the paper's stance.

## Related Work Search Notes

Searches performed on 2026-06-10:

- `MUSE-Autoskill Self-Evolving Agents via Skill Creation Memory Management and Evaluation`
- `self-evolving agents skill creation memory management evaluation automatic skills agent paper`
- `financial document question answering benchmark SEC filings RAG FinanceBench`
- `FinQA TAT-QA financial question answering dataset table text numerical reasoning`
- `RAG hallucination faithfulness evidence evaluation survey`

## Next Literature Tasks

Before final paper writing:

1. Download BibTeX for FinanceBench, FinQA, TAT-QA, SECQUE, MUSE-Autoskill, and one RAG hallucination survey.
2. Verify whether Memento-Skills has an arXiv paper and cite the paper rather than media coverage if available.
3. Add 2-3 lines comparing exact evidence probe with existing RAG faithfulness/evaluation methods.
4. Decide whether to cite GraphRAG directly or leave it as background only.
