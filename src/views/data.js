'use strict';
/**
 * 页面与 API 共用的查询层。所有“有效/可发布”判断都委托给领域层，
 * 视图不自行推断，避免界面与执行器口径不一致。
 */
const A = require('../domain/approvals');
const R = require('../domain/releases');
const { DOMAIN_LABELS, DOMAINS } = require('../domain/catalog');

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function userMap(db) {
  const rows = db.prepare('SELECT id, handle, name, role, title FROM users').all();
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

function listSkus(db) {
  return db.prepare('SELECT * FROM skus ORDER BY sku').all();
}

function getSku(db, sku) {
  return db.prepare('SELECT * FROM skus WHERE sku = ?').get(sku) ?? null;
}

function versionsOf(db, sku) {
  return db.prepare('SELECT * FROM versions WHERE sku = ? ORDER BY seq DESC').all(sku);
}

function getVersion(db, id) {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id) ?? null;
}

function versionSummary(db, version, users = null) {
  const check = version.current_check_id
    ? db.prepare('SELECT * FROM check_runs WHERE id = ?').get(version.current_check_id)
    : null;
  const findings = parseJson(check?.findings_json, []);
  const blocking = findings.filter((f) => !f.passed && f.severity === 'blocking').length;
  const warnings = findings.filter((f) => !f.passed && f.severity === 'warning').length;
  const { coverage } = A.effectiveCoverage(db, version.id);
  const approvalCount = Object.values(coverage).reduce((n, list) => n + (list.length ? 1 : 0), 0);
  const coveredDomains = DOMAINS.filter((d) => coverage[d].length > 0);
  return {
    ...version,
    check,
    blocking,
    warnings,
    approvalCount,
    coveredDomains,
    coverage,
    author: users?.[version.created_by] ?? null,
    canPublish: R.assessPublishability(db, { versionId: version.id }),
  };
}

/**
 * 版本详情：审阅页所需的全部证据。
 */
function versionDetail(db, versionId, { now = Date.now() } = {}) {
  const version = getVersion(db, versionId);
  if (!version) return null;
  const users = userMap(db);
  const check = A.currentCheck(db, version);
  const facts = check ? A.versionFacts(db, version) : null;
  const rules = check ? A.rulesForCheck(db, check) : null;
  const findings = parseJson(check?.findings_json, []);
  const approvals = A.approvalsForVersion(db, versionId, { at: now });
  const binding = A.bindingOf(db, version);
  const impact = A.assessImpact(db, {
    newVersion: version,
    baseVersion: version.base_version_id ? getVersion(db, version.base_version_id) : null,
  });
  const publishable = R.assessPublishability(db, { versionId, at: now });
  const base = version.base_version_id ? getVersion(db, version.base_version_id) : null;
  const diff = R.versionDiff(db, version);
  const raw = parseJson(version.raw_json, {});
  const releases = db.prepare('SELECT * FROM releases WHERE version_id = ? ORDER BY generation').all(versionId);
  const notes = db.prepare('SELECT * FROM review_notes WHERE version_id = ? ORDER BY created_at').all(versionId);
  const tasks = db.prepare('SELECT * FROM publish_tasks WHERE version_id = ? ORDER BY created_at DESC').all(versionId);

  return {
    version,
    users,
    author: users[version.created_by] ?? null,
    check,
    facts,
    rules,
    findings,
    approvals: approvals.map((a) => ({
      ...a,
      reviewer: users[a.reviewer_id] ?? null,
      domainLabels: a.domainList.map((d) => DOMAIN_LABELS[d]),
      evaluation: a.evaluation,
    })),
    binding,
    impact,
    publishable,
    base,
    diff,
    raw,
    normalized: facts?.normalized ?? null,
    reviewDomains: DOMAINS.map((d) => ({
      id: d,
      label: DOMAIN_LABELS[d],
      required: (rules?.review?.requiredDomains ?? DOMAINS).includes(d),
      coverage: publishable.coverage?.[d] ?? [],
      findings: findings.filter((f) => f.domain === d),
      inputHash: facts?.inputHashes?.[d] ?? null,
      resultHash: facts?.resultHashes?.[d] ?? null,
      changed: impact.affectedDomains.includes(d),
      carryable: impact.carryableDomains.includes(d),
    })),
    releases,
    notes: notes.map((n) => ({ ...n, author: users[n.author_id] ?? null })),
    tasks,
    canPublish: publishable.publishable,
  };
}

