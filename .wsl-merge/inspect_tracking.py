import json
import sqlite3
from pathlib import Path

db = Path("/home/atchaolong/code/pravite_fund_ai_research/output/users/76f23b8e-91dc-440a-90d7-69dfd8a354cf/private_fund_datasets/300274/meta/collection.sqlite3")
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

queries = {
    "item_counts": """
        SELECT item_type, status, COUNT(*) AS count
        FROM research_items WHERE dataset_id='300274'
        GROUP BY item_type, status ORDER BY item_type, status
    """,
    "jobs": """
        SELECT job_type, status, COUNT(*) AS count, MAX(created_at) AS latest
        FROM research_tracking_jobs WHERE dataset_id='300274'
        GROUP BY job_type, status ORDER BY job_type, status
    """,
    "rules": """
        SELECT name, target_type, min_priority, frequency, active
        FROM research_watch_rules WHERE dataset_id='300274'
    """,
    "alerts": """
        SELECT status, priority, alert_type, COUNT(*) AS count
        FROM research_alerts WHERE dataset_id='300274'
        GROUP BY status, priority, alert_type ORDER BY status, priority
    """,
    "latest_items": """
        SELECT i.item_type, i.title, i.status, i.current_version_no,
               v.state, v.impact, v.confidence, v.expected_start, v.expected_end,
               v.observed_at, v.content
        FROM research_items i
        LEFT JOIN research_item_versions v ON v.item_version_id=i.current_version_id
        WHERE i.dataset_id='300274' AND i.item_type IN ('risk','catalyst')
        ORDER BY i.last_seen_at DESC LIMIT 12
    """,
    "latest_jobs": """
        SELECT job_type, source_id, status, attempt_count, last_error, created_at,
               finished_at, result_json
        FROM research_tracking_jobs WHERE dataset_id='300274'
        ORDER BY created_at DESC LIMIT 8
    """,
}

print(json.dumps({name: [dict(row) for row in conn.execute(sql)] for name, sql in queries.items()}, ensure_ascii=False, indent=2))
