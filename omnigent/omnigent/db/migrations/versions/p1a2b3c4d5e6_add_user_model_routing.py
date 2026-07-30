"""add encrypted user model routing

Revision ID: p1a2b3c4d5e6
Revises: o1a2b3c4d5e6
Create Date: 2026-07-30 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "p1a2b3c4d5e6"
down_revision: str | None = "o1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_model_routing",
        sa.Column("user_id", sa.String(length=128), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("platform_token_ciphertext", sa.Text(), nullable=True),
        sa.Column("platform_token_expires_at", sa.Integer(), nullable=True),
        sa.Column("platform_gateway_base_url", sa.String(length=2048), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("source IN ('platform', 'byok')", name="ck_user_model_routing_source"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("user_model_routing")
