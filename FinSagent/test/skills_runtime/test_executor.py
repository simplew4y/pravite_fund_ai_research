import asyncio
from pathlib import Path

import pytest

from skills_runtime.executor import SkillExecutor
from skills_runtime.loader import SkillLoader
from skills_runtime.models import SkillContext
from skills_runtime.registry import RuntimeSkillRegistry
from skills_runtime.router import SkillRouter
from skills_runtime.integration import apply_retrieval_skills


def _write_prompt_skill(root: Path) -> None:
    skill_dir = root / "finance" / "research-thesis"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: research-thesis
description: Research thesis procedure.
version: 1.0.0
category: finance
---

# Research Thesis

Use source-grounded bull, base, and bear cases.
""",
        encoding="utf-8",
    )
    (skill_dir / "manifest.yaml").write_text(
        """schema_version: 1
skill_id: research_thesis
version: 1.0.0
name: Research Thesis
description: Research thesis procedure.
category: finance
type: prompt
phase: pre_answer
priority: 100
status: promoted
owner: test
agents: [market_researcher]
routing:
  keywords: [投资逻辑]
evidence_contract:
  company_scope_required: false
  source_evidence_required: false
implementation:
  kind: prompt
permissions: {}
""",
        encoding="utf-8",
    )


def _write_formula_skill(root: Path) -> None:
    skill_dir = root / "finance" / "revenue-growth"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: revenue-growth
description: Calculate revenue growth from two evidence-backed facts.
version: 1.0.0
category: finance
---

# Revenue Growth
""",
        encoding="utf-8",
    )
    (skill_dir / "manifest.yaml").write_text(
        """schema_version: 1
skill_id: revenue_growth
version: 1.0.0
name: Revenue Growth
description: Calculate revenue growth.
category: finance
type: formula
phase: calculation
priority: 100
status: promoted
owner: test
agents: [quant]
routing:
  keywords: [收入增长]
evidence_contract:
  company_scope_required: true
  unit_required: true
  source_evidence_required: true
  allow_cross_company: false
implementation:
  expression: (current - prior) / abs(prior)
  output_metric: revenue_growth
  output_unit: percent
  operands:
    current: revenue_current
    prior: revenue_prior
permissions: {}
""",
        encoding="utf-8",
    )


def _write_python_skill(root: Path) -> None:
    skill_dir = root / "finance" / "unsafe-python"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: unsafe-python
description: Test Python execution policy.
version: 1.0.0
category: finance
---

# Unsafe Python
""",
        encoding="utf-8",
    )
    (skill_dir / "manifest.yaml").write_text(
        """schema_version: 1
skill_id: unsafe_python
version: 1.0.0
name: Unsafe Python
description: Test Python execution policy.
category: finance
type: python
phase: query_parse
priority: 100
status: promoted
owner: test
agents: []
routing: {}
evidence_contract:
  company_scope_required: false
  source_evidence_required: false
implementation:
  module: handler.py
  class: Skill
