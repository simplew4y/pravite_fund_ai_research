# vLLM Embedding / Reranker 合并使用示例

本文档只对应一个统一入口脚本：

- 启动脚本：`start_vllm_services.sh`

这个脚本会同时启动两个服务：

- Embedding：`BAAI/bge-m3`
- Reranker：`BAAI/bge-reranker-v2-gemma`

其中和当前 `FinSagent` 主服务实际行为对齐的关键点是：

- Embedding 模型：`BAAI/bge-m3`
- Reranker 模型：`BAAI/bge-reranker-v2-gemma`
- Reranker 示例返回数量：`top 5`

默认端口：

- Embedding：`5433`
- Reranker：`5432`

## 1. 一键启动两个服务

```bash
cd /root/autodl-tmp/dir_whw/FinSagent
bash start_vllm_services.sh
```

启动后日志会写到：

- `logs/vllm_embedding.log`
- `logs/vllm_reranker.log`

按 `Ctrl+C` 会一起停止两个服务。

## 2. 启动脚本做了什么

`start_vllm_services.sh` 内部会：

1. `conda activate vllm`
2. 启动 `BAAI/bge-m3`
3. 启动 `BAAI/bge-reranker-v2-gemma`
4. 分别输出日志到 `logs/`

等价的底层命令分别是：

### Embedding

```bash
vllm serve BAAI/bge-m3 \
  --host 0.0.0.0 \
  --port 5433 \
  --runner pooling \
  --task embed \
  --gpu-memory-utilization 0.25 \
  --hf-overrides '{"architectures": ["BgeM3EmbeddingModel"]}'
```

### Reranker

```bash
vllm serve BAAI/bge-reranker-v2-gemma \
  --served-model-name BAAI/bge-reranker-v2-gemma \
  --host 0.0.0.0 \
  --port 5432 \
  --runner pooling \
  --convert classify \
  --gpu-memory-utilization 0.45 \
  --max-model-len 8192 \
  --hf_overrides '{"architectures": ["GemmaForSequenceClassification"], "classifier_from_token": ["Yes"], "method": "no_post_processing"}'
```

## 3. 调用示范

### 3.1 Embedding 的 curl 示例

```bash
curl -s http://127.0.0.1:5433/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "BAAI/bge-m3",
    "input": [
      "极氪2024年销量如何？",
      "极氪2024年全年交付表现强劲。"
    ]
  }'
```

### 3.2 Embedding 的 Python 示例

```python
import requests

url = "http://127.0.0.1:5433/v1/embeddings"
payload = {
    "model": "BAAI/bge-m3",
    "input": [
        "极氪2024年销量如何？",
        "极氪2024年全年交付表现强劲。",
    ],
}

response = requests.post(url, json=payload, timeout=60)
response.raise_for_status()
data = response.json()

print(data)
print("embedding dim:", len(data["data"][0]["embedding"]))
```

### 3.3 Reranker 的 curl 示例

```bash
curl -s http://127.0.0.1:5432/rerank \
  -H "Content-Type: application/json" \
  -d '{
    "model": "BAAI/bge-reranker-v2-gemma",
    "query": "极氪2024年销量如何？",
    "documents": [
      "极氪2024年全年交付表现强劲。",
      "苹果公司发布了新款手机。",
      "该公司在海外市场扩张。",
      "极氪在欧洲市场继续拓展。",
      "公司公布了新的车型规划。"
    ],
    "top_n": 5
  }'
```

### 3.4 Reranker 的 Python 示例

```python
import requests

url = "http://127.0.0.1:5432/rerank"
payload = {
    "model": "BAAI/bge-reranker-v2-gemma",
    "query": "极氪2024年销量如何？",
    "documents": [
        "极氪2024年全年交付表现强劲。",
        "苹果公司发布了新款手机。",
        "该公司在海外市场扩张。",
        "极氪在欧洲市场继续拓展。",
        "公司公布了新的车型规划。",
    ],
    "top_n": 5,
}

response = requests.post(url, json=payload, timeout=60)
response.raise_for_status()
data = response.json()

print(data)
for item in data["results"]:
    print(item["index"], item["relevance_score"], item["document"]["text"])
```

## 4. 现成的项目内示例

项目里还保留了一个单独的 reranker Python 示例：

```bash
cd /root/autodl-tmp/dir_whw/FinSagent
python call_vllm_reranker_example.py
```

## 5. 常用检查命令

查看服务模型列表：

```bash
curl -s http://127.0.0.1:5432/v1/models
curl -s http://127.0.0.1:5433/v1/models
```

查看日志：

```bash
tail -f /root/autodl-tmp/dir_whw/FinSagent/logs/vllm_embedding.log
tail -f /root/autodl-tmp/dir_whw/FinSagent/logs/vllm_reranker.log
```
