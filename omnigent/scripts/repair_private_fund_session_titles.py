"""Repair legacy private-fund session titles from their real first question."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from omnigent.entities.conversation import synthesize_conversation_title  # noqa: E402

LEGACY_TITLE_PREFIX = "当前会话必须基于私募投研资料项目"


def _first_user_content(
    connection: sqlite3.Connection,
    conversation_id: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT data
        FROM conversation_items
        WHERE conversation_id = ? AND type = 'message'
        ORDER BY position
        """,
        (conversation_id,),
    ).fetchall()
    for (raw_data,) in rows:
        try:
            data = json.loads(raw_data)
        except (TypeError, json.JSONDecodeError):
            continue
        if data.get("role") == "user" and isinstance(data.get("content"), list):
            return data["content"]
    return []


def build_repairs(connection: sqlite3.Connection) -> list[dict[str, str]]:
    """Return scoped old/new title changes without mutating the database."""
    rows = connection.execute(
        """
        SELECT id, title
        FROM conversations
        WHERE title LIKE ?
        ORDER BY created_at
        """,
        (f"{LEGACY_TITLE_PREFIX}%",),
    ).fetchall()
    repairs: list[dict[str, str]] = []
    for conversation_id, old_title in rows:
        content = _first_user_content(connection, conversation_id)
        new_title = synthesize_conversation_title(content)
        if new_title and new_title != old_title and not new_title.startswith(LEGACY_TITLE_PREFIX):
            repairs.append(
                {
                    "conversation_id": conversation_id,
                    "old_title": old_title,
                    "new_title": new_title,
                }
            )
    return repairs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()

    connection = sqlite3.connect(args.database)
    repairs = build_repairs(connection)
    print(f"可修复标题：{len(repairs)} 条")
    for repair in repairs[:10]:
        print(f"- {repair['conversation_id']}: {repair['new_title']}")

    if not args.apply:
        print("当前为预览模式；添加 --apply 和 --backup 后才会写入。")
        return
    if args.backup is None:
        raise SystemExit("应用修复时必须提供 --backup 路径。")

    args.backup.parent.mkdir(parents=True, exist_ok=True)
    args.backup.write_text(
        json.dumps(
            {
                "database": str(args.database),
                "created_at": datetime.now(UTC).isoformat(),
                "changes": repairs,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    changed = 0
    with connection:
        for repair in repairs:
            cursor = connection.execute(
                """
                UPDATE conversations
                SET title = ?
                WHERE id = ? AND title = ?
                """,
                (
                    repair["new_title"],
                    repair["conversation_id"],
                    repair["old_title"],
                ),
            )
            changed += cursor.rowcount
    print(f"已修复标题：{changed} 条")
    print(f"回滚备份：{args.backup}")


if __name__ == "__main__":
    main()
