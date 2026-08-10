# Private-fund retrieval index workflow

`meta/collection.sqlite3` is the canonical data store. `vector_store/` is a
derived, versioned-by-fingerprint retrieval bundle and must never be edited by
tests or reset in place.

## One supported command

Prepare an already-ingested dataset (the normal test/evaluation path):

```bash
python data_pipeline/prepare_private_fund_dataset.py \
  --dataset-root /path/to/private_fund_datasets/test_real_data \
  --config config/production.yaml
```

When the canonical source fingerprint and all component counts match the
manifest, this command prints `"status": "reused"` and performs no embedding.

Ingest a source directory and then build indexes:

```bash
python data_pipeline/prepare_private_fund_dataset.py \
  --source-directory /path/to/source/files \
  --dataset-root /path/to/private_fund_datasets/my_dataset \
  --config config/production.yaml
```

Fast CI/readiness gate (never writes):

```bash
python data_pipeline/prepare_private_fund_dataset.py \
  --dataset-root /path/to/private_fund_datasets/test_real_data \
  --check-only
```

## Guarantees

- A dataset-scoped file lock prevents concurrent builders.
- Embeddings and BM25 are generated in a unique sibling staging directory.
- Main, table, title, and BM25 counts must be non-zero and match the manifest.
- The manifest records a fingerprint of active canonical documents and table
  counts; changed source data makes the old bundle stale.
- Only a fully validated staging directory is renamed into `vector_store/`.
  The previous bundle is restored if publication bookkeeping fails.
- Serving with `index_readiness_required: true` validates before constructing
  LangChain Chroma, preventing a missing path from becoming an empty database.

Legacy `load_data.py`, `load_table_chroma.py`, and `--reset-persist` flows are
not supported for a live or shared test dataset because they reset the target
before all parsing and embeddings have succeeded.
