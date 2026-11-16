'use strict';
/**
 * 发布、回滚、召回。
 *
 * 唯一当前版本（single current release）靠三层保证：
 *  1) 数据库部分唯一索引：releases(sku) WHERE status='published'。
 *  2) 所有切换在 BEGIN IMMEDIATE 单写事务中完成，并在事务内重新校验。
 *  3) 发布任务自带“预期”：当前发布 ID、代号、批准集指纹、数据/规则/结果指纹。
 *     任何一项在排队期间变化，任务只能 blocked，不能“带病越过”。
 *
 * 回滚不是把旧行改回 published，而是：
 *  - 当前发布 → rolled_back
 *  - 以旧发布的同一份不可变产物创建一个新的 published 行（新代号），
 *    并记录 restores_release_id。历史发布回执永不修改。
 *
 * 撤回批准会推进版本 review_serial。排队中的发布任务在创建时记录了它；
 * 执行时若不一致，任务失败。这样“撤回”永远赢过“在途发布”。
 */
const { newId } = require('../store/audit');
const { audit } = require('../store/audit');
const { tx } = require('../db');
const { canonicalJson, sha256Hex } = require('../canonical');
const { DOMAIN_LABELS, buildSnapshot, diffSnapshots } = require('./catalog');
const {
  currentCheck, rulesForCheck, versionFacts, evaluateApproval, approvalsForVersion,
  effectiveCoverage, sweepExpired, REVIEW_DOMAINS,
} = require('./approvals');

class ReleaseError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.detail = detail;
  }
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function getVersion(db, id) {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id) ?? null;
}

function currentRelease(db, sku) {
  return db.prepare(`SELECT * FROM releases WHERE sku = ? AND status = 'published'`).get(sku) ?? null;
}

function latestRelease(db, sku) {
  return db.prepare('SELECT * FROM releases WHERE sku = ? ORDER BY generation DESC LIMIT 1').get(sku);
}

function getRelease(db, id) {
  return db.prepare('SELECT * FROM releases WHERE id = ?').get(id) ?? null;
}

/**
 * 锁定“本次发布将要消费的批准集合”。
 * 指纹覆盖：批准 id、五项绑定、逐域输入/结果指纹、有效期。
 * 这样任何一条被撤回、过期、被新检查替代，指纹都会变。
 */
function approvalSetFingerprint(db, versionId, { at = Date.now() } = {}) {
  const { approvals, coverage } = effectiveCoverage(db, versionId, { at });
  // 只把“此刻对该域真正有效”的域纳入指纹与产物：
  // 一条批准里被撤回的承继域不能拖累同一人亲自审阅的域，也不能被当作有效证据。
  const validDomainsOf = (approval) => approval.domains.filter((d) => (
    approval.evaluation.domainValidity?.[d.domain]?.valid ?? approval.evaluation.valid
  ));
  const valid = approvals.filter((a) => validDomainsOf(a).length > 0);
  const entries = valid
    .map((a) => ({
      approvalId: a.id,
      reviewerId: a.reviewer_id,
      scope: a.scope,
      dataHash: a.data_hash,
      rulesHash: a.rules_hash,
      resultHash: a.result_hash,
      expiresAt: a.expires_at,
      domains: validDomainsOf(a)
        .map((d) => ({ domain: d.domain, inputHash: d.input_hash, resultHash: d.result_hash, via: d.via, carried: d.carried_approval_id }))
        .sort((x, y) => x.domain.localeCompare(y.domain)),
      carriedFrom: a.carriedFrom,
    }))
    .sort((x, y) => x.approvalId.localeCompare(y.approvalId));
  const hash = sha256Hex(canonicalJson(entries));
  return { hash, entries, approvals: valid, coverage };
}

/**
 * 可发布性检查。返回结构化结果，既供界面预览，也供发布执行时复验。
 * 这是“批准 → 发布”之间唯一的判定函数。
 */
