import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "@private-fund/core";
import { isoNow, systemClock } from "@private-fund/core";

import { withTransaction } from "./transaction.js";

export interface ControlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = [
  {
    version: 1,
    name: "initial_control_schema",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        data_namespace TEXT NOT NULL UNIQUE,
        email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(id) BETWEEN 1 AND 320),
        CHECK (length(data_namespace) = 36)
      ) STRICT;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        company_name TEXT,
        ticker TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CHECK (length(id) BETWEEN 1 AND 160),
        CHECK (length(name) BETWEEN 1 AND 200),
        CHECK (company_name IS NULL OR length(company_name) <= 300),
        CHECK (ticker IS NULL OR length(ticker) <= 40)
      ) STRICT;
      CREATE INDEX projects_user_updated_idx
        ON projects(user_id, updated_at DESC, id);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        model TEXT,
        pi_session_file TEXT,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'running', 'interrupted', 'failed')),
        last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (id, user_id),
        FOREIGN KEY (project_id, user_id)
          REFERENCES projects(id, user_id) ON DELETE CASCADE,
        CHECK (length(id) BETWEEN 1 AND 160),
        CHECK (length(title) <= 300),
        CHECK (model IS NULL OR length(model) <= 200)
      ) STRICT;
      CREATE INDEX sessions_project_updated_idx
        ON sessions(user_id, project_id, updated_at DESC, id);

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
        idempotency_key TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, idempotency_key),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        CHECK (length(id) BETWEEN 1 AND 160),
        CHECK (length(kind) BETWEEN 1 AND 160),
        CHECK (length(idempotency_key) BETWEEN 1 AND 500)
      ) STRICT;
      CREATE INDEX operations_session_created_idx
        ON operations(session_id, created_at DESC, id);

      CREATE TABLE session_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        operation_id TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE SET NULL,
        CHECK (length(type) BETWEEN 1 AND 100)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX session_events_operation_idx
        ON session_events(operation_id)
        WHERE operation_id IS NOT NULL;

      CREATE TRIGGER session_events_require_next_sequence
      BEFORE INSERT ON session_events
      FOR EACH ROW
      WHEN NEW.sequence != (
        SELECT last_sequence + 1 FROM sessions WHERE id = NEW.session_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_event_sequence_mismatch');
      END;

      CREATE TRIGGER session_events_advance_sequence
      AFTER INSERT ON session_events
      FOR EACH ROW
      BEGIN
        UPDATE sessions
        SET last_sequence = NEW.sequence,
            updated_at = MAX(updated_at, NEW.timestamp)
        WHERE id = NEW.session_id;
      END;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        tenant_namespace TEXT NOT NULL,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        idempotency_key TEXT NOT NULL,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        UNIQUE (tenant_namespace, project_id, type, idempotency_key),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK (length(id) BETWEEN 1 AND 160),
        CHECK (length(tenant_namespace) = 36),
        CHECK (type IN (
          'document.ingest',
          'memo.generate',
          'report.generate',
          'tracking.scan',
          'valuation.extract',
          'valuation.compare',
          'valuation.derive',
          'market.refresh',
          'obsidian.project'
        )),
        CHECK (length(idempotency_key) BETWEEN 1 AND 500),
        CHECK (
          (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR
          (status != 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        )
      ) STRICT;
      CREATE INDEX jobs_claim_idx
        ON jobs(status, available_at, lease_expires_at, created_at);
      CREATE INDEX jobs_tenant_project_idx
        ON jobs(tenant_namespace, project_id, created_at DESC);

      CREATE TRIGGER jobs_require_matching_tenant_insert
      BEFORE INSERT ON jobs
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM projects AS p
        JOIN users AS u ON u.id = p.user_id
        WHERE p.id = NEW.project_id
          AND u.data_namespace = NEW.tenant_namespace
      )
      BEGIN
        SELECT RAISE(ABORT, 'tenant_project_mismatch');
      END;

      CREATE TRIGGER jobs_require_matching_tenant_update
      BEFORE UPDATE OF tenant_namespace, project_id ON jobs
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM projects AS p
        JOIN users AS u ON u.id = p.user_id
        WHERE p.id = NEW.project_id
          AND u.data_namespace = NEW.tenant_namespace
      )
      BEGIN
        SELECT RAISE(ABORT, 'tenant_project_mismatch');
      END;
    `,
  },
  {
    version: 2,
    name: "session_lifecycle_and_forks",
    sql: `
      ALTER TABLE sessions ADD COLUMN archived_at TEXT;
      ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
      ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT;

      CREATE INDEX sessions_tenant_lifecycle_idx
        ON sessions(user_id, deleted_at, archived_at, updated_at DESC, id);
      CREATE INDEX sessions_fork_source_idx
        ON sessions(forked_from_session_id)
        WHERE forked_from_session_id IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: "tenant_safe_global_uploads",
    sql: `
      CREATE TABLE upload_batches (
        id TEXT PRIMARY KEY,
        tenant_namespace TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued',
            'identifying',
            'routing',
            'indexing',
            'needs_review',
            'completed',
            'completed_with_errors',
            'failed'
          )),
        file_count INTEGER NOT NULL DEFAULT 0
          CHECK (file_count BETWEEN 0 AND 1000),
        message TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (id, tenant_namespace),
        UNIQUE (tenant_namespace, idempotency_key),
        FOREIGN KEY (tenant_namespace)
          REFERENCES users(data_namespace) ON DELETE CASCADE,
        CHECK (
          length(id) = 36
          AND substr(id, 1, 4) = 'upb_'
          AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (length(tenant_namespace) = 36),
        CHECK (length(message) <= 4000),
        CHECK (length(idempotency_key) BETWEEN 1 AND 500),
        CHECK (
          length(request_hash) = 64
          AND request_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          (
            status IN ('completed', 'completed_with_errors', 'failed')
            AND finished_at IS NOT NULL
          )
          OR
          (
            status NOT IN ('completed', 'completed_with_errors', 'failed')
            AND finished_at IS NULL
          )
        )
      ) STRICT;
      CREATE INDEX upload_batches_tenant_updated_idx
        ON upload_batches(
          tenant_namespace,
          updated_at DESC,
          created_at DESC,
          id
        );
      CREATE INDEX upload_batches_tenant_status_idx
        ON upload_batches(
          tenant_namespace,
          status,
          updated_at DESC,
          id
        );

      CREATE TRIGGER upload_batches_immutable_identity
      BEFORE UPDATE OF
        id,
        tenant_namespace,
        idempotency_key,
        request_hash,
        created_at
      ON upload_batches
      FOR EACH ROW
      WHEN
        NEW.id IS NOT OLD.id
        OR NEW.tenant_namespace IS NOT OLD.tenant_namespace
        OR NEW.idempotency_key IS NOT OLD.idempotency_key
        OR NEW.request_hash IS NOT OLD.request_hash
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'upload_batch_identity_is_immutable');
      END;

      CREATE TRIGGER upload_batches_require_valid_status_transition
      BEFORE UPDATE OF status ON upload_batches
      FOR EACH ROW
      WHEN OLD.status <> NEW.status
        AND NOT (
          (OLD.status = 'queued'
            AND NEW.status IN ('identifying', 'failed'))
          OR
          (OLD.status = 'identifying'
            AND NEW.status IN (
              'routing',
              'needs_review',
              'completed_with_errors',
              'failed'
            ))
          OR
          (OLD.status = 'routing'
            AND NEW.status IN (
              'indexing',
              'needs_review',
              'completed_with_errors',
              'failed'
            ))
          OR
          (OLD.status = 'indexing'
            AND NEW.status IN (
              'needs_review',
              'completed',
              'completed_with_errors',
              'failed'
            ))
          OR
          (OLD.status = 'needs_review'
            AND NEW.status IN (
              'routing',
              'indexing',
              'completed_with_errors',
              'failed'
            ))
          OR
          (OLD.status = 'completed_with_errors'
            AND NEW.status IN ('routing', 'indexing'))
          OR
          (OLD.status = 'failed'
            AND NEW.status IN ('identifying', 'routing'))
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_upload_batch_status_transition');
      END;

      CREATE TABLE upload_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        tenant_namespace TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        staged_relative_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploaded'
          CHECK (status IN (
            'uploaded',
            'identifying',
            'needs_review',
            'routing',
            'routed',
            'indexing',
            'completed',
            'completed_with_warnings',
            'duplicate',
            'failed'
          )),
        company_name TEXT,
        ticker TEXT,
        company_confidence REAL NOT NULL DEFAULT 0,
        company_detection_method TEXT,
        target_project_id TEXT,
        route_confidence REAL NOT NULL DEFAULT 0,
        route_method TEXT,
        candidate_projects_json TEXT NOT NULL DEFAULT '[]',
        pipeline_job_id TEXT,
        document_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (id, tenant_namespace),
        UNIQUE (
          tenant_namespace,
          batch_id,
          staged_relative_path
        ),
        FOREIGN KEY (batch_id, tenant_namespace)
          REFERENCES upload_batches(id, tenant_namespace)
          ON DELETE CASCADE,
        FOREIGN KEY (target_project_id)
          REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY (pipeline_job_id)
          REFERENCES jobs(id) ON DELETE SET NULL,
        CHECK (
          length(id) = 36
          AND substr(id, 1, 4) = 'upi_'
          AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (length(tenant_namespace) = 36),
        CHECK (
          length(original_filename) BETWEEN 1 AND 1000
          AND original_filename NOT IN ('.', '..')
          AND instr(original_filename, '/') = 0
          AND instr(original_filename, char(92)) = 0
          AND instr(original_filename, char(0)) = 0
        ),
        CHECK (
          length(staged_relative_path) BETWEEN 1 AND 4000
          AND staged_relative_path NOT GLOB '*[^A-Za-z0-9._/-]*'
          AND substr(staged_relative_path, 1, 1) <> '/'
          AND substr(staged_relative_path, -1, 1) <> '/'
          AND instr(staged_relative_path, '//') = 0
          AND instr(staged_relative_path, char(92)) = 0
          AND staged_relative_path NOT IN ('.', '..')
          AND staged_relative_path NOT LIKE './%'
          AND staged_relative_path NOT LIKE '../%'
          AND staged_relative_path NOT LIKE '%/.'
          AND staged_relative_path NOT LIKE '%/..'
          AND staged_relative_path NOT LIKE '%/./%'
          AND staged_relative_path NOT LIKE '%/../%'
        ),
        CHECK (
          length(file_type) BETWEEN 1 AND 100
          AND file_type NOT GLOB '*[^a-z0-9.+_-]*'
        ),
        CHECK (length(mime_type) BETWEEN 1 AND 300),
        CHECK (file_size BETWEEN 1 AND 268435456),
        CHECK (
          length(sha256) = 64
          AND sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          company_name IS NULL OR length(company_name) <= 300
        ),
        CHECK (ticker IS NULL OR length(ticker) <= 40),
        CHECK (
          company_confidence >= 0 AND company_confidence <= 1
        ),
        CHECK (
          company_detection_method IS NULL
          OR length(company_detection_method) <= 160
        ),
        CHECK (route_confidence >= 0 AND route_confidence <= 1),
        CHECK (
          route_method IS NULL OR length(route_method) <= 160
        ),
        CHECK (
          json_valid(candidate_projects_json)
          AND json_type(candidate_projects_json) = 'array'
          AND json_array_length(candidate_projects_json) <= 100
        ),
        CHECK (
          error_message IS NULL OR length(error_message) <= 20000
        ),
        CHECK (
          status <> 'failed'
          OR (
            error_message IS NOT NULL
            AND length(trim(error_message)) > 0
          )
        ),
        CHECK (
          status NOT IN (
            'routing',
            'routed',
            'indexing',
            'completed',
            'completed_with_warnings',
            'duplicate'
          )
          OR target_project_id IS NOT NULL
        ),
        CHECK (
          (
            status IN (
              'completed',
              'completed_with_warnings',
              'duplicate',
              'failed'
            )
            AND finished_at IS NOT NULL
          )
          OR
          (
            status NOT IN (
              'completed',
              'completed_with_warnings',
              'duplicate',
              'failed'
            )
            AND finished_at IS NULL
          )
        )
      ) STRICT;
      CREATE INDEX upload_items_batch_created_idx
        ON upload_items(
          tenant_namespace,
          batch_id,
          created_at,
          id
        );
      CREATE INDEX upload_items_tenant_status_idx
        ON upload_items(
          tenant_namespace,
          status,
          updated_at DESC,
          id
        );
      CREATE INDEX upload_items_tenant_project_idx
        ON upload_items(
          tenant_namespace,
          target_project_id,
          updated_at DESC,
          id
        )
        WHERE target_project_id IS NOT NULL;
      CREATE INDEX upload_items_tenant_sha_idx
        ON upload_items(tenant_namespace, sha256, created_at DESC);

      CREATE TRIGGER upload_items_enforce_batch_limits
      BEFORE INSERT ON upload_items
      FOR EACH ROW
      WHEN
        (
          SELECT count(*)
          FROM upload_items
          WHERE batch_id = NEW.batch_id
            AND tenant_namespace = NEW.tenant_namespace
        ) >= 1000
        OR
        (
          SELECT coalesce(sum(file_size), 0)
          FROM upload_items
          WHERE batch_id = NEW.batch_id
            AND tenant_namespace = NEW.tenant_namespace
        ) + NEW.file_size > 1073741824
      BEGIN
        SELECT RAISE(ABORT, 'upload_batch_limit_exceeded');
      END;

      CREATE TRIGGER upload_items_increment_batch_count
      AFTER INSERT ON upload_items
      FOR EACH ROW
      BEGIN
        UPDATE upload_batches
        SET file_count = file_count + 1,
            updated_at = max(updated_at, NEW.created_at)
        WHERE id = NEW.batch_id
          AND tenant_namespace = NEW.tenant_namespace;
      END;

      CREATE TRIGGER upload_items_decrement_batch_count
      AFTER DELETE ON upload_items
      FOR EACH ROW
      BEGIN
        UPDATE upload_batches
        SET file_count = file_count - 1,
            updated_at = max(updated_at, OLD.updated_at)
        WHERE id = OLD.batch_id
          AND tenant_namespace = OLD.tenant_namespace;
      END;

      CREATE TRIGGER upload_items_immutable_file_identity
      BEFORE UPDATE OF
        id,
        batch_id,
        tenant_namespace,
        original_filename,
        staged_relative_path,
        file_type,
        mime_type,
        file_size,
        sha256,
        created_at
      ON upload_items
      FOR EACH ROW
      WHEN
        NEW.id IS NOT OLD.id
        OR NEW.batch_id IS NOT OLD.batch_id
        OR NEW.tenant_namespace IS NOT OLD.tenant_namespace
        OR NEW.original_filename IS NOT OLD.original_filename
        OR NEW.staged_relative_path IS NOT OLD.staged_relative_path
        OR NEW.file_type IS NOT OLD.file_type
        OR NEW.mime_type IS NOT OLD.mime_type
        OR NEW.file_size IS NOT OLD.file_size
        OR NEW.sha256 IS NOT OLD.sha256
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'upload_item_file_identity_is_immutable');
      END;

      CREATE TRIGGER upload_items_require_valid_status_transition
      BEFORE UPDATE OF status ON upload_items
      FOR EACH ROW
      WHEN OLD.status <> NEW.status
        AND NOT (
          (OLD.status = 'uploaded'
            AND NEW.status IN ('identifying', 'failed'))
          OR
          (OLD.status = 'identifying'
            AND NEW.status IN ('needs_review', 'routing', 'failed'))
          OR
          (OLD.status = 'needs_review'
            AND NEW.status IN ('routing', 'failed'))
          OR
          (OLD.status = 'routing'
            AND NEW.status IN (
              'routed',
              'indexing',
              'needs_review',
              'duplicate',
              'failed'
            ))
          OR
          (OLD.status = 'routed'
            AND NEW.status IN (
              'indexing',
              'needs_review',
              'duplicate',
              'failed'
            ))
          OR
          (OLD.status = 'indexing'
            AND NEW.status IN (
              'completed',
              'completed_with_warnings',
              'needs_review',
              'failed'
            ))
          OR
          (OLD.status = 'failed'
            AND NEW.status IN ('identifying', 'routing'))
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_upload_item_status_transition');
      END;

      CREATE TRIGGER upload_items_require_matching_project_insert
      BEFORE INSERT ON upload_items
      FOR EACH ROW
      WHEN NEW.target_project_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projects AS p
          JOIN users AS u ON u.id = p.user_id
          WHERE p.id = NEW.target_project_id
            AND u.data_namespace = NEW.tenant_namespace
        )
      BEGIN
        SELECT RAISE(ABORT, 'upload_project_tenant_mismatch');
      END;

      CREATE TRIGGER upload_items_require_matching_project_update
      BEFORE UPDATE OF target_project_id, tenant_namespace ON upload_items
      FOR EACH ROW
      WHEN NEW.target_project_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projects AS p
          JOIN users AS u ON u.id = p.user_id
          WHERE p.id = NEW.target_project_id
            AND u.data_namespace = NEW.tenant_namespace
        )
      BEGIN
        SELECT RAISE(ABORT, 'upload_project_tenant_mismatch');
      END;

      CREATE TRIGGER upload_items_require_candidate_projects_insert
      BEFORE INSERT ON upload_items
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.candidate_projects_json) AS candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM projects AS p
          JOIN users AS u ON u.id = p.user_id
          WHERE p.id = json_extract(candidate.value, '$.projectId')
            AND u.data_namespace = NEW.tenant_namespace
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'upload_candidate_project_tenant_mismatch');
      END;

      CREATE TRIGGER upload_items_require_candidate_projects_update
      BEFORE UPDATE OF candidate_projects_json, tenant_namespace
      ON upload_items
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.candidate_projects_json) AS candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM projects AS p
          JOIN users AS u ON u.id = p.user_id
          WHERE p.id = json_extract(candidate.value, '$.projectId')
            AND u.data_namespace = NEW.tenant_namespace
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'upload_candidate_project_tenant_mismatch');
      END;

      CREATE TRIGGER upload_items_require_matching_job_insert
      BEFORE INSERT ON upload_items
      FOR EACH ROW
      WHEN NEW.pipeline_job_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM jobs AS j
          WHERE j.id = NEW.pipeline_job_id
            AND j.tenant_namespace = NEW.tenant_namespace
            AND NEW.target_project_id IS NOT NULL
            AND j.project_id = NEW.target_project_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'upload_job_scope_mismatch');
      END;

      CREATE TRIGGER upload_items_require_matching_job_update
      BEFORE UPDATE OF
        pipeline_job_id,
        target_project_id,
        tenant_namespace
      ON upload_items
      FOR EACH ROW
      WHEN NEW.pipeline_job_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM jobs AS j
          WHERE j.id = NEW.pipeline_job_id
            AND j.tenant_namespace = NEW.tenant_namespace
            AND NEW.target_project_id IS NOT NULL
            AND j.project_id = NEW.target_project_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'upload_job_scope_mismatch');
      END;

      CREATE TABLE upload_audit_events (
        id TEXT PRIMARY KEY,
        tenant_namespace TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        item_id TEXT,
        action TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        project_id TEXT,
        actor_id TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_namespace, action, idempotency_key),
        FOREIGN KEY (batch_id, tenant_namespace)
          REFERENCES upload_batches(id, tenant_namespace)
          ON DELETE CASCADE,
        FOREIGN KEY (item_id, tenant_namespace)
          REFERENCES upload_items(id, tenant_namespace)
          ON DELETE CASCADE,
        CHECK (
          length(id) = 36
          AND substr(id, 1, 4) = 'upa_'
          AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (length(tenant_namespace) = 36),
        CHECK (length(action) BETWEEN 1 AND 120),
        CHECK (from_status IS NULL OR length(from_status) <= 80),
        CHECK (to_status IS NULL OR length(to_status) <= 80),
        CHECK (actor_id IS NULL OR length(actor_id) <= 320),
        CHECK (length(idempotency_key) BETWEEN 1 AND 500),
        CHECK (
          length(request_hash) = 64
          AND request_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          json_valid(details_json)
          AND json_type(details_json) = 'object'
        )
      ) STRICT;
      CREATE INDEX upload_audit_events_tenant_created_idx
        ON upload_audit_events(
          tenant_namespace,
          created_at DESC,
          id
        );
      CREATE INDEX upload_audit_events_batch_created_idx
        ON upload_audit_events(
          tenant_namespace,
          batch_id,
          created_at,
          id
        );
      CREATE INDEX upload_audit_events_item_created_idx
        ON upload_audit_events(
          tenant_namespace,
          item_id,
          created_at,
          id
        )
        WHERE item_id IS NOT NULL;

      CREATE TRIGGER upload_audit_events_require_item_scope
      BEFORE INSERT ON upload_audit_events
      FOR EACH ROW
      WHEN NEW.item_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM upload_items
          WHERE id = NEW.item_id
            AND batch_id = NEW.batch_id
            AND tenant_namespace = NEW.tenant_namespace
        )
      BEGIN
        SELECT RAISE(ABORT, 'upload_audit_item_scope_mismatch');
      END;

      CREATE TRIGGER upload_audit_events_require_project_scope
      BEFORE INSERT ON upload_audit_events
      FOR EACH ROW
      WHEN NEW.project_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projects AS p
          JOIN users AS u ON u.id = p.user_id
          WHERE p.id = NEW.project_id
            AND u.data_namespace = NEW.tenant_namespace
        )
      BEGIN
        SELECT RAISE(ABORT, 'upload_audit_project_tenant_mismatch');
      END;

      CREATE TRIGGER upload_audit_events_are_immutable
      BEFORE UPDATE ON upload_audit_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'upload_audit_event_is_immutable');
      END;
    `,
  },
  {
    version: 4,
    name: "tenant_safe_session_resources",
    sql: `
      CREATE TABLE session_resources (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN (
            'attachment',
            'research_asset',
            'document_reference'
          )),
        lifecycle TEXT NOT NULL DEFAULT 'active'
          CHECK (lifecycle IN ('active', 'deleted')),
        name TEXT NOT NULL,
        reference_id TEXT,
        reference_version_id TEXT,
        relative_path TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by_user_id TEXT,
        UNIQUE (id, session_id),
        UNIQUE (relative_path),
        FOREIGN KEY (session_id)
          REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (deleted_by_user_id)
          REFERENCES users(id) ON DELETE RESTRICT,
        CHECK (
          length(id) = 41
          AND substr(id, 1, 9) = 'resource_'
          AND substr(id, 10) NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (length(name) BETWEEN 1 AND 500),
        CHECK (
          (lifecycle = 'active'
            AND deleted_at IS NULL
            AND deleted_by_user_id IS NULL)
          OR
          (lifecycle = 'deleted'
            AND deleted_at IS NOT NULL
            AND deleted_by_user_id IS NOT NULL)
        ),
        CHECK (
          (
            kind = 'attachment'
            AND reference_id IS NULL
            AND reference_version_id IS NULL
            AND relative_path IS NOT NULL
            AND length(relative_path) BETWEEN 1 AND 4000
            AND substr(relative_path, 1, 1) <> '/'
            AND instr(relative_path, char(92)) = 0
            AND instr(relative_path, '//') = 0
            AND relative_path NOT LIKE '../%'
            AND relative_path NOT LIKE '%/../%'
            AND relative_path NOT LIKE '%/..'
            AND relative_path NOT LIKE './%'
            AND relative_path NOT LIKE '%/./%'
            AND relative_path NOT LIKE '%/.'
            AND substr(
              relative_path,
              1,
              length('session-attachments/' || session_id || '/objects/')
            ) = 'session-attachments/' || session_id || '/objects/'
            AND substr(
              relative_path,
              length(
                'session-attachments/' || session_id || '/objects/'
              ) + 1,
              length(id) + 1
            ) = id || '.'
            AND instr(
              substr(
                relative_path,
                length(
                  'session-attachments/' || session_id || '/objects/'
                ) + 1
              ),
              '/'
            ) = 0
            AND mime_type IS NOT NULL
            AND length(mime_type) BETWEEN 1 AND 300
            AND size_bytes BETWEEN 1 AND 26214400
            AND sha256 IS NOT NULL
            AND length(sha256) = 64
            AND sha256 NOT GLOB '*[^0-9a-f]*'
          )
          OR
          (
            kind IN ('research_asset', 'document_reference')
            AND reference_id IS NOT NULL
            AND length(reference_id) BETWEEN 1 AND 160
            AND reference_version_id IS NOT NULL
            AND length(reference_version_id) BETWEEN 1 AND 160
            AND relative_path IS NULL
            AND mime_type IS NULL
            AND size_bytes IS NULL
            AND sha256 IS NULL
          )
        )
      ) STRICT;

      CREATE INDEX session_resources_session_lifecycle_idx
        ON session_resources(
          session_id,
          lifecycle,
          created_at DESC,
          id DESC
        );
      CREATE INDEX session_resources_session_kind_idx
        ON session_resources(
          session_id,
          kind,
          lifecycle,
          created_at DESC,
          id DESC
        );
      CREATE UNIQUE INDEX session_resources_active_reference_idx
        ON session_resources(
          session_id,
          kind,
          reference_id,
          reference_version_id
        )
        WHERE lifecycle = 'active'
          AND kind IN ('research_asset', 'document_reference');

      CREATE TRIGGER session_resources_require_active_session_insert
      BEFORE INSERT ON session_resources
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM sessions
        WHERE id = NEW.session_id
          AND deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_resource_session_not_active');
      END;

      CREATE TRIGGER session_resources_payload_is_immutable
      BEFORE UPDATE OF
        id,
        session_id,
        kind,
        name,
        reference_id,
        reference_version_id,
        relative_path,
        mime_type,
        size_bytes,
        sha256,
        created_at
      ON session_resources
      FOR EACH ROW
      WHEN
        NEW.id IS NOT OLD.id
        OR NEW.session_id IS NOT OLD.session_id
        OR NEW.kind IS NOT OLD.kind
        OR NEW.name IS NOT OLD.name
        OR NEW.reference_id IS NOT OLD.reference_id
        OR NEW.reference_version_id IS NOT OLD.reference_version_id
        OR NEW.relative_path IS NOT OLD.relative_path
        OR NEW.mime_type IS NOT OLD.mime_type
        OR NEW.size_bytes IS NOT OLD.size_bytes
        OR NEW.sha256 IS NOT OLD.sha256
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'session_resource_payload_is_immutable');
      END;

      CREATE TRIGGER session_resources_only_allow_soft_delete
      BEFORE UPDATE OF lifecycle ON session_resources
      FOR EACH ROW
      WHEN OLD.lifecycle <> NEW.lifecycle
        AND NOT (
          OLD.lifecycle = 'active'
          AND NEW.lifecycle = 'deleted'
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_session_resource_lifecycle_transition');
      END;

      CREATE TRIGGER session_resources_require_tenant_deleter
      BEFORE UPDATE OF
        lifecycle,
        deleted_at,
        deleted_by_user_id
      ON session_resources
      FOR EACH ROW
      WHEN NEW.lifecycle = 'deleted'
        AND NOT EXISTS (
          SELECT 1
          FROM sessions AS s
          WHERE s.id = NEW.session_id
            AND s.user_id = NEW.deleted_by_user_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'session_resource_deleter_tenant_mismatch');
      END;
    `,
  },
  {
    version: 5,
    name: "tenant_safe_session_fork_lineage",
    sql: `
      CREATE TRIGGER sessions_require_valid_fork_source_insert
      BEFORE INSERT ON sessions
      FOR EACH ROW
      WHEN NEW.forked_from_session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sessions AS parent
          WHERE parent.id = NEW.forked_from_session_id
            AND parent.user_id = NEW.user_id
            AND parent.project_id = NEW.project_id
            AND parent.deleted_at IS NULL
        )
      BEGIN
        SELECT RAISE(ABORT, 'session_fork_source_mismatch');
      END;

      CREATE TRIGGER sessions_fork_lineage_is_immutable
      BEFORE UPDATE OF
        user_id,
        project_id,
        forked_from_session_id
      ON sessions
      FOR EACH ROW
      WHEN
        NEW.user_id IS NOT OLD.user_id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.forked_from_session_id IS NOT OLD.forked_from_session_id
      BEGIN
        SELECT RAISE(ABORT, 'session_fork_lineage_is_immutable');
      END;
    `,
  },
  {
    version: 6,
    name: "legacy_business_job_reconciliation",
    sql: `
      CREATE TABLE legacy_business_job_reconciliation (
        reconciliation_id TEXT PRIMARY KEY,
        tenant_namespace TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        legacy_table TEXT NOT NULL CHECK (
          legacy_table IN (
            'research_equity_report_runs',
            'research_tracking_jobs',
            'valuation_tracking_jobs'
          )
        ),
        legacy_row_id TEXT NOT NULL,
        legacy_status TEXT NOT NULL,
        legacy_type TEXT NOT NULL,
        legacy_row_sha256 TEXT NOT NULL,
        legacy_row_json TEXT NOT NULL CHECK (
          json_valid(legacy_row_json)
          AND json_type(legacy_row_json) = 'object'
        ),
        target_job_type TEXT CHECK (
          target_job_type IS NULL
          OR target_job_type IN (
            'document.ingest',
            'memo.generate',
            'report.generate',
            'tracking.scan',
            'valuation.extract',
            'valuation.compare',
            'valuation.derive',
            'market.refresh',
            'obsidian.project'
          )
        ),
        canonical_job_id TEXT,
        canonical_job_immutable_sha256 TEXT,
        disposition TEXT NOT NULL CHECK (
          disposition IN ('mapped', 'audited')
        ),
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        reconciled_at TEXT NOT NULL,
        UNIQUE (
          tenant_namespace,
          project_id,
          legacy_table,
          legacy_row_id
        ),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (canonical_job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        CHECK (
          length(reconciliation_id) BETWEEN 1 AND 160
          AND length(tenant_namespace) = 36
          AND length(source_fingerprint) = 64
          AND length(legacy_row_id) BETWEEN 1 AND 500
          AND length(legacy_status) BETWEEN 1 AND 100
          AND length(legacy_type) BETWEEN 1 AND 160
          AND length(legacy_row_sha256) = 64
          AND length(reason_code) BETWEEN 1 AND 100
          AND length(reason) BETWEEN 1 AND 4000
        ),
        CHECK (
          (
            disposition = 'mapped'
            AND target_job_type IS NOT NULL
            AND canonical_job_id IS NOT NULL
            AND length(canonical_job_immutable_sha256) = 64
          )
          OR
          (
            disposition = 'audited'
            AND canonical_job_id IS NULL
            AND canonical_job_immutable_sha256 IS NULL
          )
        )
      ) STRICT;

      CREATE INDEX legacy_business_job_reconciliation_source_idx
        ON legacy_business_job_reconciliation(
          tenant_namespace,
          project_id,
          source_fingerprint,
          legacy_table,
          legacy_row_id
        );
      CREATE INDEX legacy_business_job_reconciliation_job_idx
        ON legacy_business_job_reconciliation(canonical_job_id)
        WHERE canonical_job_id IS NOT NULL;

      CREATE TRIGGER legacy_business_job_reconciliation_require_scope_insert
      BEFORE INSERT ON legacy_business_job_reconciliation
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM projects AS p
        JOIN users AS u ON u.id = p.user_id
        WHERE p.id = NEW.project_id
          AND u.data_namespace = NEW.tenant_namespace
      )
      BEGIN
        SELECT RAISE(ABORT, 'tenant_project_mismatch');
      END;

      CREATE TRIGGER legacy_business_job_reconciliation_is_immutable
      BEFORE UPDATE ON legacy_business_job_reconciliation
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'legacy_business_job_reconciliation_is_immutable');
      END;
    `,
  },
  {
    version: 7,
    name: "recoverable_project_tombstones",
    sql: `
      ALTER TABLE projects ADD COLUMN deleted_at TEXT;
      ALTER TABLE projects ADD COLUMN retained_until TEXT;

      CREATE INDEX projects_user_lifecycle_idx
        ON projects(
          user_id,
          deleted_at,
          updated_at DESC,
          id
        );
      CREATE INDEX projects_retention_idx
        ON projects(retained_until, id)
        WHERE deleted_at IS NOT NULL;

      CREATE TRIGGER projects_require_valid_tombstone_insert
      BEFORE INSERT ON projects
      FOR EACH ROW
      WHEN
        (NEW.deleted_at IS NULL) <> (NEW.retained_until IS NULL)
        OR (
          NEW.deleted_at IS NOT NULL
          AND NEW.retained_until <= NEW.deleted_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_project_tombstone');
      END;

      CREATE TRIGGER projects_require_valid_tombstone_update
      BEFORE UPDATE OF deleted_at, retained_until ON projects
      FOR EACH ROW
      WHEN
        (NEW.deleted_at IS NULL) <> (NEW.retained_until IS NULL)
        OR (
          NEW.deleted_at IS NOT NULL
          AND NEW.retained_until <= NEW.deleted_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_project_tombstone');
      END;

      CREATE TRIGGER projects_prevent_physical_delete
      BEFORE DELETE ON projects
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'project_physical_delete_forbidden');
      END;

      CREATE TABLE project_lifecycle_events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('tombstoned', 'restored')),
        deleted_at TEXT NOT NULL,
        retained_until TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (event_id, user_id),
        FOREIGN KEY (project_id, user_id)
          REFERENCES projects(id, user_id) ON DELETE RESTRICT,
        CHECK (length(event_id) BETWEEN 1 AND 160),
        CHECK (retained_until > deleted_at)
      ) STRICT;
      CREATE INDEX project_lifecycle_events_project_idx
        ON project_lifecycle_events(
          user_id,
          project_id,
          occurred_at,
          event_id
        );

      CREATE TRIGGER project_lifecycle_events_are_immutable
      BEFORE UPDATE ON project_lifecycle_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'project_lifecycle_event_is_immutable');
      END;

      CREATE TRIGGER project_lifecycle_events_cannot_be_deleted
      BEFORE DELETE ON project_lifecycle_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'project_lifecycle_event_is_immutable');
      END;

      DROP TRIGGER jobs_require_matching_tenant_insert;
      CREATE TRIGGER jobs_require_matching_tenant_insert
      BEFORE INSERT ON jobs
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM projects AS p
        JOIN users AS u ON u.id = p.user_id
        WHERE p.id = NEW.project_id
          AND u.data_namespace = NEW.tenant_namespace
          AND p.deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'tenant_project_mismatch');
      END;

      DROP TRIGGER jobs_require_matching_tenant_update;
      CREATE TRIGGER jobs_require_matching_tenant_update
      BEFORE UPDATE OF tenant_namespace, project_id ON jobs
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM projects AS p
        JOIN users AS u ON u.id = p.user_id
        WHERE p.id = NEW.project_id
          AND u.data_namespace = NEW.tenant_namespace
          AND p.deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'tenant_project_mismatch');
      END;

      CREATE TRIGGER sessions_require_live_project_insert
      BEFORE INSERT ON sessions
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM projects AS p
        WHERE p.id = NEW.project_id
          AND p.user_id = NEW.user_id
          AND p.deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_project_not_active');
      END;
    `,
  },
  {
    version: 8,
    name: "append_only_session_journal",
    sql: `
      CREATE TABLE session_journal_heads (
        session_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
        last_event_hash TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
        CHECK (
          last_event_hash IS NULL
          OR (
            length(last_event_hash) = 64
            AND last_event_hash NOT GLOB '*[^0-9a-f]*'
          )
        ),
        CHECK (
          (last_sequence = 0 AND last_event_hash IS NULL)
          OR (last_sequence > 0 AND last_event_hash IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE session_journal_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        operation_id TEXT,
        turn_id TEXT,
        step_id TEXT,
        source_kind TEXT NOT NULL CHECK (source_kind IN (
          'user',
          'system',
          'agent',
          'model',
          'tool',
          'subagent',
          'context',
          'runtime',
          'migration'
        )),
        source_id TEXT,
        source_version TEXT,
        causation_event_id TEXT,
        idempotency_key TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN (
          'public',
          'internal',
          'confidential',
          'restricted'
        )),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        blob_references_json TEXT NOT NULL CHECK (json_valid(blob_references_json)),
        payload_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        UNIQUE (session_id, event_id),
        UNIQUE (session_id, idempotency_key),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
        FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
        FOREIGN KEY (session_id, causation_event_id)
          REFERENCES session_journal_events(session_id, event_id)
          ON DELETE RESTRICT,
        CHECK (length(event_id) BETWEEN 1 AND 160),
        CHECK (length(type) BETWEEN 1 AND 100),
        CHECK (length(idempotency_key) BETWEEN 1 AND 160),
        CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 160),
        CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 200),
        CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (
          previous_hash IS NULL
          OR (
            length(previous_hash) = 64
            AND previous_hash NOT GLOB '*[^0-9a-f]*'
          )
        )
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX session_journal_events_operation_idx
        ON session_journal_events(session_id, operation_id, sequence)
        WHERE operation_id IS NOT NULL;
      CREATE INDEX session_journal_events_source_idx
        ON session_journal_events(session_id, source_kind, sequence);

      CREATE TABLE session_journal_outbox (
        outbox_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        UNIQUE (session_id, sequence),
        UNIQUE (session_id, event_id),
        FOREIGN KEY (session_id, sequence)
          REFERENCES session_journal_events(session_id, sequence)
          ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX session_journal_outbox_pending_idx
        ON session_journal_outbox(delivered_at, outbox_id)
        WHERE delivered_at IS NULL;

      CREATE TRIGGER session_journal_events_require_head
      BEFORE INSERT ON session_journal_events
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1 FROM session_journal_heads WHERE session_id = NEW.session_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_journal_head_missing');
      END;

      CREATE TRIGGER session_journal_events_require_next_sequence
      BEFORE INSERT ON session_journal_events
      FOR EACH ROW
      WHEN NEW.sequence != (
        SELECT last_sequence + 1
        FROM session_journal_heads
        WHERE session_id = NEW.session_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_journal_sequence_mismatch');
      END;

      CREATE TRIGGER session_journal_events_require_previous_hash
      BEFORE INSERT ON session_journal_events
      FOR EACH ROW
      WHEN NEW.previous_hash IS NOT (
        SELECT last_event_hash
        FROM session_journal_heads
        WHERE session_id = NEW.session_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_journal_previous_hash_mismatch');
      END;

      CREATE TRIGGER session_journal_events_advance_head
      AFTER INSERT ON session_journal_events
      FOR EACH ROW
      BEGIN
        UPDATE session_journal_heads
        SET last_sequence = NEW.sequence,
            last_event_hash = NEW.event_hash,
            updated_at = NEW.timestamp
        WHERE session_id = NEW.session_id;
      END;

      CREATE TRIGGER session_journal_events_are_immutable
      BEFORE UPDATE ON session_journal_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'session_journal_event_is_immutable');
      END;

      CREATE TRIGGER session_journal_events_cannot_be_deleted
      BEFORE DELETE ON session_journal_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'session_journal_event_is_immutable');
      END;
    `,
  },
];

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

