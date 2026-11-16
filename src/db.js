'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * 单一模式版本：这是从零开始的项目，尚未有已部署库。
 * 未来变更应新增 migration，而不是改这里。
 */
const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('steward','reviewer','compliance','release','auditor')),
  title TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_release_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rulesets (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  rules_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS rulesets_one_active ON rulesets(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES skus(sku),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'building','build_failed','checking','check_failed','ready','published','retired'
  )),
  source TEXT NOT NULL,
  base_version_id TEXT REFERENCES versions(id),
  reason TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  data_hash TEXT,
  build_error_json TEXT,
  review_scope TEXT CHECK (review_scope IN ('full','targeted')),
  review_impact_json TEXT,
  review_serial INTEGER NOT NULL DEFAULT 0,
  current_check_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  built_at INTEGER,
  check_finished_at INTEGER,
  UNIQUE (sku, seq)
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL UNIQUE REFERENCES versions(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  ruleset_id TEXT NOT NULL REFERENCES rulesets(id),
  output_hash TEXT,
  error_json TEXT,
  log TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL REFERENCES builds(id),
  ruleset_id TEXT NOT NULL REFERENCES rulesets(id),
  rules_hash TEXT NOT NULL,
  data_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','error','stale')),
  engine_version TEXT NOT NULL,
  findings_json TEXT,
  findings_hash TEXT,
  domain_results_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS check_runs_by_build ON check_runs(build_id, started_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  sku TEXT NOT NULL,
  check_run_id TEXT NOT NULL REFERENCES check_runs(id),
  ruleset_id TEXT NOT NULL REFERENCES rulesets(id),
  rules_hash TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('full','targeted','reinstatement')),
  status TEXT NOT NULL CHECK (status IN ('approved','rejected','withdrawn','invalidated','expired')),
  reviewer_role TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  decided_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  carried_from_json TEXT,
  target_release_id TEXT REFERENCES releases(id),
  note TEXT,
  acknowledged_warnings INTEGER NOT NULL DEFAULT 0,
  invalidation_reason TEXT,
  invalidated_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_live_per_reviewer
  ON approvals(version_id, reviewer_id) WHERE status = 'approved';

-- 批准覆盖明细：review 为本人审阅，carry 为显式承继他人域级批准。
-- 每行都钉住该域在批准当时的输入指纹与检查结果指纹。
CREATE TABLE IF NOT EXISTS approval_domains (
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  domain TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('review','carry')),
  carried_approval_id TEXT REFERENCES approvals(id),
  PRIMARY KEY (approval_id, domain)
);

CREATE INDEX IF NOT EXISTS approval_domains_by_carry ON approval_domains(carried_approval_id);

CREATE TABLE IF NOT EXISTS approval_events (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  action TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  at INTEGER NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES skus(sku),
  version_id TEXT NOT NULL REFERENCES versions(id),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published','superseded','recalled','rolled_back')),
  snapshot_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  approval_ids_json TEXT NOT NULL,
  approval_set_hash TEXT NOT NULL,
  rules_hash TEXT NOT NULL,
  check_result_hash TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  published_by TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  replaces_release_id TEXT REFERENCES releases(id),
  restores_release_id TEXT REFERENCES releases(id),
  ended_at INTEGER,
  ended_by TEXT REFERENCES users(id),
  end_reason TEXT,
  UNIQUE (sku, generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS releases_one_current ON releases(sku) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS release_artifacts (
  release_id TEXT NOT NULL REFERENCES releases(id),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  hash TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (release_id, name)
);

CREATE TABLE IF NOT EXISTS publish_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('publish','rollback')),
  sku TEXT NOT NULL,
  version_id TEXT,
  target_release_id TEXT,
  base_generation INTEGER NOT NULL,
  expected_current_release_id TEXT,
  expected_approval_set_hash TEXT NOT NULL,
  expected_hashes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','published','blocked','failed')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  release_id TEXT,
  blocked_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_notes (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  at INTEGER NOT NULL,
  actor_id TEXT REFERENCES users(id),
  ok INTEGER NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_by_subject ON audit_log(subject, id);

-- 审批原件不可改：只能改状态与失效说明。
CREATE TRIGGER IF NOT EXISTS approvals_immutable
BEFORE UPDATE OF version_id, sku, check_run_id, ruleset_id, rules_hash,
                 data_hash, result_hash, scope, reviewer_id, reviewer_role, decided_at,
                 expires_at, carried_from_json, target_release_id
ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approval binding fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approvals_no_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are append-only');
END;

-- 输入快照不可变：更正必须产生新版本。data_hash 是构建派生物，由构建/重试填写。
CREATE TRIGGER IF NOT EXISTS versions_input_immutable
BEFORE UPDATE OF sku, seq, source, base_version_id, reason, raw_json, raw_hash,
                 created_by, created_at
ON versions
BEGIN
  SELECT RAISE(ABORT, 'version input is immutable; create a new version');
END;

CREATE TRIGGER IF NOT EXISTS versions_no_delete
BEFORE DELETE ON versions
BEGIN
  SELECT RAISE(ABORT, 'versions are append-only');
END;

-- 发布回执不可篡改。
CREATE TRIGGER IF NOT EXISTS releases_immutable
BEFORE UPDATE OF sku, version_id, generation, snapshot_hash, manifest_hash,
                 approval_ids_json, approval_set_hash, rules_hash, check_result_hash,
                 published_at, published_by
ON releases
BEGIN
  SELECT RAISE(ABORT, 'release receipt is immutable');
END;

CREATE TRIGGER IF NOT EXISTS releases_no_delete
BEFORE DELETE ON releases
BEGIN
  SELECT RAISE(ABORT, 'releases are append-only');
END;

CREATE TRIGGER IF NOT EXISTS artifacts_no_update
BEFORE UPDATE ON release_artifacts
BEGIN
  SELECT RAISE(ABORT, 'release artifacts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS artifacts_no_delete
BEFORE DELETE ON release_artifacts
BEGIN
  SELECT RAISE(ABORT, 'release artifacts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
`;

function openDatabase(filename) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  if ((row?.v ?? 0) >= SCHEMA_VERSION) {
    seedRuleSets(db);
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, Date.now());
    seedRuleSets(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 规则集是数据，不是代码常量：发布回执要引用具体规则版本。
 * INSERT OR IGNORE：已存在的规则内容绝不覆盖，否则历史批准会对不上哈希。
 */
function seedRuleSets(db) {
  const { listRuleSets } = require('./domain/rules');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO rulesets (id, version, title, rules_json, rules_hash, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const sets = listRuleSets();
  const newest = Math.max(...sets.map((s) => s.version));
  for (const rules of sets) {
    const { hash, hashShort, ...content } = rules;
    insert.run(rules.id, rules.version, rules.title, JSON.stringify(content), hash, rules.version === newest ? 1 : 0, Date.now());
  }
}

/** 所有写事务走 BEGIN IMMEDIATE，确保读-判-写之间没有插队者。 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw err;
  }
}

module.exports = { openDatabase, tx, SCHEMA_VERSION };
