"""
SessionManager - 会话管理器

职责:
- 管理单个会话的 chat_history
- 提供 LLM Client
- 加载 Tools Schema
"""

import os
import json
import logging
import time
import threading
import httpx
from typing import List, Dict

import openai

logger = logging.getLogger(__name__)


def _build_openai_timeout(config: Dict) -> httpx.Timeout:
    default_timeout = float(config.get("llm_timeout_seconds", 120))
    return httpx.Timeout(
        connect=float(config.get("llm_connect_timeout_seconds", 20)),
        read=float(config.get("llm_read_timeout_seconds", default_timeout)),
        write=float(config.get("llm_write_timeout_seconds", 20)),
        pool=float(config.get("llm_pool_timeout_seconds", 20)),
    )


class SessionManager:
    """会话管理器,负责会话级状态管理和 LLM 客户端"""

    def __init__(self, session_id: str, config: Dict):
        """
        初始化 SessionManager

        Args:
            session_id: 会话 ID
            config: 配置字典
        """
        self.session_id = session_id
        self.config = config

        # LLM Client
        llm_timeout = _build_openai_timeout(config)
        llm_max_retries = int(config.get("llm_max_retries", 5))
        self.llm = openai.OpenAI(
            api_key=config.get('llm_api_key', 'EMPTY'),
            base_url=config.get('llm_base_url'),
            timeout=llm_timeout,
            max_retries=llm_max_retries,
        )
        self.async_llm = openai.AsyncOpenAI(
            api_key=config.get('llm_api_key', 'EMPTY'),
            base_url=config.get('llm_base_url'),
            timeout=llm_timeout,
            max_retries=llm_max_retries,
        )
        self.model_name = config.get('llm_model_name')

        # 状态管理
        self.chat_history: List[Dict] = []  # [{"role": "user/assistant", "content": "..."}]
        self.history_limit = 20
        self.history_lock = threading.RLock()
        self.request_lock = threading.Lock()

        # Tools Schema
        self.tools_schema = self._load_tools_schema()

        logger.info(f"SessionManager initialized for session {session_id}")

    def add_to_chat_history(self, role: str, content: str):
        """
        添加消息到对话历史

        Args:
            role: user 或 assistant
            content: 消息内容
        """
        with self.history_lock:
            self.chat_history.append({"role": role, "content": content})
            if len(self.chat_history) > self.history_limit:
                self.chat_history.pop(0)
            history_size = len(self.chat_history)

        logger.debug(f"[Session {self.session_id}] Chat history updated, size: {history_size}")

    def add_exchange(self, user_content: str, assistant_content: str):
        with self.history_lock:
            self.chat_history.append({"role": "user", "content": user_content})
            self.chat_history.append({"role": "assistant", "content": assistant_content})
            while len(self.chat_history) > self.history_limit:
                self.chat_history.pop(0)
            history_size = len(self.chat_history)

        logger.debug(f"[Session {self.session_id}] Chat history updated, size: {history_size}")

    def get_chat_history_copy(self) -> List[Dict]:
        with self.history_lock:
            return [msg.copy() for msg in self.chat_history]

    def get_chat_history_string(self) -> str:
        """
        格式化 chat_history 为字符串 (用于 prompt)

        Returns:
            chat_history_str: 格式化的对话历史
        """
        with self.history_lock:
            return "\n".join([
                f"{msg['role']}: {msg['content']}"
                for msg in self.chat_history
            ])

    def call_llm(self, messages: List[Dict], temperature: float = 0,
                 stream: bool = False, **kwargs):
        """
        统一的 LLM 调用接口 (同步)

        Args:
            messages: 消息列表
            temperature: 温度参数
            stream: 是否流式输出
            **kwargs: 其他参数

        Returns:
            response: LLM 响应
        """
        # ! Danger: Must get results for colm. Remove when production.
        while True:
            try:
                return self.llm.chat.completions.create(
                    model=self.model_name,
                    messages=messages,
                    temperature=1.0,
                    stream=stream,
                    **kwargs
                )
            except Exception as e:
                logger.warning(f"[Session {self.session_id}] Sync LLM call failed, retrying after wait: {e}", exc_info=True)
                time.sleep(5)

    async def call_llm_async(self, messages: List[Dict], temperature: float = 0,
                            stream: bool = False, **kwargs):
        """
        统一的 LLM 调用接口 (异步)

        Args:
            messages: 消息列表
            temperature: 温度参数
            stream: 是否流式输出
            **kwargs: 其他参数

        Returns:
            response: LLM 响应
        """
        return await self.async_llm.chat.completions.create(
            model=self.model_name,
            messages=messages,
            temperature=1.0,
            stream=stream,
            **kwargs
        )

    def _load_tools_schema(self) -> List[Dict]:
        """
        加载工具 schema

        Returns:
            tools_schema: 工具 schema 列表
        """
        # tools_schema.json 在 utils 目录下
        tools_schema_path = os.path.join(os.path.dirname(__file__), "..", "tools", "tools_schema.json")
        try:
            with open(tools_schema_path, "r", encoding="utf-8") as f:
                tools_schema = json.load(f)
                logger.info(f"Loaded {len(tools_schema)} tools from schema")
                return tools_schema
        except Exception as e:
            logger.error(f"Failed to load tools_schema.json from {tools_schema_path}: {e}")
            return []

    def __del__(self):
        """清理资源"""
        try:
            logger.info(f"SessionManager cleanup for session {self.session_id}")
            with self.history_lock:
                self.chat_history.clear()
        except Exception as e:
            logger.error(f"Error during SessionManager cleanup: {str(e)}")
