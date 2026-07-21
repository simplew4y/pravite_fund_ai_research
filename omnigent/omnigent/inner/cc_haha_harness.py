"""``harness: cc-haha`` wrapper for the bundled headless CLI."""

from __future__ import annotations

import os

from fastapi import FastAPI

from omnigent.inner.cc_haha_executor import CCHahaExecutor
from omnigent.inner.executor import Executor
from omnigent.runtime.harnesses._executor_adapter import ExecutorAdapter


def _build_cc_haha_executor() -> Executor:
    return CCHahaExecutor(
        binary_path=os.environ.get("HARNESS_CC_HAHA_PATH", "claude-haha"),
        cwd=os.environ.get("HARNESS_CC_HAHA_CWD") or None,
        model=os.environ.get("HARNESS_CC_HAHA_MODEL") or None,
        bundle_dir=os.environ.get("HARNESS_CC_HAHA_BUNDLE_DIR") or None,
        private_fund_prompt_file=(
            os.environ.get("HARNESS_CC_HAHA_SYSTEM_PROMPT_FILE") or None
        ),
        permission_mode=os.environ.get(
            "HARNESS_CC_HAHA_PERMISSION_MODE", "bypassPermissions"
        ),
    )


def create_app() -> FastAPI:
    return ExecutorAdapter(executor_factory=_build_cc_haha_executor).build()
