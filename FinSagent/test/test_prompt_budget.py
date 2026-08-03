from utils.prompt_budget import TRUNCATION_MARKER, join_with_budget, truncate_text


def test_truncate_text_preserves_relevance_ordered_prefix() -> None:
    text = "important-prefix:" + "x" * 200
    result = truncate_text(text, 80)

    assert len(result) == 80
    assert result.startswith("important-prefix:")
    assert result.endswith(TRUNCATION_MARKER)


def test_join_with_budget_never_exceeds_limit() -> None:
    result = join_with_budget(["first" * 50, "second" * 50], 120)

    assert len(result) <= 120
    assert result.startswith("first")


def test_empty_budget_inputs_stay_empty() -> None:
    assert join_with_budget([], 100) == ""
    assert truncate_text("abc", 0) == ""