function assessPublishability(db, { versionId, at = Date.now() } = {}) {
  const version = getVersion(db, versionId);
  if (!version) return { publishable: false, reasons: ['版本不存在'], checks: [] };
  const checks = [];
  const add = (id, ok, detail, blocking = true) => checks.push({ id, ok, detail, blocking });

  add('version_status', version.status === 'ready', `版本状态 ${version.status}`);
  const check = currentCheck(db, version);
  add('current_check', Boolean(check), check ? `当前检查 ${check.id}` : '缺少当前检查记录');
  add('check_passed', check?.status === 'passed', `检查结论 ${check?.status ?? '无'}`);
  const facts = check ? versionFacts(db, version) : null;
  add('data_hash', Boolean(facts) && version.data_hash === facts?.dataHash, '输入哈希可由源包重建');

  const rules = check ? rulesForCheck(db, check) : null;
  const required = rules?.review?.requiredDomains ?? REVIEW_DOMAINS;
  const { hash, approvals, coverage } = approvalSetFingerprint(db, versionId, { at });
  const missing = required.filter((d) => coverage[d].length === 0);
  add('coverage', missing.length === 0, missing.length
    ? `缺少有效批准的域：${missing.map((d) => DOMAIN_LABELS[d]).join('、')}`
    : `必需域均有有效批准（${required.map((d) => DOMAIN_LABELS[d]).join('、')}）`);

  const blockingFindings = parseJson(check?.findings_json, []).filter((f) => !f.passed && f.severity === 'blocking');
  add('blocking_findings', blockingFindings.length === 0, blockingFindings.length
    ? `仍有 ${blockingFindings.length} 个阻断项`
    : '无阻断项');

  const expiredSoon = approvals.filter((a) => a.expires_at - at < 15 * 60 * 1000);
  add('expiry', approvals.every((a) => a.expires_at > at), '所有批准均未过期', true);
  if (expiredSoon.length) {
    checks.push({
      id: 'expiry_soon', ok: true, blocking: false,
      detail: `${expiredSoon.length} 条批准将在 15 分钟内过期`,
    });
  }

  const versionReusable = version.status === 'ready';
  if (!versionReusable) add('version_reusable', false, '版本不在可发布状态');

  const blocking = checks.filter((c) => !c.ok && c.blocking);
  return {
    publishable: blocking.length === 0,
    reasons: blocking.map((c) => c.detail),
    checks,
    version,
    check,
    rules,
    requiredDomains: required,
    coverage,
    approvals,
    approvalSetHash: hash,
    approvalSetSize: approvals.length,
    currentRelease: currentRelease(db, version.sku),
    currentGeneration: currentRelease(db, version.sku)?.generation ?? 0,
  };
}

/** 生成发布产物（纯函数），并对每个文件计哈希。 */
function buildArtifacts({ version, check, rules, approvals, approvalSetHash, releaseMeta, at }) {
  const data = parseJson(version.raw_json, {});
  const { normalized } = buildSnapshot(data);
  const findings = parseJson(check.findings_json, []);
  const files = {};

  const put = (name, contentType, obj) => {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    const bytes = Buffer.from(text, 'utf8');
    files[name] = { contentType, bytes, hash: sha256Hex(bytes) };
  };

  put('data.json', 'application/json', normalized);
  put('checks.json', 'application/json', {
    checkRunId: check.id,
    rulesetId: check.ruleset_id,
    rulesHash: check.rules_hash,
    engineVersion: check.engine_version,
    findings,
    findingsHash: check.findings_hash,
    completedAt: check.finished_at,
  });
  put('approvals.json', 'application/json', {
    approvalSetHash,
    approvals: approvals.map((a) => ({
      id: a.id,
      reviewerId: a.reviewer_id,
      reviewerName: a.reviewer_name,
      reviewerRole: a.reviewer_role,
      decidedAt: a.decided_at,
      expiresAt: a.expires_at,
      scope: a.scope,
      dataHash: a.data_hash,
      rulesHash: a.rules_hash,
      resultHash: a.result_hash,
      // 只写入发布时真正有效的域；被撤回承继的域不得出现在回执证据里。
      domains: a.domains
        .filter((d) => a.evaluation?.domainValidity?.[d.domain]?.valid ?? true)
        .map((d) => ({
          domain: d.domain,
          inputHash: d.input_hash,
          resultHash: d.result_hash,
          via: d.via,
          carriedApprovalId: d.carried_approval_id,
        })),
    })),
  });

  const manifestCore = {
    format: 'okf-catalog-release/1',
    fictional: true,
    releaseId: releaseMeta.id,
    sku: version.sku,
    versionId: version.id,
    versionSeq: version.seq,
    generation: releaseMeta.generation,
    publishedAt: at,
    publishedBy: releaseMeta.publishedBy,
    dataHash: version.data_hash,
    rulesHash: check.rules_hash,
    checkResultHash: check.findings_hash,
    approvalSetHash,
    files: Object.fromEntries(Object.entries(files).map(([name, f]) => [name, f.hash])),
  };
  put('manifest.json', 'application/json', manifestCore);
  return {
    files,
    manifest: manifestCore,
    manifestHash: sha256Hex(canonicalJson(manifestCore)),
    snapshotHash: version.data_hash,
  };
}

