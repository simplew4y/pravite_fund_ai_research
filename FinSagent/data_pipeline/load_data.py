import os
import sys
import logging
logging.basicConfig(filename='load_data.log', filemode='w', level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

import yaml
import json
from tqdm import tqdm
import shutil
import hashlib
import re
from datetime import datetime
from langchain_community.document_loaders import JSONLoader

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")

if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from core.RAGManager import RAGManager
from utils.bm25Retriever import load_from_chroma_and_save

def load_config(config_path):
    with open(config_path, 'r') as file:
        return yaml.safe_load(file)

def import_collection_from_dir(rag_manager, collection_name: str, dir_path: str, batch_size: int, ignore_range: bool = False):
        """Load data from a directory into a chroma collection, processing metadata and content.
        
        Args:
            collection_name: Name of the collection to populate
            dir_path: Path to directory containing JSON files
            ignore_range: Whether to ignore page range restrictions when loading
        """
        chroma, ts_chroma, _ = rag_manager._collections[collection_name]
        chroma.reset_collection()
        ts_chroma.reset_collection()

        content_dict = {}  # Maps content hash to a tuple of (content, metadata)
        gid = 0
        title_summaries = set()

        def hash_content(content: str) -> str:
            """Generate a SHA-256 hash of the content."""
            return hashlib.sha256(content.encode('utf-8')).hexdigest()

        def extract_date_from_filename(fname: str) -> str:
            """Extract 8-digit date (YYYYMMDD) or 4-digit year (YYYY) from filename."""
            match = re.search(r'(\d{4})[-_](\d{2})[-_](\d{2})', fname)
            if match:
                y, m, d = match.group(1), match.group(2), match.group(3)
                try:
                    return datetime.strptime(f"{y}-{m}-{d}", "%Y-%m-%d").strftime("%Y-%m-%d")
                except ValueError:
                    return ""

            match = re.search(r'(\d{8})', fname)
            if match:
                try:
                    return datetime.strptime(match.group(1), "%Y%m%d").strftime("%Y-%m-%d")
                except ValueError:
                    return ""

            match = re.search(r'(\d{4})', fname)
            if match:
                return f"{match.group(1)}-01-01"
            return ""

        filenames = os.listdir(dir_path)
        for filename in filenames:
            if filename.endswith(".json"):
                json_file = os.path.join(dir_path, filename)
                print(json_file)
                loader = JSONLoader(file_path=json_file, jq_schema=".[]", text_content=False)
                documents = loader.load()

                # Detect whether the first chunk is a meta chunk
                first_chunk_data = json.loads(documents[0].page_content)
                has_meta = all(k in first_chunk_data for k in ("start", "end", "date_published"))

                if has_meta:
                    page_start = first_chunk_data["start"]
                    page_end = first_chunk_data["end"]
                    page_date_published = first_chunk_data.get("date_published", "")
                    docs_to_process = documents[1:]
                    logger.info(f"Meta chunk detected in {filename}: start={page_start}, end={page_end}, date={page_date_published}")
                else:
                    page_start = None
                    page_end = None
                    page_date_published = extract_date_from_filename(filename)
                    docs_to_process = documents
                    logger.info(f"No meta chunk in {filename}, extracted date from filename: {page_date_published}")

                count = 0
                for doc in docs_to_process:
                    content_dict_data = json.loads(doc.page_content)
                    content = content_dict_data.get("content", "")
                    page_number = content_dict_data.get("page_number", 0)
                    bundle_id = content_dict_data.get("bundle_id", None)
                    title_summary = content_dict_data.get("title_summary", None)

                    content_hash = hash_content(content)

                    # Apply page range filter only when meta chunk exists
                    if has_meta and not ignore_range:
                        if not (int(page_start) <= int(page_number) <= int(page_end)):
                            continue

                    metadata = {
                        "filename": filename,
                        "page_number": page_number,
                        "date_published": page_date_published,
                        "doc_id": content_hash,
                        "global_id": gid,
                    }
                    gid += 1
                    if bundle_id:
                        metadata["bundle_id"] = bundle_id
                    if title_summary:
                        metadata["title_summary"] = title_summary
                        title_summaries.add(title_summary)

                    # Handle duplicates by comparing date_published
                    if content_hash in content_dict:
                        existing_content, existing_metadata = content_dict[content_hash]
                        if page_date_published > existing_metadata["date_published"]:
                            # Replace older content with newer one
                            content_dict[content_hash] = (content, metadata)
                            logger.debug(f"Replacing content file: {existing_metadata['filename']} page: {existing_metadata['page_number']} in {existing_metadata['date_published']} with new version file: {metadata['filename']} page: {metadata['page_number']} in {page_date_published}. Hash: {content_hash}")
                    else:
                        # First encounter of this content hash
                        content_dict[content_hash] = (content, metadata)

                    count += 1

                logger.info(f"{count} chunks processed in {json_file}.")
        logger.info(f"{len(content_dict)} unique chunks loaded in total.")

        # Store title summaries
        title_summaries = list(title_summaries)
        for i in tqdm(range(0, len(title_summaries), batch_size), desc="Storing title summaries"):
            ts_chroma.add_texts(texts=title_summaries[i:i + batch_size])
        logger.info(f"{len(title_summaries)} title summaries stored in ts_{collection_name} collection.")

        # Separate content and metadata for batch storage
        content_list = [item[0] for item in content_dict.values()]  # Extract content
        metadata_list = [item[1] for item in content_dict.values()]  # Extract metadata
        content_hashes_list = [metadata["doc_id"] for metadata in metadata_list]

        # Store the previous chunk id and next chunk id in the metadata
        for i in range(len(metadata_list)):
            # check if the previous chunk has the same filename
            if i > 0 and metadata_list[i]["filename"] == metadata_list[i - 1]["filename"]:
                metadata_list[i]["prev_chunk_id"] = content_hashes_list[i - 1]
            else:
                metadata_list[i]["prev_chunk_id"] = ""
            # check if the next chunk has the same filename
            if i < len(metadata_list) - 1 and metadata_list[i]["filename"] == metadata_list[i + 1]["filename"]:
                metadata_list[i]["next_chunk_id"] = content_hashes_list[i + 1]
            else:
                metadata_list[i]["next_chunk_id"] = ""

        for i in tqdm(range(0, len(content_list), batch_size), desc="Storing database"):
            batch_contents = content_list[i:i + batch_size]
            batch_metadata = metadata_list[i:i + batch_size]
            batch_doc_ids = content_hashes_list[i:i + batch_size]
            chroma.add_texts(
                texts=batch_contents,
                metadatas=batch_metadata,
                ids=batch_doc_ids
            )

        logger.info(f"Database stored successfully in {collection_name} collection.")

if __name__ == '__main__':
    config_path = f"config/config_nvidia_0425.yaml"
    config = load_config(config_path)

    # clear the persist_directory
    if os.path.exists(config['persist_directory']):
        shutil.rmtree(config['persist_directory'])

    rag = RAGManager(config)

    # * lotus
    # collection_dir = "/root/autodl-tmp/RAG_Agent_data/lotus/20250701/final_meta_wo_table"
    # collection_name = "lotus"

    # * zeekr    
    # collection_dir = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/base_final_wo_table"
    # collection_name = "zeekr"

    # * finance_bench
    # collection_dir = "/root/autodl-tmp/RAG_Agent_data/finance_bench/pdfs_filtered_processed_final_meta_wo_table"
    # collection_name = "financebench"

    # * finder
    # collection_dir = "/root/autodl-tmp/RAG_Agent_data/finder/final_base_jsons_wo_table"
    # collection_name = "finder"

    # * secque
    # collection_dir = "/root/autodl-tmp/RAG_Agent_data/secque/final_pdf/base_final"
    # collection_name = "secque"

    # * nvidia
    collection_dir = "/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/3_base_final"
    collection_name = "nvidia"

    BATCH_SIZE = 100
    
    logger.info(f"Importing collection {collection_name} from {collection_dir}.")

    rag.create_collection(collection_name)

    import_collection_from_dir(rag, collection_name, collection_dir, BATCH_SIZE,  ignore_range=False)

    # Get all documents from the collection
    documents = rag.get_collection_documents(collection_name)
    
    # Create BM25 index directory
    bm25_save_dir = os.path.join(config['persist_directory'], "bm25_index", collection_name)
    
    # Save BM25 index
    load_from_chroma_and_save(documents, bm25_save_dir)
