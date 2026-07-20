import os
import yaml
import logging
import threading
logger = logging.getLogger(__name__)

from datetime import datetime
from typing import Dict, List, Tuple, Optional
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_chroma import Chroma
from langchain_core.documents import Document

from utils.EnsembleRetriever import EnsembleRetriever
from utils.vllm_embeddings import VLLMEmbeddings
import GPUtil

class RAGManager:
    """Singleton class for managing RAG collections"""
    _collections: Dict[str, Tuple[Chroma, Chroma, Chroma]] = {}
    _retrievers: List[EnsembleRetriever] = []
    _embedding_lock = None

    _instance = None
    _config = None

    def __new__(cls, config: Dict = None, collections: Dict[str, int] = None):
        if cls._instance is None:
            if config is None:
                logger.error("No config provided")
                raise ValueError("No config provided for RAGManager")
            instance = super(RAGManager, cls).__new__(cls)
            try:
                instance._initialize(config, collections)
            except Exception:
                cls._instance = None
                raise
            cls._instance = instance
        return cls._instance

    def __init__(self, config: Dict = None, collections: Dict[str, int] = None):
        pass

    def _initialize(self, config: Dict, collections: Dict[str, int]):
        self._config = config
        self.embeddings_model_name = config['embeddings_model_name']
        self.embedding_backend = str(config.get("embedding_backend", "huggingface")).lower()
        self.batch_size = 5
        self.embeddings = None

        self._embedding_lock = None if self.embedding_backend == "vllm" else threading.Lock()
        if self._embedding_lock is not None:
            logger.info("Embedding lock initialized for thread-safe embedding access")

        # Suppress warnings from GemmaTokenizerFast regarding __call__ method and logits type as below:
        # [You're using a GemmaTokenizerFast tokenizer. Please note that with a fast tokenizer, using the `__call__` method
        # is faster than using a method to encode the text followed by a call to the `pad` method to get a padded encoding.
        # Starting from v4.46, the `logits` model output will have the same type as the model (except at train time, where it
        #  will always be FP32)]. -- from terminal
        import transformers
        transformers.logging.set_verbosity_error()
        #print('hihihi')
        try:
            logger.info("Loading embedding model...")
            if self.embedding_backend == "vllm":
                self.embeddings = VLLMEmbeddings(
                    endpoint_url=config.get("embedding_vllm_url", "http://127.0.0.1:5433/v1/embeddings"),
                    model_name=self.embeddings_model_name,
                    timeout_seconds=float(config.get("embedding_timeout_seconds", 60)),
                    batch_size=int(config.get("embedding_batch_size", 32)),
                    api_key=config.get("llm_api_key"),
                )
            else:
                self.embeddings = HuggingFaceEmbeddings(model_name=self.embeddings_model_name)
            logger.info("Embedding model loaded successfully.")
            import torch
            if torch.cuda.is_available() and torch.cuda.is_initialized():
                logger.warning("Load Embedding model: Max CUDA memory allocated: {} GB".format(torch.cuda.max_memory_allocated() / (1024 * 1024 * 1024)))

        except Exception as e:
            logger.exception("Failed to load embedding model: %s", self.embeddings_model_name)
            raise RuntimeError(
                f"Failed to initialize embeddings model '{self.embeddings_model_name}'. "
                "Check that the model name is valid and all embedding dependencies are installed."
            ) from e

        if collections is not None:
            for collection, top_k in collections.items():
                if top_k <= 0:
                    continue
                self.create_collection(collection)
                self._retrievers.append(self.create_retriever(top_k, collection, retriever_type="ensemble"))

        
    def create_collection(self, collection_name: str, load_table_chroma: bool = True):
        """Create a new collection with all supported retrievers"""
        if self.embeddings is None:
            raise RuntimeError(
                "Embeddings are not initialized. RAGManager initialization failed earlier."
            )

        if collection_name not in self._collections:
            # Initialize Chroma
            chroma = Chroma(
                collection_name=collection_name,
                embedding_function=self.embeddings,
                persist_directory=os.path.join(self._config['persist_directory'], "chroma"),
                relevance_score_fn="cosine" # l2, ip, cosine
            )
            
            ts_chroma = Chroma(
                collection_name=collection_name,
                embedding_function=self.embeddings,
                persist_directory=os.path.join(self._config['persist_directory'], "ts_chroma"),
                relevance_score_fn="cosine" # l2, ip, cosine
            )
            
            table_chroma = None
            if load_table_chroma:
                try:
                    table_chroma = Chroma(
                        collection_name=collection_name,
                        embedding_function=self.embeddings,
                        persist_directory=os.path.join(self._config['persist_directory'], "table_chroma"),
                        relevance_score_fn="cosine" # l2, ip, cosine
                    )
                    logger.info(f"Loaded table_chroma for collection {collection_name}")
                except Exception as e:
                    logger.warning(f"Failed to load table_chroma for {collection_name}: {e}. Table retrieval will be disabled.")
                    table_chroma = None
            
            self._collections[collection_name] = (chroma, ts_chroma, table_chroma)
            import torch
            if torch.cuda.is_available() and torch.cuda.is_initialized():
                logger.warning("Load Chroma: Max CUDA memory allocated: {} GB".format(torch.cuda.max_memory_allocated() / (1024 * 1024 * 1024)))

    def get_collection_documents(self, collection_name: str, doc_ids: Optional[List[str]] = None) -> List[Document]:
        """Get documents from a collection by document IDs. User should not assume that the order of the returned documents matches the order of the input IDs."""
        chroma, _, _ = self._collections[collection_name]
        if doc_ids is None:
            chroma_docs = chroma.get()
        else:
            chroma_docs = chroma.get(ids=doc_ids)

        documents = [
            Document(
                page_content=page_content,
                metadata=metadata
            )
            for page_content, metadata in zip(chroma_docs['documents'], chroma_docs['metadatas'])
        ]
        return documents
    
    def create_retriever(self, k: int, collection_name: str, retriever_type: str = "chroma", 
                        table_k: int = 3):
        """Create a specific retriever for a collection
        
        Args:
            k: Number of chunks to retrieve
            collection_name: Name of the collection
            retriever_type: Type of retriever (currently only "chroma" is used)
            table_k: Number of tables to retrieve (0 to disable table retrieval)
        """
        if collection_name not in self._collections:
            raise ValueError(f"Collection {collection_name} does not exist")
            
        bm25_dir = os.path.join(self._config['persist_directory'], "bm25_index", collection_name)

        chroma, ts_chroma, table_chroma = self._collections[collection_name]
        pageindex_mode = str(self._config.get("pageindex_mode", "off")).lower()
        pageindex_index_dir = self._config.get("pageindex_index_dir")
        if pageindex_mode not in {"off", "none", "false", ""} and not pageindex_index_dir:
            raise ValueError(
                "pageindex_index_dir must be set when pageindex_mode is enabled "
                f"(got pageindex_mode={pageindex_mode!r})"
            )

        allow_missing_bm25 = self._config.get("allow_missing_bm25_index", True)
        retriver = EnsembleRetriever(bm25_dir, chroma, ts_chroma, k, self.embeddings,
                                    table_k=table_k, table_chroma=table_chroma,
                                    enable_expand=True,
                                    embedding_lock=self._embedding_lock,
                                    allow_missing_bm25_index=allow_missing_bm25,
                                    pageindex_mode=pageindex_mode,
                                    pageindex_index_dir=pageindex_index_dir,
                                    pageindex_k=self._config.get("pageindex_top_k", k),
                                    pageindex_node_top_k=self._config.get("pageindex_node_top_k", k),
                                    pageindex_max_chunks_per_node=self._config.get("pageindex_max_chunks_per_node", 3),
                                    pageindex_page_window=self._config.get("pageindex_page_window", 0),
                                    pageindex_include_node_summary=self._config.get("pageindex_include_node_summary", False),
                                    pageindex_recency_boost=self._config.get("pageindex_recency_boost", 0.0))
            
        return retriver