permissions: {}
""",
        encoding="utf-8",
    )
    (skill_dir / "handler.py").write_text(
        "class Skill:\n    def execute(self, context):\n        return {'status': 'applied'}\n",
        encoding="utf-8",
    )


def test_shadow_mode_records_but_does_not_apply_prompt(tmp_path: Path) -> None:
    _write_prompt_skill(tmp_path)
    registry = RuntimeSkillRegistry(SkillLoader([tmp_path]).discover())
    executor = SkillExecutor(SkillRouter(registry), mode="shadow")
    context = SkillContext(question="这份研报的投资逻辑是什么？", agent="market_researcher")

    execution = asyncio.run(executor.execute_phase("pre_answer", context))

    assert execution.selected_skill_ids == ["research_thesis"]
    assert execution.results[0].status == "applied"
    assert context.prompt_instructions == []


def test_active_mode_applies_prompt_instruction(tmp_path: Path) -> None:
    _write_prompt_skill(tmp_path)
    registry = RuntimeSkillRegistry(SkillLoader([tmp_path]).discover())
    executor = SkillExecutor(SkillRouter(registry), mode="active")
    context = SkillContext(question="这份研报的投资逻辑是什么？", agent="market_researcher")

    asyncio.run(executor.execute_phase("pre_answer", context))

    assert context.prompt_instructions[0]["skill_id"] == "research_thesis"


def test_prompt_instruction_is_bounded_before_trace_or_context(tmp_path: Path) -> None:
    _write_prompt_skill(tmp_path)
    skill_path = tmp_path / "finance" / "research-thesis" / "SKILL.md"
    skill_path.write_text(skill_path.read_text(encoding="utf-8") + ("evidence workflow\n" * 500), encoding="utf-8")
    registry = RuntimeSkillRegistry(SkillLoader([tmp_path]).discover())
    executor = SkillExecutor(
        SkillRouter(registry),
        mode="active",
        max_prompt_instruction_chars=1200,
    )
    context = SkillContext(question="投资逻辑", agent="market_researcher")

    execution = asyncio.run(executor.execute_phase("pre_answer", context))

    result = execution.results[0]
    assert result.trace["instruction_truncated"] is True
    assert len(result.trace["instruction"]) < 1300
    assert "Instruction truncated" in context.prompt_instructions[0]["instruction"]


def test_router_respects_agent_and_negative_keywords(tmp_path: Path) -> None:
    _write_prompt_skill(tmp_path)
    registry = RuntimeSkillRegistry(SkillLoader([tmp_path]).discover())
    router = SkillRouter(registry)

    assert router.select(
        "pre_answer",
        SkillContext(question="投资逻辑", agent="quant"),
    ) == []


def test_active_formula_skill_becomes_agent_evidence(tmp_path: Path) -> None:
    _write_formula_skill(tmp_path)
    registry = RuntimeSkillRegistry(SkillLoader([tmp_path]).discover())
    executor = SkillExecutor(SkillRouter(registry), mode="active")

    class Runtime:
        enabled = True
        mode = "active"

        async def execute_phase(self, phase, context):
            return await executor.execute_phase(phase, context)

    evidences = [
        {
            "query": "收入增长",
            "chunks": [
                {
                    "page_content": "current revenue",
                    "metadata": {
                        "content_type": "metric_fact",
                        "metric": "revenue_current",
                        "value": 120.0,
                        "unit": "EUR million",
                        "source_doc_id": "porsche-doc",
                        "evidence_id": "E1",
                    },
                },
                {
                    "page_content": "prior revenue",
                    "metadata": {
                        "content_type": "metric_fact",
                        "metric": "revenue_prior",
                        "value": 100.0,
                        "unit": "EUR million",
                        "source_doc_id": "porsche-doc",
                        "evidence_id": "E2",
                    },
                },
            ],
            "pre_rerank_chunks": [],
            "retrieval_scope": {
                "dataset_id": "test-real",
                "source_doc_ids": ["porsche-doc"],
            },
        }
    ]

    updated, traces = asyncio.run(
        apply_retrieval_skills(
            runtime=Runtime(),
            question="保时捷收入增长是多少？",
            agent="quant",
            evidences=evidences,
        )
    )

    assert traces[0]["status"] == "applied"
    assert traces[0]["derived_facts"][0]["value"] == pytest.approx(0.2)
    assert updated[-1]["content_type"] == "skill_context"
    assert "Deterministic Skill Facts" in updated[-1]["context"]


def test_python_skill_is_blocked_by_default(tmp_path: Path) -> None:
    _write_python_skill(tmp_path)
    registry = RuntimeSkillRegistry(SkillLoader([tmp_path]).discover())
    executor = SkillExecutor(SkillRouter(registry), mode="active", allow_python=False)

    execution = asyncio.run(
        executor.execute_phase("query_parse", SkillContext(question="run it"))
    )

    assert execution.results[0].status == "blocked"
    assert execution.results[0].warnings == ["python_skills_disabled"]
