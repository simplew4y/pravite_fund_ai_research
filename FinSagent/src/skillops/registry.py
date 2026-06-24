"""Load and query SkillOps skill cards."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Iterable

from skillops.skill_card import SkillCard

try:
    import yaml
except Exception:  # pragma: no cover - production env has PyYAML; fallback keeps imports cheap.
    yaml = None


class SkillRegistry:
    def __init__(self, cards: Iterable[SkillCard] = ()) -> None:
        self._cards: dict[str, SkillCard] = {}
        for card in cards:
            self.add(card)

    def add(self, card: SkillCard) -> None:
        if card.skill_id in self._cards:
            raise ValueError(f"duplicate skill_id: {card.skill_id}")
        self._cards[card.skill_id] = card

    def get(self, skill_id: str) -> SkillCard:
        return self._cards[skill_id]

    def all(self) -> list[SkillCard]:
        return sorted(self._cards.values(), key=lambda card: card.skill_id)

    def by_status(self, status: str) -> list[SkillCard]:
        return [card for card in self.all() if card.status == status]

    def by_failure_type(self, failure_type: str) -> list[SkillCard]:
        return [card for card in self.all() if failure_type in card.failure_types]

    def status_counts(self) -> dict[str, int]:
        return dict(Counter(card.status for card in self.all()))

    def failure_type_counts(self) -> dict[str, int]:
        counter: Counter[str] = Counter()
        for card in self.all():
            counter.update(card.failure_types)
        return dict(counter)


def load_skill_registry(skill_card_dir: str | Path = "configs/skill_cards") -> SkillRegistry:
    root = Path(skill_card_dir)
    cards: list[SkillCard] = []
    for path in sorted(root.glob("*.yaml")):
        cards.append(SkillCard.from_dict(_load_yaml(path), source_path=str(path)))
    return SkillRegistry(cards)


def _load_yaml(path: Path) -> dict:
    if yaml is None:
        raise RuntimeError("PyYAML is required to load skill cards")
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: expected top-level mapping")
    return payload