# Usage example
def main():
    config_path = "../../config/config_test.yaml"
    with open(config_path, 'r') as file:
        config = yaml.safe_load(file)
    
    questions = [
        "Are there any new releases in 2023?",
        "Can you tell me how Lotus's approach to vehicle design evolved between 2000 and 2020?",
        "What are the unique technical features that make Lotus stand out in racing?" ,
        "Can you explain the lightweight design philosophy of Lotus?" ,
        "Which Lotus models are best known for their driving performance on the track?" ,
    ]
    
    rag = RAGManager(config)
    log_gpu_usage('RAGManager init')
    #rag.create_collection("lotus")
    rag.create_collection("zeekr")
    log_gpu_usage('RAGManager create collection')
    #retriever = rag.create_retriever(5, "lotus", "ensemble")
    retriever = rag.create_retriever(5, "zeekr", "ensemble")
    log_gpu_usage('RAGManager get retriever')

    for q in questions:
        documents = retriever.invoke(q)
        log_gpu_usage('RAGManager invoke retriever')
        print(f"Question: {q}")
        for i, doc in enumerate(documents):
            print(f"{i}: {doc}")
        print("")
        

def log_gpu_usage(event_name):
    gpus = GPUtil.getGPUs()
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    gpu_log_file = "gpu_usage.log"
    for gpu in gpus:
        gpu_info = (
            f"Timestamp: {timestamp}, Event: {event_name}, "
            f"GPU ID: {gpu.id}, GPU Name: {gpu.name}, "
            f"Memory Used: {gpu.memoryUsed} MB, Memory Total: {gpu.memoryTotal} MB"
        )
        # 将信息追加到日志文件
        with open(gpu_log_file, 'a') as f:
            f.write(gpu_info + '\n')

if __name__ == "__main__":
    main()
