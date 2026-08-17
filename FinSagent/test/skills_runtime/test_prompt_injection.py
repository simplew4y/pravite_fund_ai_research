import asyncio
from types import SimpleNamespace

from agents.shared import draft_answer


class RecordingSessionManager:
    config = {
        "draft_llm_max_retries": 1,
        "answer_self_check_enabled": False,
    }

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def call_llm_async(self, messages, **kwargs):
        prompt = messages[0]["content"]
        self.prompts.append(prompt)
        content = "evidence-grounded draft" if len(self.prompts) == 1 else "combined answer"
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


def test_skill_instruction_is_injected_with_real_evidence() -> None:
    session = RecordingSessionManager()
    evidences = [
        {
            "query": "公司DCF估值",
            "context": "FACT: 2025E UFCF is evidence-backed.",
        },
        {
            "query": "请做公司DCF估值",
            "context": "Skill Instruction (anthropic_dcf_model):\nBuild an auditable DCF.",
            "content_type": "skill_context",
        },
    ]

    answer = asyncio.run(
        draft_answer(
            agent="quant",
            question="请做公司DCF估值",
            history=[],
            evidences=evidences,
            tool_results={},
            answer_prompt="Question: {question}\nEvidence: {evidence}\nTools: {tools}\nHistory: {history}",
            session_manager=session,
        )
    )

    assert answer == "combined answer"
    assert len(session.prompts) == 2
    draft_prompt = session.prompts[0]
    assert "FACT: 2025E UFCF is evidence-backed." in draft_prompt
    assert "ACTIVE SKILL INSTRUCTIONS" in draft_prompt
    assert "anthropic_dcf_model" in draft_prompt
    assert "they are not factual evidence" in draft_prompt
    # The carrier must not create a second, evidence-free draft call.
    assert "Skill Instruction" not in session.prompts[1] or "sub-answers" in session.prompts[1].lower()
