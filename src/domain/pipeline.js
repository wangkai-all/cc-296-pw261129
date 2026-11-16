'use strict';
/**
 * 构建与质量检查。
 *
 * 设计：
 * - 构建与检查是“派生”，不改变输入；输入只来自版本（raw_json）。
 * - 固定规则集版本绑定到检查记录，规则集内容变化 → 新检查 / 批准失效。
 * - 构建失败可重试；重试复用同一版本（输入未变），生成新的检查记录。
 * - 上游更正 = 新版本（base_version_id 指向被更正版本），旧版本只读保留。
 */
const { newId } = require('../store/audit');
const { audit } = require('../store/audit');
const { tx } = require('../db');
const { canonicalJson, sha256Hex, digest } = require('../canonical');
const { buildSnapshot, domainHashes, domainResultHashes } = require('./catalog');
const { getRuleSet, getRuleSetById, runChecks, summarizeResults } = require('./rules');

const ENGINE_VERSION = 'engine-2026.11.1';

class BuildError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.detail = detail;
  }
}

/** 构建阶段：raw → 规范化快照。fault 仅用于演示恢复。 */
function performBuild(raw, { fault = null, priorAttempts = 0 } = {}) {
  if (fault === 'invalid_input') throw new BuildError('E_INPUT', '源包不是可构建的对象（构建失败样例）');
  if (fault === 'transient' && priorAttempts < 1) {
    throw new BuildError('E_TRANSIENT', '构建工作进程异常退出（可重试样例）', { retryable: true });
  }
  return buildSnapshot(raw);
}

/** 检查阶段：规范化快照 + 规则集 → findings + 域指纹。 */
function performCheck(normalized, rules) {
  const results = runChecks(normalized, rules);
  const summary = summarizeResults(results);
  const resultHashes = domainResultHashes(results);
  return {
    results,
    summary,
    resultHashes,
    findingsHash: sha256Hex(canonicalJson({ rules: rules.hash, results })),
  };
}

function rulesetRow(db, rules) {
  const row = db.prepare('SELECT * FROM rulesets WHERE id = ?').get(rules.id);
  if (!row) throw new Error(`规则集 ${rules.id} 未注册`);
  return row;
}

/**
 * 创建版本（含构建与检查）。默认同步执行，测试可注入 autoRun=false。
 * 返回 { versionId, status, snapshot?, check? , error? }。
 */
