'use strict';
/**
 * 种子数据：虚构人员 + 三个商品 + 一个已发布、一个待审阅、一个被更正的场景。
 * 可重复执行：已有库时跳过业务数据播种，只补人员。
 */
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDatabase, tx } = require('../src/db');
const samples = require('../src/samples');
const pipeline = require('../src/domain/pipeline');
const A = require('../src/domain/approvals');
const R = require('../src/domain/releases');

function u(db, handle) {
  return db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
}

function approveFully(db, versionId, handle, note, at, extra = {}) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  const binding = A.bindingOf(db, version);
  const user = u(db, handle);
  return A.submitDecision({
    db, versionId, actorId: user.id, actorRole: user.role, actorName: user.name,
    mode: 'approve', note, acknowledgedWarnings: true, at,
    selection: { domains: ['identity', 'pricing', 'compliance', 'inventory'], carry: [], ...extra },
    expected: {
      dataHash: binding.dataHash, rulesHash: binding.rulesHash, resultHash: binding.resultHash,
      checkRunId: binding.checkRunId, reviewSerial: binding.reviewSerial,
    },
  });
}

function seed(db) {
  samples.ensureDemoWorld(db);
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM versions`).get().n;
  if (existing > 0) {
    console.log('已存在版本数据，跳过业务播种。');
    return;
  }
  const now = Date.now();
  const steward = u(db, 'lin-zhou');
  const rel = u(db, 'lu-xing');

  // OKF-1001：已发布第 1 代。
  const v1 = pipeline.createVersion({
    db, sku: 'OKF-1001', raw: samples.rawFor('OKF-1001'),
    reason: '首次上架', actorId: steward.id, rulesetVersion: 1, at: now - 30 * 3600_000,
  });
  approveFully(db, v1.versionId, 'shen-he', '类目、价格与描述均已核对', now - 29 * 3600_000);
  approveFully(db, v1.versionId, 'gu-qing', 'EU 市场过敏原与原产地合规', now - 28.5 * 3600_000);
  const a1 = R.assessPublishability(db, { versionId: v1.versionId, at: now - 28 * 3600_000 });
  const t1 = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v1.versionId, actorId: rel.id, note: '首发第 1 代',
    expected: { approvalSetHash: a1.approvalSetHash, currentReleaseId: null, generation: 0 },
    at: now - 28 * 3600_000,
  });
  R.executePublishTask({ db, taskId: t1.taskId, at: now - 28 * 3600_000 });

  // OKF-1001 的更正：只改库存 → 补审样例（尚未批准，停在待审阅）。
  pipeline.createVersion({
    db, sku: 'OKF-1001', raw: samples.rawFor('OKF-1001', { inventory: 80 }),
    baseVersionId: v1.versionId, reason: '仓库盘点：库存 120 → 80',
    actorId: steward.id, rulesetVersion: 1, at: now - 2 * 3600_000,
  });

  // OKF-1002：新商品，检查通过但只拿到一个域的批准。
  const c2 = pipeline.createVersion({
    db, sku: 'OKF-1002', raw: samples.rawFor('OKF-1002'),
    reason: '新品上架', actorId: steward.id, rulesetVersion: 1, at: now - 26 * 3600_000,
  });
  const b2 = A.bindingOf(db, db.prepare('SELECT * FROM versions WHERE id=?').get(c2.versionId));
  A.submitDecision({
    db, versionId: c2.versionId, actorId: u(db, 'shen-he').id, actorRole: 'reviewer',
    actorName: '沈禾', mode: 'approve', note: '先审身份与价格，合规待补',
    selection: { domains: ['identity', 'pricing'], carry: [] }, acknowledgedWarnings: true,
    at: now - 25 * 3600_000,
    expected: { dataHash: b2.dataHash, rulesHash: b2.rulesHash, resultHash: b2.resultHash, checkRunId: b2.checkRunId, reviewSerial: b2.reviewSerial },
  });

  // OKF-1003：检查含阻断项（EU 市场缺原产国相关规则在 v1 下通过；改为故意缺过敏原）。
  pipeline.createVersion({
    db, sku: 'OKF-1003', raw: samples.rawFor('OKF-1003', { allergen_note: null }),
    reason: '新品预售（待补合规字段）', actorId: steward.id, rulesetVersion: 1, at: now - 3 * 3600_000,
  });

  console.log('种子完成：OKF-1001 已发布第 1 代，另有 3 个版本处于不同状态。');
}

if (require.main === module) {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  seed(db);
}

module.exports = { seed };
