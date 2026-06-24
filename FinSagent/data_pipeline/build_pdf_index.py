#!/usr/bin/env python3
"""
Build a sqlite index of PDFs -> doc_id mappings.

Scans a given raw_pdf directory, queries Chroma's sqlite embedding_metadata
to find the `doc_id` associated with each filename, and writes rows into
data_pipeline/pdf_index.sqlite3 with columns: filename, filepath, doc_id, added_at.

Exits with non-zero status if any file cannot be confidently matched.
"""
import os
import sys
import sqlite3
import datetime
import yaml


def load_config():
    here = os.path.dirname(os.path.dirname(__file__))
    cfg_path = os.path.join(here, 'config', 'production.yaml')
    if not os.path.exists(cfg_path):
        raise FileNotFoundError(f"config not found: {cfg_path}")
    with open(cfg_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def find_doc_id(chroma_conn, filename):
    """Try multiple strategies to find a doc_id for given filename.

    Returns doc_id string or None if not found.
    """
    cur = chroma_conn.cursor()
    # Candidate keys that may hold filename in embedding_metadata
    filename_keys = ("filename", "file_name", "source", "source_id", "chroma:document")

    # 1) exact match for filename under any of those keys (case-sensitive)
    q = f"SELECT em_doc.string_value FROM embedding_metadata em_doc JOIN embedding_metadata em_file ON em_doc.id=em_file.id WHERE em_doc.key='doc_id' AND em_file.key IN ({','.join(['?']*len(filename_keys))}) AND em_file.string_value = ? LIMIT 1"
    params = list(filename_keys) + [filename]
    cur.execute(q, params)
    r = cur.fetchone()
    if r:
        return r[0]

    base = os.path.splitext(filename)[0]

    # 2) try filename without extension or with common alternative extension (.json)
    for candidate in (base, base + '.json'):
        q2 = f"SELECT em_doc.string_value FROM embedding_metadata em_doc JOIN embedding_metadata em_file ON em_doc.id=em_file.id WHERE em_doc.key='doc_id' AND em_file.key IN ({','.join(['?']*len(filename_keys))}) AND LOWER(em_file.string_value) = LOWER(?) LIMIT 1"
        params2 = list(filename_keys) + [candidate]
        cur.execute(q2, params2)
        r = cur.fetchone()
        if r:
            return r[0]

    # 3) try LIKE (starts with base) case-insensitive, ensure unique
    q3 = f"SELECT em_doc.string_value, em_file.string_value FROM embedding_metadata em_doc JOIN embedding_metadata em_file ON em_doc.id=em_file.id WHERE em_doc.key='doc_id' AND em_file.key IN ({','.join(['?']*len(filename_keys))}) AND LOWER(em_file.string_value) LIKE LOWER(?) LIMIT 50"
    params3 = list(filename_keys) + [base + '%']
    cur.execute(q3, params3)
    rows = cur.fetchall()
    if len(rows) == 1:
        return rows[0][0]

    # 4) check basename equality among candidates
    if rows:
        for docid, fv in rows:
            if fv and os.path.splitext(os.path.basename(fv))[0].lower() == base.lower():
                return docid

    # 5) broader contains search: if exactly one embedding_metadata row contains base, accept
    q4 = "SELECT em_doc.string_value, em_file.string_value FROM embedding_metadata em_doc JOIN embedding_metadata em_file ON em_doc.id=em_file.id WHERE em_doc.key='doc_id' AND em_file.key IN ({}) AND LOWER(em_file.string_value) LIKE LOWER(?) LIMIT 200".format(','.join(['?']*len(filename_keys)))
    cur.execute(q4, list(filename_keys) + ['%' + base + '%'])
    rows2 = cur.fetchall()
    if len(rows2) == 1:
        return rows2[0][0]

    # 6) try matching basename across all file values (scan some rows)
    q5 = f"SELECT em_doc.string_value, em_file.string_value FROM embedding_metadata em_doc JOIN embedding_metadata em_file ON em_doc.id=em_file.id WHERE em_doc.key='doc_id' AND em_file.key IN ({','.join(['?']*len(filename_keys))}) LIMIT 1000"
    cur.execute(q5, list(filename_keys))
    rows_all = cur.fetchall()
    matches = []
    for docid, fv in rows_all:
        if fv and os.path.splitext(os.path.basename(fv))[0].lower() == base.lower():
            matches.append(docid)
    if len(matches) == 1:
        return matches[0]

    return None


def main():
    config = load_config()
    persist = config.get('persist_directory')
    if not persist:
        print('persist_directory not set in config', file=sys.stderr)
        sys.exit(2)

    chroma_db = os.path.join(persist, 'chroma', 'chroma.sqlite3')
    if not os.path.exists(chroma_db):
        print('Chroma sqlite not found at', chroma_db, file=sys.stderr)
        sys.exit(2)

    # Directory with PDFs (user-specified)
    raw_pdf_dir = '/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/raw_pdf'
    if not os.path.isdir(raw_pdf_dir):
        print('raw_pdf_dir not found:', raw_pdf_dir, file=sys.stderr)
        sys.exit(2)

    # Target index sqlite
    target_db = os.path.join(os.path.dirname(__file__), 'pdf_index.sqlite3')
    print('Using chroma db:', chroma_db)
    print('Scanning pdf dir:', raw_pdf_dir)
    print('Writing index to:', target_db)

    chroma_conn = sqlite3.connect(chroma_db)
    target_conn = sqlite3.connect(target_db)

    try:
        tcur = target_conn.cursor()
        tcur.execute('''CREATE TABLE IF NOT EXISTS pdf_index (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            filepath TEXT NOT NULL,
            doc_id TEXT,
            added_at TEXT NOT NULL
        )''')
        tcur.execute('CREATE INDEX IF NOT EXISTS idx_pdf_docid ON pdf_index(doc_id)')
        target_conn.commit()

        missing = []
        inserted = 0

        for fn in sorted(os.listdir(raw_pdf_dir)):
            fp = os.path.join(raw_pdf_dir, fn)
            if not os.path.isfile(fp):
                continue
            # skip hidden
            if fn.startswith('.'):
                continue

            docid = find_doc_id(chroma_conn, fn)
            if docid is None:
                missing.append(fn)
                # Do NOT insert until all resolved (user required no mistakes)
                continue

            now = datetime.datetime.utcnow().isoformat() + 'Z'
            try:
                tcur.execute('INSERT OR REPLACE INTO pdf_index(filename, filepath, doc_id, added_at) VALUES(?,?,?,?)', (fn, fp, docid, now))
                inserted += 1
            except Exception as e:
                print('DB insert error', fn, e, file=sys.stderr)
                chroma_conn.close()
                target_conn.close()
                sys.exit(3)

        target_conn.commit()

        print(f'Inserted: {inserted} entries')
        if missing:
            print('Missing mappings for files (no doc_id found):')
            for m in missing:
                print(' -', m)
            print('\nBecause you requested strict mapping, no partial index was accepted.', file=sys.stderr)
            sys.exit(4)

        print('All PDFs indexed successfully.')
    finally:
        chroma_conn.close()
        target_conn.close()


if __name__ == '__main__':
    main()