function artifactsOf(db, releaseId) {
  const rows = db.prepare('SELECT name, content_type, hash, bytes FROM release_artifacts WHERE release_id = ? ORDER BY name').all(releaseId);
  return rows.map((r) => ({
    name: r.name,
    contentType: r.content_type,
    hash: r.hash,
    bytes: Buffer.from(r.bytes),
  }));
}

/**
 * 创建发布任务（排队但不执行）。
 * expected 来自界面上的“发布预览”，用于拒绝盲目提交。
 */
function enqueuePublishTask({
  db, sku, versionId, actorId, note = '', expected = {}, at = Date.now(),
}) {
  if (!note.trim()) throw new ReleaseError('NOTE_REQUIRED', '发布必须填写说明');
  const version = getVersion(db, versionId);
  if (!version) throw new ReleaseError('VERSION_MISSING', '版本不存在');
  if (version.sku !== sku) throw new ReleaseError('SKU_MISMATCH', '版本不属于该 SKU');
  const current = currentRelease(db, sku);
  const assess = assessPublishability(db, { versionId, at });
  if (!assess.publishable) {
    throw new ReleaseError('NOT_PUBLISHABLE', '当前不可发布', { reasons: assess.reasons, checks: assess.checks });
  }
  if (expected.approvalSetHash !== undefined && expected.approvalSetHash !== assess.approvalSetHash) {
    throw new ReleaseError('BINDING_STALE', '批准集合已变化，请刷新发布预览', {
      expected: expected.approvalSetHash, actual: assess.approvalSetHash,
    });
  }
  if (expected.currentReleaseId !== undefined && expected.currentReleaseId !== (current?.id ?? null)) {
    throw new ReleaseError('RELEASE_STALE', '当前线上版本已变化，请刷新', {
      expected: expected.currentReleaseId, actual: current?.id ?? null,
    });
  }
  if (expected.generation !== undefined && expected.generation !== (current?.generation ?? 0)) {
    throw new ReleaseError('RELEASE_STALE', '发布代号已变化，请刷新', {
      expected: expected.generation, actual: current?.generation ?? 0,
    });
  }
  if (expected.reviewSerial !== undefined && expected.reviewSerial !== version.review_serial) {
    throw new ReleaseError('BINDING_STALE', '版本批准状态已变化，请刷新', {
      expected: expected.reviewSerial, actual: version.review_serial,
    });
  }

  const id = newId('pub');
  tx(db, () => {
    db.prepare(`INSERT INTO publish_tasks
      (id, kind, sku, version_id, target_release_id, base_generation, expected_current_release_id,
       expected_approval_set_hash, expected_hashes_json, status, actor_id, note, created_at)
      VALUES (?, 'publish', ?, ?, NULL, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(
        id, sku, versionId, current?.generation ?? 0, current?.id ?? null,
        assess.approvalSetHash,
        canonicalJson({
          dataHash: version.data_hash,
          rulesHash: assess.check.rules_hash,
          resultHash: assess.check.findings_hash,
          reviewSerial: version.review_serial,
        }),
        actorId, note.trim(), at,
      );
    audit(db, actorId, 'publish.enqueued', id, {
      sku, versionId, approvalSetHash: assess.approvalSetHash, currentReleaseId: current?.id ?? null,
    });
  });
  return { taskId: id, status: 'queued', approvalSetHash: assess.approvalSetHash };
}

function getTask(db, taskId) {
  return db.prepare('SELECT * FROM publish_tasks WHERE id = ?').get(taskId) ?? null;
}

function markTaskRunning(db, taskId, at) {
  return tx(db, () => {
    const task = getTask(db, taskId);
    if (!task) throw new ReleaseError('TASK_MISSING', '发布任务不存在');
    if (task.status !== 'queued') {
      throw new ReleaseError('TASK_NOT_QUEUED', `任务状态为 ${task.status}`, { blockedReason: task.blocked_reason });
    }
    const running = db.prepare(`UPDATE publish_tasks SET status='running', started_at=?, attempts=attempts+1
      WHERE id=? AND status='queued'`).run(at, taskId);
    if (running.changes !== 1) throw new ReleaseError('TASK_TAKEN', '发布任务已被其他执行者领取');
    audit(db, task.actor_id, 'publish.started', taskId, { sku: task.sku, kind: task.kind });
    return { ...task, status: 'running' };
  });
}

function blockTask(db, task, reason, at, { code = 'BLOCKED', detail = {} } = {}) {
  tx(db, () => {
    db.prepare(`UPDATE publish_tasks SET status='blocked', blocked_reason=?, finished_at=? WHERE id=?`)
      .run(reason, at, task.id);
    audit(db, task.actor_id, 'publish.blocked', task.id, { reason, code, ...detail });
  });
  return { status: 'blocked', reason, code, detail };
}

/**
 * 执行发布任务。所有校验与写入在同一写事务中完成。
 * 任何一项与任务创建时的“预期”不符 → blocked，绝不覆盖别人的决定。
 */
function executePublishTask({ db, taskId, at = Date.now() }) {
  let task;
  try {
    task = markTaskRunning(db, taskId, at);
  } catch (err) {
    if (err.code === 'TASK_NOT_QUEUED') {
      const existing = getTask(db, taskId);
      return {
        status: existing.status, alreadyFinal: true,
        reason: existing.blocked_reason ?? `任务状态为 ${existing.status}`,
      };
    }
    throw err;
  }
  try {
    const result = tx(db, () => {
      // 1) 过期清扫在事务内先做：过期批准不可能参与集合指纹。
      const expired = sweepExpired(db, { at, sku: task.sku });
      const expected = parseJson(task.expected_hashes_json, {});
      const version = getVersion(db, task.version_id);
      if (!version) throw new ReleaseError('VERSION_MISSING', '版本不存在');
      const current = currentRelease(db, task.sku);

      // 2) 拒绝过期预览：当前发布代号/ID 必须与任务创建时一致。
      if ((current?.id ?? null) !== (task.expected_current_release_id ?? null)) {
        throw new ReleaseError('RELEASE_STALE', '当前线上版本已被其他发布/回滚改变', {
          expectedCurrent: task.expected_current_release_id, actualCurrent: current?.id ?? null,
        });
      }
      if ((current?.generation ?? 0) !== task.base_generation) {
        throw new ReleaseError('GENERATION_STALE', '发布代号已变化', {
          expected: task.base_generation, actual: current?.generation ?? 0,
        });
      }
      if (version.review_serial !== expected.reviewSerial) {
        throw new ReleaseError('REVIEW_CHANGED', '排队期间批准状态已变化（撤回/失效），发布任务作废', {
          expected: expected.reviewSerial, actual: version.review_serial,
        });
      }

      // 3) 完整复验（不等于信任界面）。
      const assess = assessPublishability(db, { versionId: version.id, at });
      if (!assess.publishable) {
        throw new ReleaseError('NOT_PUBLISHABLE', '执行时复验不可发布', { reasons: assess.reasons });
      }
      if (assess.approvalSetHash !== task.expected_approval_set_hash) {
        throw new ReleaseError('APPROVAL_SET_CHANGED', '批准集合与排队时不一致（可能已撤回/过期/新增）', {
          expected: task.expected_approval_set_hash, actual: assess.approvalSetHash,
        });
      }
      if (version.data_hash !== expected.dataHash
        || assess.check.rules_hash !== expected.rulesHash
        || assess.check.findings_hash !== expected.resultHash) {
        throw new ReleaseError('BINDING_CHANGED', '输入/规则/检查结果与排队时不一致', { expected });
      }

      // 4) 生成不可变产物。
      const releaseId = newId('rel');
      const generation = (current?.generation ?? 0) + 1;
      const approvals = assess.approvals;
      const artifacts = buildArtifacts({
        version, check: assess.check, rules: assess.rules, approvals,
        approvalSetHash: assess.approvalSetHash,
        releaseMeta: { id: releaseId, generation, publishedBy: task.actor_id },
        at,
      });

      if (current) {
        db.prepare(`UPDATE releases SET status='superseded', ended_at=?, ended_by=?, end_reason=? WHERE id=?`)
          .run(at, task.actor_id, `被第 ${generation} 代发布 ${releaseId} 取代`, current.id);
      }
      db.prepare(`INSERT INTO releases
        (id, sku, version_id, generation, status, snapshot_hash, manifest_hash, approval_ids_json,
         approval_set_hash, rules_hash, check_result_hash, published_at, published_by, note,
         replaces_release_id)
        VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          releaseId, task.sku, version.id, generation,
          artifacts.snapshotHash, artifacts.manifestHash,
          canonicalJson(approvals.map((a) => a.id).sort()),
          assess.approvalSetHash, assess.check.rules_hash, assess.check.findings_hash,
          at, task.actor_id, task.note, current?.id ?? null,
        );
      const insertArtifact = db.prepare(`INSERT INTO release_artifacts
        (release_id, name, content_type, hash, bytes) VALUES (?, ?, ?, ?, ?)`);
      for (const [name, file] of Object.entries(artifacts.files)) {
        insertArtifact.run(releaseId, name, file.contentType, file.hash, file.bytes);
      }
      db.prepare(`UPDATE skus SET current_release_id = ?, generation = ? WHERE sku = ?`)
        .run(releaseId, generation, task.sku);
      db.prepare(`UPDATE versions SET status='published' WHERE id=?`).run(version.id);
      // 已发布版本不能再次直接发布；若需重发，必须先回滚或创建新版本。
      db.prepare(`UPDATE publish_tasks SET status='published', release_id=?, finished_at=?
        WHERE id=?`).run(releaseId, at, task.id);
      db.prepare('INSERT INTO verifications (id, release_id, at, actor_id, ok, detail_json) VALUES (?,?,?,?,?,?)')
        .run(newId('vrf'), releaseId, at, task.actor_id, 1, canonicalJson({
          selfCheck: 'published artifact hashes recorded at creation',
        }));
      audit(db, task.actor_id, 'release.published', releaseId, {
        sku: task.sku, generation, versionId: version.id, replaced: current?.id ?? null,
        approvalSetHash: assess.approvalSetHash, manifestHash: artifacts.manifestHash,
        approvalIds: approvals.map((a) => a.id),
      });
      return {
        status: 'published', releaseId, generation,
        replacedReleaseId: current?.id ?? null,
        approvalSetHash: assess.approvalSetHash,
        manifestHash: artifacts.manifestHash,
        expirySweep: expired,
      };
    });
    return result;
  } catch (err) {
    if (err instanceof ReleaseError) {
      const detail = err.detail ?? {};
      blockTask(db, task, err.message, at, { code: err.code, detail });
      return { status: 'blocked', reason: err.message, code: err.code, detail };
    }
    tx(db, () => {
      db.prepare(`UPDATE publish_tasks SET status='failed', blocked_reason=?, finished_at=? WHERE id=?`)
        .run(err.message, at, task.id);
      audit(db, null, 'publish.failed', task.id, { message: err.message, stack: err.stack });
    });
    throw err;
  }
}