function createVersion({
  db, sku, raw, source = 'manual_correction', baseVersionId = null, reason,
  actorId, rulesetVersion = null, fault = null, autoRun = true, at = Date.now(),
  independent = false,
}) {
  if (!reason || !String(reason).trim()) throw new Error('更正必须说明原因');
  const skuRow = db.prepare('SELECT * FROM skus WHERE sku = ?').get(sku);
  if (!skuRow) throw new Error(`SKU ${sku} 不存在`);

  // 基线：显式指定的优先；否则取“当前可审/已发布”的最新版本。
  // independent=true 用于演示样例等独立建版场景：不设基线，也不退役上一版。
  let baseId = null;
  if (!independent) {
    baseId = baseVersionId;
    if (baseId === null) {
      const latest = db.prepare(`SELECT id FROM versions WHERE sku = ? ORDER BY seq DESC LIMIT 1`).get(sku);
      baseId = latest?.id ?? null;
    } else if (!db.prepare('SELECT id FROM versions WHERE id = ? AND sku = ?').get(baseId, sku)) {
      throw new Error('基线版本不属于该 SKU');
    }
  }
  const baseVersion = baseId ? db.prepare('SELECT * FROM versions WHERE id = ?').get(baseId) : null;

  const rules = rulesetVersion
    ? getRuleSet(rulesetVersion)
    : (() => {
      const active = db.prepare('SELECT * FROM rulesets WHERE active = 1').get();
      return active ? getRuleSetById(active.id) : null;
    })();
  if (!rules) throw new Error('没有可用规则集');
  rulesetRow(db, rules);

  const versionId = newId('ver');
  const buildId = newId('bld');
  const createdAt = at;
  const rawHash = digest(raw).hex;

  const pre = tx(db, () => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM versions WHERE sku = ?').get(sku)?.m ?? 0) + 1;
    db.prepare(`INSERT INTO versions
      (id, sku, seq, status, source, base_version_id, reason, raw_json, raw_hash, created_by, created_at)
      VALUES (?, ?, ?, 'building', ?, ?, ?, ?, ?, ?, ?)`)
      .run(versionId, sku, seq, source, baseId, String(reason).trim(), canonicalJson(raw), rawHash, actorId, createdAt);
    db.prepare(`INSERT INTO builds (id, version_id, status, ruleset_id, attempts, started_at)
      VALUES (?, ?, 'running', ?, 1, ?)`).run(buildId, versionId, rules.id, createdAt);
    audit(db, actorId, 'version.created', versionId, {
      sku, seq, source, baseVersionId: baseId, reason: String(reason).trim(), rawHash,
    });

    // 更正一个“尚未发布”的基线：基线立即退役，不能再被发布或在途发布任务带出去。
    // 基线是当前已发布版本时不退役它——线上版本只能通过回滚/召回/新版本发布来替换。
    if (baseVersion && baseVersion.status !== 'published') {
      db.prepare(`UPDATE versions SET status='retired', review_serial = review_serial + 1
        WHERE id=? AND status IN ('ready','check_failed','build_failed','checking','building')`)
        .run(baseVersion.id);
      const queued = db.prepare(`SELECT id FROM publish_tasks WHERE version_id = ? AND status IN ('queued','running')`).all(baseVersion.id);
      for (const t of queued) {
        db.prepare(`UPDATE publish_tasks SET status='blocked', blocked_reason=?, finished_at=? WHERE id=?`)
          .run(`版本已被上游更正为 ${versionId}，原发布任务作废`, at, t.id);
      }
      audit(db, actorId, 'version.retired_on_correction', baseVersion.id, {
        supersededBy: versionId, blockedTasks: queued.map((t) => t.id),
      });
    }
    return { seq, retiredBaseVersionId: baseVersion && baseVersion.status !== 'published' ? baseVersion.id : null };
  });

  if (!autoRun) return { versionId, buildId, status: 'building', ...pre };

  let snapshot;
  try {
    snapshot = performBuild(raw, { fault, priorAttempts: 0 });
  } catch (err) {
    const error = {
      code: err.code ?? 'E_BUILD',
      message: err.message,
      detail: err.detail ?? {},
      retryable: Boolean(err.detail?.retryable) || err.code === 'E_INPUT',
    };
    tx(db, () => {
      db.prepare(`UPDATE builds SET status='failed', error_json=?, log=?, finished_at=? WHERE id=?`)
        .run(canonicalJson(error), error.message, at, buildId);
      db.prepare(`UPDATE versions SET status='build_failed', build_error_json=? WHERE id=?`)
        .run(canonicalJson(error), versionId);
      audit(db, actorId, 'build.failed', versionId, { buildId, error });
    });
    return { versionId, buildId, status: 'build_failed', error, ...pre };
  }

  const finished = finalizeBuildAndCheck({
    db, versionId, buildId, rules, snapshot, actorId, at,
  });
  return { versionId, buildId, ...pre, ...finished };
}

/**
 * 落库构建输出并执行检查。构建成功与检查失败分开记录：
 * 构建失败的版本可以重试；检查失败的版本需要更正数据（新版本）。
 */