export function runMigrations(
  database: DatabaseSync,
  clock: Clock = systemClock,
): AppliedMigration[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all();
  const applied = new Map(
    appliedRows.map((row) => [Number(row.version), String(row.name)]),
  );
  const known = new Map(
    CONTROL_MIGRATIONS.map((migration) => [migration.version, migration.name]),
  );
  for (const [version, name] of applied) {
    const expectedName = known.get(version);
    if (expectedName === undefined) {
      throw new Error(
        `Database contains unknown migration ${String(version)} (${name})`,
      );
    }
    if (expectedName !== name) {
      throw new Error(
        `Migration ${String(version)} is recorded as ${name}, expected ${expectedName}`,
      );
    }
  }

  for (const migration of CONTROL_MIGRATIONS) {
    const existingName = applied.get(migration.version);
    if (existingName !== undefined) {
      if (existingName !== migration.name) {
        throw new Error(
          `Migration ${String(migration.version)} is recorded as ${existingName}, expected ${migration.name}`,
        );
      }
      continue;
    }

    withTransaction(database, () => {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations(version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, isoNow(clock));
    });
  }

  return database
    .prepare(
      `SELECT version, name, applied_at AS appliedAt
       FROM schema_migrations
       ORDER BY version`,
    )
    .all()
    .map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      appliedAt: String(row.appliedAt),
    }));
}