/** 回滚：把某个历史发布的同一份产物重新作为当前发布。 */
function enqueueRollbackTask({
  db, sku, targetReleaseId, actorId, reason, expected = {}, at = Date.now(),
}) {
  if (!reason || !reason.trim()) throw new ReleaseError('REASON_REQUIRED', '回滚必须说明原因');
  const target = getRelease(db, targetReleaseId);
  if (!target) throw new ReleaseError('RELEASE_MISSING', '目标发布不存在');
  if (target.sku !== sku) throw new ReleaseError('SKU_MISMATCH', '目标发布不属于该 SKU');
  if (target.status === 'recalled') throw new ReleaseError('RELEASE_RECALLED', '被召回版本的产物已禁止再次上线');
  const current = currentRelease(db, sku);
  if (expected.currentReleaseId !== undefined && expected.currentReleaseId !== (current?.id ?? null)) {
    throw new ReleaseError('RELEASE_STALE', '当前线上版本已变化，请刷新', {
      expected: expected.currentReleaseId, actual: current?.id ?? null,
    });
  }
  const id = newId('rbk');
  tx(db, () => {
    db.prepare(`INSERT INTO publish_tasks
      (id, kind, sku, version_id, target_release_id, base_generation, expected_current_release_id,
       expected_approval_set_hash, expected_hashes_json, status, actor_id, note, created_at)
      VALUES (?, 'rollback', ?, NULL, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
      .run(
        id, sku, targetReleaseId, current?.generation ?? 0, current?.id ?? null,
        target.approval_set_hash,
        canonicalJson({ snapshotHash: target.snapshot_hash, manifestHash: target.manifest_hash }),
        actorId, reason.trim(), at,
      );
    audit(db, actorId, 'rollback.enqueued', id, { sku, targetReleaseId, currentReleaseId: current?.id ?? null });
  });
  return { taskId: id, status: 'queued' };
}

function executeRollbackTask({ db, taskId, at = Date.now() }) {
  let task;
  try {
    task = markTaskRunning(db, taskId, at);
  } catch (err) {
    if (err.code === 'TASK_NOT_QUEUED') {
      const existing = getTask(db, taskId);
      return {
        status: existing.status, alreadyFinal: true,
        reason: existing.blocked_reason ?? `任务状态为 ${existing.status}`,
      };
    }
    throw err;
  }
  try {
    return tx(db, () => {
      const current = currentRelease(db, task.sku);
      if ((current?.id ?? null) !== (task.expected_current_release_id ?? null)) {
        throw new ReleaseError('RELEASE_STALE', '当前线上版本已被其他操作改变', {
          expectedCurrent: task.expected_current_release_id, actualCurrent: current?.id ?? null,
        });
      }
      const target = getRelease(db, task.target_release_id);
      if (!target) throw new ReleaseError('RELEASE_MISSING', '目标发布不存在');
      if (target.status === 'recalled') throw new ReleaseError('RELEASE_RECALLED', '被召回版本禁止回滚上线');

      // 复验目标产物完整性：逐文件重算哈希，与发布时记录比对。
      const files = artifactsOf(db, target.id);
      if (!files.length) throw new ReleaseError('ARTIFACTS_MISSING', '目标发布缺少产物');
      const manifest = files.find((f) => f.name === 'manifest.json');
      if (!manifest) throw new ReleaseError('MANIFEST_MISSING', '目标发布缺少 manifest');
      const manifestObj = JSON.parse(manifest.bytes.toString('utf8'));
      for (const f of files) {
        if (sha256Hex(f.bytes) !== f.hash) {
          throw new ReleaseError('ARTIFACT_CORRUPT', `产物 ${f.name} 哈希不符`);
        }
        if (f.name !== 'manifest.json' && manifestObj.files[f.name] !== f.hash) {
          throw new ReleaseError('MANIFEST_MISMATCH', `产物 ${f.name} 与 manifest 记录不符`);
        }
      }
      if (sha256Hex(canonicalJson(manifestObj)) !== target.manifest_hash) {
        throw new ReleaseError('MANIFEST_MISMATCH', 'manifest 哈希与发布回执不符');
      }

      const releaseId = newId('rel');
      const generation = (current?.generation ?? 0) + 1;
      if (current) {
        db.prepare(`UPDATE releases SET status='rolled_back', ended_at=?, ended_by=?, end_reason=? WHERE id=?`)
          .run(at, task.actor_id, `回滚至第 ${target.generation} 代发布 ${target.id}`, current.id);
      }
      db.prepare(`INSERT INTO releases
        (id, sku, version_id, generation, status, snapshot_hash, manifest_hash, approval_ids_json,
         approval_set_hash, rules_hash, check_result_hash, published_at, published_by, note,
         replaces_release_id, restores_release_id)
        VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          releaseId, task.sku, target.version_id, generation,
          target.snapshot_hash, target.manifest_hash, target.approval_ids_json,
          target.approval_set_hash, target.rules_hash, target.check_result_hash,
          at, task.actor_id, task.note, current?.id ?? null, target.id,
        );
      const insertArtifact = db.prepare(`INSERT INTO release_artifacts
        (release_id, name, content_type, hash, bytes) VALUES (?, ?, ?, ?, ?)`);
      for (const f of files) insertArtifact.run(releaseId, f.name, f.contentType, f.hash, f.bytes);
      db.prepare('UPDATE skus SET current_release_id=?, generation=? WHERE sku=?')
        .run(releaseId, generation, task.sku);
      db.prepare(`UPDATE publish_tasks SET status='published', release_id=?, finished_at=? WHERE id=?`)
        .run(releaseId, at, task.id);
      audit(db, task.actor_id, 'release.rolled_back', releaseId, {
        sku: task.sku, generation, targetReleaseId: target.id, replaced: current?.id ?? null,
      });
      return { status: 'published', releaseId, generation, restoresReleaseId: target.id, replacedReleaseId: current?.id ?? null };
    });
  } catch (err) {
    if (err instanceof ReleaseError) {
      blockTask(db, task, err.message, at, { code: err.code, detail: err.detail ?? {} });
      return { status: 'blocked', reason: err.message, code: err.code };
    }
    tx(db, () => {
      db.prepare(`UPDATE publish_tasks SET status='failed', blocked_reason=?, finished_at=? WHERE id=?`)
        .run(err.message, at, task.id);
      audit(db, null, 'rollback.failed', task.id, { message: err.message });
    });
    throw err;
  }
}

