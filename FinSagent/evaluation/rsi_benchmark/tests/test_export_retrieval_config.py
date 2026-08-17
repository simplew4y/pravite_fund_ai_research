import unittest

from evaluation.rsi_benchmark.export_retrieval_config import sanitize


class ExportRetrievalConfigTest(unittest.TestCase):
    def test_removes_nested_credentials_and_external_endpoints(self):
        cleaned = sanitize({
            "llm_api_key": "secret",
            "nested": {"access_token": "secret", "value": 3},
            "llm_base_url": "https://external.example/v1",
            "embedding_vllm_url": "http://127.0.0.1:5433/v1/embeddings",
        })
        self.assertNotIn("llm_api_key", cleaned)
        self.assertEqual(cleaned["nested"], {"value": 3})
        self.assertNotIn("llm_base_url", cleaned)
        self.assertEqual(cleaned["embedding_vllm_url"], "http://127.0.0.1:5433/v1/embeddings")


if __name__ == "__main__":
    unittest.main()
