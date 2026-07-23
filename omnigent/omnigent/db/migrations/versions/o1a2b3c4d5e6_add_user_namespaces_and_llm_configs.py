"""add user data namespaces and encrypted model configs

Revision ID: o1a2b3c4d5e6
Revises: n1a2b3c4d5e6
Create Date: 2026-07-23 00:00:00.000000
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "o1a2b3c4d5e6"
down_revision: str | None = "n1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("data_namespace", sa.String(length=36), nullable=True))
        batch_op.create_unique_constraint(
            "uq_users_data_namespace",
            ["data_namespace"],
        )

    connection = op.get_bind()
    rows = connection.execute(sa.text("SELECT id FROM users")).fetchall()
    for row in rows:
        connection.execute(
            sa.text("UPDATE users SET data_namespace = :namespace WHERE id = :user_id"),
            {"namespace": str(uuid.uuid4()), "user_id": row[0]},
        )

    op.create_table(
        "user_llm_configs",
        sa.Column("user_id", sa.String(length=128), nullable=False),
        sa.Column("preset", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("base_url", sa.String(length=2048), nullable=False),
        sa.Column("model", sa.String(length=256), nullable=False),
        sa.Column("api_key_ciphertext", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("user_llm_configs")
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_constraint("uq_users_data_namespace", type_="unique")
        batch_op.drop_column("data_namespace")
