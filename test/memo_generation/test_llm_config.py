import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pdf_research_demo.llm import LLMConfig, OpenAICompatibleChatClient, load_llm_config


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return b'{"choices":[{"message":{"content":"ok"}}]}'


def test_load_llm_config_reads_optional_thinking_flag(tmp_path: Path) -> None:
    config_path = tmp_path / "llm.yaml"
    config_path.write_text(
        "\n".join(
            [
                'llm_model_name: "demo"',
                'llm_base_url: "http://127.0.0.1:8000/v1"',
                'llm_api_key: "EMPTY"',
                "llm_chat_template_enable_thinking: false",
            ]
        ),
        encoding="utf-8",
    )

    config = load_llm_config(config_path)

    assert config is not None
    assert config.chat_template_enable_thinking is False


def test_chat_forwards_optional_thinking_flag() -> None:
    config = LLMConfig(
        model_name="demo",
        base_url="http://127.0.0.1:8000/v1",
        api_key="EMPTY",
        chat_template_enable_thinking=False,
    )
    client = OpenAICompatibleChatClient(config)

    with patch("urllib.request.urlopen", return_value=_FakeResponse()) as urlopen:
        assert client.chat([{"role": "user", "content": "hello"}]) == "ok"

    request = urlopen.call_args.args[0]
    payload = json.loads(request.data.decode("utf-8"))
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}


def test_chat_json_requests_provider_enforced_json() -> None:
    config = LLMConfig(
        model_name="demo",
        base_url="http://127.0.0.1:8000/v1",
        api_key="EMPTY",
    )
    client = OpenAICompatibleChatClient(config)

    with patch("urllib.request.urlopen", return_value=_FakeResponse()) as urlopen:
        assert client.chat_json([{"role": "user", "content": "return json"}]) == "ok"

    request = urlopen.call_args.args[0]
    payload = json.loads(request.data.decode("utf-8"))
    assert payload["response_format"] == {"type": "json_object"}