function releaseSummary(db, release, users = null) {
  const version = getVersion(db, release.version_id);
  const relVer = version ? version.seq : null;
  return {
    ...release,
    versionSeq: relVer,
    publisher: users?.[release.published_by] ?? null,
    artifacts: db.prepare('SELECT name, content_type, hash, LENGTH(bytes) AS size FROM release_artifacts WHERE release_id = ? ORDER BY name').all(release.id),
  };
}

function releaseDetail(db, releaseId, { now = Date.now() } = {}) {
  const release = R.getRelease(db, releaseId);
  if (!release) return null;
  const users = userMap(db);
  const version = getVersion(db, release.version_id);
  const approvalIds = parseJson(release.approval_ids_json, []);
  const approvals = approvalIds.map((id) => {
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!row) return { id, missing: true };
    const domains = db.prepare('SELECT * FROM approval_domains WHERE approval_id = ?').all(id);
    return {
      ...row,
      reviewer: users[row.reviewer_id] ?? null,
      atReleaseTime: {
        dataHash: row.data_hash === release.snapshot_hash,
        resultHash: row.result_hash === release.check_result_hash,
        rulesHash: row.rules_hash === release.rules_hash,
      },
      nowValid: A.evaluateApproval(db, row, { at: now }).valid,
      nowReason: A.evaluateApproval(db, row, { at: now }).reason,
      domains,
    };
  });
  const manifestRow = db.prepare(`SELECT * FROM release_artifacts WHERE release_id = ? AND name = 'manifest.json'`).get(releaseId);
  return {
    release,
    version,
    publisher: users[release.published_by] ?? null,
    ender: release.ended_by ? users[release.ended_by] ?? null : null,
    approvals,
    manifest: manifestRow ? JSON.parse(Buffer.from(manifestRow.bytes).toString('utf8')) : null,
    artifacts: db.prepare('SELECT name, content_type, hash, LENGTH(bytes) AS size FROM release_artifacts WHERE release_id = ? ORDER BY name').all(releaseId),
    verifications: db.prepare('SELECT * FROM verifications WHERE release_id = ? ORDER BY at DESC').all(releaseId),
    task: db.prepare('SELECT * FROM publish_tasks WHERE release_id = ?').get(releaseId) ?? null,
    replaces: release.replaces_release_id ? R.getRelease(db, release.replaces_release_id) : null,
    restores: release.restores_release_id ? R.getRelease(db, release.restores_release_id) : null,
    restoredBy: db.prepare('SELECT * FROM releases WHERE restores_release_id = ? ORDER BY generation DESC').all(releaseId),
  };
}

function skuOverview(db, sku, { now = Date.now() } = {}) {
  const s = getSku(db, sku);
  if (!s) return null;
  const users = userMap(db);
  const current = R.currentRelease(db, sku);
  const releases = db.prepare('SELECT * FROM releases WHERE sku = ? ORDER BY generation DESC').all(sku);
  const versions = versionsOf(db, sku).map((v) => {
    const summary = versionSummary(db, v, users);
    return {
      ...summary,
      author: users[v.created_by] ?? null,
      publisherTask: db.prepare(`SELECT * FROM publish_tasks WHERE version_id = ? ORDER BY created_at DESC LIMIT 1`).get(v.id),
    };
  });
  const pending = versions.filter((v) => ['ready', 'check_failed'].includes(v.status));
  const tasks = db.prepare('SELECT * FROM publish_tasks WHERE sku = ? ORDER BY created_at DESC LIMIT 20').all(sku)
    .map((t) => ({ ...t, actor: users[t.actor_id] ?? null }));
  return {
    sku: s,
    current,
    releases: releases.map((r) => releaseSummary(db, r, users)),
    versions,
    pending,
    tasks,
    users,
    publishableVersions: versions.filter((v) => v.canPublish.publishable),
    refreshAt: now,
  };
}

module.exports = {
  parseJson,
  userMap,
  listSkus,
  getSku,
  versionsOf,
  getVersion,
  versionSummary,
  versionDetail,
  releaseSummary,
  releaseDetail,
  skuOverview,
};