/**
 * 紧急召回当前发布：不给替代版本，线上归零。
 * 需要 compliance/release 角色；推进每个相关版本的 review_serial，
 * 使任何在途发布任务失效。
 */
function recallCurrent({ db, sku, actorId, actorRole, reason, at = Date.now() }) {
  if (!['compliance', 'release'].includes(actorRole)) {
    throw new ReleaseError('FORBIDDEN', '只有合规或发布角色可以召回');
  }
  if (!reason || !reason.trim()) throw new ReleaseError('REASON_REQUIRED', '召回必须说明原因');
  return tx(db, () => {
    const current = currentRelease(db, sku);
    if (!current) throw new ReleaseError('NO_CURRENT', '当前没有已发布版本');
    db.prepare(`UPDATE releases SET status='recalled', ended_at=?, ended_by=?, end_reason=? WHERE id=?`)
      .run(at, actorId, reason.trim(), current.id);
    db.prepare('UPDATE skus SET current_release_id = NULL WHERE sku = ?').run(sku);
    db.prepare('UPDATE versions SET status = ? WHERE id = ?').run('retired', current.version_id);
    db.prepare('UPDATE versions SET review_serial = review_serial + 1 WHERE id = ?').run(current.version_id);
    // 在途任务：直接标记 blocked，理由写明召回。
    const queued = db.prepare(`SELECT id FROM publish_tasks WHERE sku = ? AND status IN ('queued','running')`).all(sku);
    for (const t of queued) {
      db.prepare(`UPDATE publish_tasks SET status='blocked', blocked_reason=?, finished_at=? WHERE id=?`)
        .run('发布已被召回操作终止', at, t.id);
    }
    audit(db, actorId, 'release.recalled', current.id, { sku, reason: reason.trim(), blockedTasks: queued.map((t) => t.id) });
    return { ok: true, recalledReleaseId: current.id, blockedTasks: queued.map((t) => t.id) };
  });
}