function finalizeBuildAndCheck({ db, versionId, buildId, rules, snapshot, actorId, at = Date.now() }) {
  const check = performCheck(snapshot.normalized, rules);
  const checkId = newId('chk');
  tx(db, () => {
    db.prepare(`UPDATE builds SET status='succeeded', output_hash=?, finished_at=? WHERE id=?`)
      .run(snapshot.hash, at, buildId);
    db.prepare(`INSERT INTO check_runs
      (id, build_id, ruleset_id, rules_hash, data_hash, status, engine_version, findings_json,
       findings_hash, domain_results_json, attempts, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(
        checkId, buildId, rules.id, rules.hash, snapshot.hash,
        check.summary.passed ? 'passed' : 'failed', ENGINE_VERSION,
        canonicalJson(check.results), check.findingsHash,
        canonicalJson({ hashes: check.resultHashes, summary: check.summary.byDomain }),
        at, at,
      );
    const status = check.summary.passed ? 'ready' : 'check_failed';
    db.prepare(`UPDATE versions SET status=?, data_hash=?, current_check_id=?, built_at=?, check_finished_at=?,
      build_error_json=NULL WHERE id=?`)
      .run(status, snapshot.hash, checkId, at, at, versionId);
    audit(db, actorId, 'build.succeeded', versionId, { buildId, outputHash: snapshot.hash });
    audit(db, actorId, 'check.finished', versionId, {
      checkId, passed: check.summary.passed, rulesHash: rules.hash, resultHash: check.findingsHash,
      blocking: check.summary.blocking.length, warnings: check.summary.warnings.length,
    });
  });
  return {
    status: check.summary.passed ? 'ready' : 'check_failed',
    snapshot: { hash: snapshot.hash, normalized: snapshot.normalized, inputHashes: domainHashes(snapshot.normalized) },
    check: {
      id: checkId, summary: check.summary, findingsHash: check.findingsHash, resultHashes: check.resultHashes,
    },
  };
}

/** 重试构建（输入未变）。仅 build_failed 可重试。 */
function retryBuild({ db, versionId, actorId, at = Date.now() }) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) throw new Error('版本不存在');
  if (version.status !== 'build_failed') throw new Error('只有构建失败的版本可以重试；其他状态请新建更正版本');
  const build = db.prepare('SELECT * FROM builds WHERE version_id = ?').get(versionId);
  const rules = getRuleSetById(build.ruleset_id);
  if (!rules) throw new Error('规则集已不存在');
  let snapshot;
  try {
    snapshot = performBuild(JSON.parse(version.raw_json), { priorAttempts: build.attempts });
  } catch (err) {
    const error = { code: err.code ?? 'E_BUILD', message: err.message, detail: err.detail ?? {}, retryable: false };
    tx(db, () => {
      db.prepare(`UPDATE builds SET status='failed', attempts=attempts+1, error_json=?, log=?, finished_at=? WHERE id=?`)
        .run(canonicalJson(error), error.message, at, build.id);
      audit(db, actorId, 'build.retry_failed', versionId, { buildId: build.id, error });
    });
    return { status: 'build_failed', error };
  }
  tx(db, () => {
    db.prepare(`UPDATE builds SET status='succeeded', attempts=attempts+1, error_json=NULL, log=NULL, finished_at=? WHERE id=?`)
      .run(at, build.id);
    db.prepare('UPDATE versions SET status=\'checking\' WHERE id=?').run(versionId);
    audit(db, actorId, 'build.retried', versionId, { buildId: build.id, attempts: build.attempts + 1 });
  });
  return finalizeBuildAndCheck({ db, versionId, buildId: build.id, rules, snapshot, actorId, at });
}

/**
 * 规则集变更后的重检：为指定版本生成新检查记录（不改变输入），
 * 并让旧检查上的批准失效（由 approvals.invalidateForRulesChange 完成）。
 */
function recheckVersion({ db, versionId, actorId, rulesetId = null, at = Date.now() }) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) throw new Error('版本不存在');
  const current = version.current_check_id
    ? db.prepare('SELECT * FROM check_runs WHERE id = ?').get(version.current_check_id)
    : null;
  const rules = rulesetId
    ? getRuleSetById(rulesetId)
    : getRuleSetById(db.prepare('SELECT * FROM rulesets WHERE active = 1').get()?.id);
  if (!rules) throw new Error('没有可用规则集');
  const build = db.prepare('SELECT * FROM builds WHERE version_id = ?').get(versionId);
  const snapshot = buildSnapshot(JSON.parse(version.raw_json));
  const check = performCheck(snapshot.normalized, rules);
  const checkId = newId('chk');
  tx(db, () => {
    if (current) db.prepare(`UPDATE check_runs SET status='stale' WHERE id=?`).run(current.id);
    db.prepare(`INSERT INTO check_runs
      (id, build_id, ruleset_id, rules_hash, data_hash, status, engine_version, findings_json,
       findings_hash, domain_results_json, attempts, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(checkId, build.id, rules.id, rules.hash, snapshot.hash,
        check.summary.passed ? 'passed' : 'failed', ENGINE_VERSION,
        canonicalJson(check.results), check.findingsHash,
        canonicalJson({ hashes: check.resultHashes, summary: check.summary.byDomain }), at, at);
    db.prepare(`UPDATE versions SET status=?, current_check_id=?, check_finished_at=? WHERE id=?`)
      .run(check.summary.passed ? 'ready' : 'check_failed', checkId, at, versionId);
    audit(db, actorId, 'check.rechecked', versionId, {
      checkId, rulesHash: rules.hash, previousCheckId: current?.id ?? null,
    });
  });
  return { checkId, passed: check.summary.passed, findingsHash: check.findingsHash };
}

module.exports = {
  ENGINE_VERSION,
  BuildError,
  performBuild,
  performCheck,
  createVersion,
  retryBuild,
  recheckVersion,
};