/**
 * 校验一个发布回执：产物哈希、manifest、批准记录是否与发布时一致。
 * 注意：批准后来可能已被撤回/过期——这是允许的，verification 会如实报告，
 * 但发布回执本身（当时依据的证据）仍然可核验。
 */
function verifyRelease(db, releaseId, { at = Date.now(), actorId = null } = {}) {
  const release = getRelease(db, releaseId);
  if (!release) throw new ReleaseError('RELEASE_MISSING', '发布不存在');
  const details = [];
  const add = (id, ok, detail) => details.push({ id, ok, detail });

  add('receipt_exists', true, `发布回执 ${release.id}（第 ${release.generation} 代）`);
  add('sku', Boolean(db.prepare('SELECT 1 FROM skus WHERE sku = ?').get(release.sku)), `SKU ${release.sku}`);

  const files = artifactsOf(db, releaseId);
  add('artifact_count', files.length > 0, `产物 ${files.length} 个`);
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  for (const f of files) {
    const ok = sha256Hex(f.bytes) === f.hash;
    add(`artifact.${f.name}`, ok, ok ? `哈希一致 ${f.hash.slice(0, 12)}` : '哈希不一致');
  }
  const manifest = byName['manifest.json'];
  if (manifest) {
    const manifestObj = JSON.parse(manifest.bytes.toString('utf8'));
    add('manifest.self', sha256Hex(canonicalJson(manifestObj)) === release.manifest_hash, 'manifest 与回执一致');
    add('manifest.sku', manifestObj.sku === release.sku, 'manifest SKU 一致');
    add('manifest.version', manifestObj.versionId === release.version_id, 'manifest 版本一致');
    add('manifest.approvalSet', manifestObj.approvalSetHash === release.approval_set_hash, 'manifest 批准集一致');
    add('manifest.dataHash', manifestObj.dataHash === release.snapshot_hash, 'manifest 数据哈希一致');
    for (const [name, hash] of Object.entries(manifestObj.files ?? {})) {
      add(`manifest.links.${name}`, byName[name]?.hash === hash, `产物 ${name} 与 manifest 记录一致`);
    }
  } else {
    add('manifest', false, '缺 manifest.json');
  }

  const approvalIds = parseJson(release.approval_ids_json, []);
  for (const id of approvalIds) {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!approval) { add(`approval.${id}`, false, '批准记录缺失'); continue; }
    add(`approval.${id}.binding`,
      approval.data_hash === release.snapshot_hash
      && approval.result_hash === release.check_result_hash
      && approval.rules_hash === release.rules_hash,
      `批准 ${id} 绑定与发布回执一致`);
    const nowValid = evaluateApproval(db, approval, { at }).valid;
    add(`approval.${id}.now`, true, nowValid
      ? '批准当前仍有效'
      : '批准当前已失效/过期（发布时依据记录仍可核验）');
  }

  const ok = details.filter((d) => !d.ok).length === 0;
  tx(db, () => {
    db.prepare('INSERT INTO verifications (id, release_id, at, actor_id, ok, detail_json) VALUES (?,?,?,?,?,?)')
      .run(newId('vrf'), releaseId, at, actorId, ok ? 1 : 0, canonicalJson({ details }));
    audit(db, actorId, 'release.verified', releaseId, { ok, failures: details.filter((d) => !d.ok).map((d) => d.id) });
  });
  return { releaseId, ok, details, verifiedAt: at };
}

/** 版本相对其基线的差异说明（给审阅页用）。 */
function versionDiff(db, version) {
  if (!version.base_version_id) return { base: null, diff: [], changedDomains: [] };
  const base = getVersion(db, version.base_version_id);
  if (!base) return { base: null, diff: [], changedDomains: [] };
  const prev = buildSnapshot(parseJson(base.raw_json, {})).normalized;
  const next = buildSnapshot(parseJson(version.raw_json, {})).normalized;
  return {
    base: { id: base.id, seq: base.seq, status: base.status },
    diff: diffSnapshots(prev, next),
  };
}

module.exports = {
  ReleaseError,
  currentRelease,
  latestRelease,
  getRelease,
  approvalSetFingerprint,
  assessPublishability,
  buildArtifacts,
  artifactsOf,
  enqueuePublishTask,
  enqueueRollbackTask,
  executePublishTask,
  executeRollbackTask,
  recallCurrent,
  verifyRelease,
  versionDiff,
  getTask,
};
