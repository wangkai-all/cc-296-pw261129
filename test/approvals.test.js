'use strict';
/**
 * 批准有效性、绑定、撤回、过期。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeWorld, create, getVersion, binding, approve, reject, RAW, ALL_DOMAINS,
} = require('./helpers');
const A = require('../src/domain/approvals');

test('批准绑定具体输入/规则/结果：页面绑定值过期时拒绝提交', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  const stale = binding(db, v.versionId);
  // 模拟页面停留期间发生规则变化后的重检
  const { recheckVersion } = require('../src/domain/pipeline');
  recheckVersion({ db, versionId: v.versionId, actorId: 'u-stew', rulesetId: 'rs-okf-2026.11-b' });
  assert.throws(
    () => approve(db, v.versionId, { expected: stale }),
    (err) => err.code === 'BINDING_STALE',
  );
});

test('批准后再改数据会造出新版本；旧批准对新版本无效（即使文本相同）', () => {
  const db = makeWorld();
  const v1 = create(db, 'OKF-1001', RAW);
  approve(db, v1.versionId);
  const v2 = create(db, 'OKF-1001', RAW, { baseVersionId: v1.versionId, reason: '无内容变化的更正' });
  assert.notEqual(v1.versionId, v2.versionId);
  const v2Approvals = A.approvalsForVersion(db, v2.versionId);
  assert.equal(v2Approvals.length, 0, '批准不随版本复制');
  const pub = require('../src/domain/releases').assessPublishability(db, { versionId: v2.versionId });
  assert.equal(pub.publishable, false);
});

test('同一审阅人不能重复批准，需先撤回', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  approve(db, v.versionId);
  assert.throws(() => approve(db, v.versionId), (err) => err.code === 'ALREADY_APPROVED');
});

test('拆分批准：两个审阅人各覆盖部分域，合并后完整', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  approve(db, v.versionId, { actorId: 'u-rev', name: '沈禾', domains: ['identity', 'pricing'] });
  const mid = A.effectiveCoverage(db, v.versionId);
  assert.equal(mid.coverage.compliance.length, 0);
  approve(db, v.versionId, { actorId: 'u-cmp', role: 'compliance', name: '顾青', domains: ['compliance', 'inventory'] });
  const full = A.effectiveCoverage(db, v.versionId);
  for (const d of ALL_DOMAINS) assert.ok(full.coverage[d].length > 0, `${d} 应被覆盖`);
});

test('拒绝不产生有效覆盖', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  reject(db, v.versionId);
  const { coverage } = A.effectiveCoverage(db, v.versionId);
  for (const d of ALL_DOMAINS) assert.equal(coverage[d].length, 0);
});

test('撤回：本人可撤，他人不可，合规可代撤；撤回后批准立即无效', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  const { approvalId } = approve(db, v.versionId, { actorId: 'u-rev' });

  assert.throws(
    () => A.withdrawApproval({ db, approvalId, actorId: 'u-rev2', actorRole: 'reviewer', reason: '越权撤回' }),
    (err) => err.code === 'FORBIDDEN',
  );
  A.withdrawApproval({ db, approvalId, actorId: 'u-cmp', actorRole: 'compliance', reason: '合规复核发现问题' });
  const [approval] = A.approvalsForVersion(db, v.versionId);
  assert.equal(approval.status, 'withdrawn');
  assert.equal(approval.evaluation.valid, false);
  const serial = getVersion(db, v.versionId).review_serial;
  assert.equal(serial, 1, '撤回推进审阅序号');
});

test('过期：超过有效期后实时判定为无效，且清扫标记为 expired', () => {
  const db = makeWorld();
  const t0 = Date.now();
  const v = create(db, 'OKF-1001', RAW, { at: t0 });
  const { approvalId } = approve(db, v.versionId, { at: t0 });
  const before = A.approvalsForVersion(db, v.versionId, { at: t0 + 3600_000 })[0];
  assert.equal(before.evaluation.valid, true);
  const later = t0 + 73 * 3600_000;
  const after = A.approvalsForVersion(db, v.versionId, { at: later })[0];
  assert.equal(after.evaluation.valid, false);
  assert.match(after.evaluation.reason, /过期/);
  const swept = A.sweepExpired(db, { at: later });
  assert.deepEqual(swept, [approvalId]);
  const row = db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId);
  assert.equal(row.status, 'expired');
});

test('规则集重检：旧检查作废、其批准失效，必须重新审阅', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  const { approvalId } = approve(db, v.versionId);
  const before = db.prepare('SELECT * FROM check_runs WHERE id = ?').get(getVersion(db, v.versionId).current_check_id);
  const { recheckVersion } = require('../src/domain/pipeline');
  recheckVersion({ db, versionId: v.versionId, actorId: 'u-stew', rulesetId: 'rs-okf-2026.11-b' });
  const old = db.prepare('SELECT status FROM check_runs WHERE id = ?').get(before.id);
  assert.equal(old.status, 'stale');
  const [approval] = A.approvalsForVersion(db, v.versionId);
  assert.equal(approval.evaluation.valid, false);
  assert.match(approval.evaluation.reason, /当前结果|检查记录/);
  assert.equal(approvalId, approval.id);
});

test('警告必须逐项确认才能批准', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', { ...RAW, description: '太短' });
  assert.throws(
    () => approve(db, v.versionId, { acknowledgedWarnings: false }),
    (err) => err.code === 'WARNINGS_UNACKNOWLEDGED',
  );
});

test('警告必须逐项确认：只勾选其中一项仍被拒绝', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', { ...RAW, description: '太短', category: null });
  const findings = db.prepare('SELECT findings_json FROM check_runs WHERE id = ?')
    .get(db.prepare('SELECT current_check_id FROM versions WHERE id = ?').get(v.versionId).current_check_id);
  const warnings = JSON.parse(findings.findings_json).filter((f) => !f.passed && f.severity === 'warning');
  assert.ok(warnings.length >= 2, '夹具应产生至少两个警告');
  assert.throws(
    () => approve(db, v.versionId, { acknowledgedWarnings: [warnings[0].ruleId] }),
    (err) => err.code === 'WARNINGS_UNACKNOWLEDGED' && err.detail.warnings.length === warnings.length - 1,
  );
  const ok = approve(db, v.versionId, { acknowledgedWarnings: warnings.map((w) => w.ruleId) });
  const row = db.prepare('SELECT acknowledged_warnings FROM approvals WHERE id = ?').get(ok.approvalId);
  assert.equal(row.acknowledged_warnings, 1);
});

test('检查未通过时不能批准；拒绝仍可记录', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', { ...RAW, allergen_note: null });
  assert.equal(v.status, 'check_failed');
  assert.throws(() => approve(db, v.versionId), (err) => err.code === 'CHECK_FAILED');
  const r = reject(db, v.versionId, { note: '缺 EU 过敏原，拒绝' });
  assert.equal(r.status, 'rejected');
});

test('批准表具名角色被记录，且原件字段不可被 UPDATE 篡改', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  const { approvalId } = approve(db, v.versionId);
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  assert.equal(row.reviewer_role, 'reviewer');
  assert.equal(row.reviewer_name, '沈禾');
  assert.throws(
    () => db.prepare('UPDATE approvals SET data_hash = ? WHERE id = ?').run('deadbeef', approvalId),
    /immutable/,
  );
  assert.throws(() => db.prepare('DELETE FROM approvals WHERE id = ?').run(approvalId), /append-only/);
});

test('承继按域记录来源：本人重审域与三个承继域分别落库', () => {
  const db = makeWorld();
  const R = require('../src/domain/releases');
  const v1 = create(db, 'OKF-1001', RAW);
  const { approvalId: a1 } = approve(db, v1.versionId);
  approve(db, v1.versionId, { actorId: 'u-cmp', role: 'compliance', name: '顾青', domains: ['compliance'] });
  // 让 v1 成为已发布基线，否则更正会退役它。
  const assess = R.assessPublishability(db, { versionId: v1.versionId });
  const task = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v1.versionId, actorId: 'u-rel', note: '首发',
    expected: { approvalSetHash: assess.approvalSetHash, currentReleaseId: null, generation: 0 },
  });
  assert.equal(R.executePublishTask({ db, taskId: task.taskId }).status, 'published');

  // 两个审阅人分别覆盖不同域，新版本按域各自承继，来源分别记录。
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 55 }, { baseVersionId: v1.versionId });
  const coverage = A.effectiveCoverage(db, v1.versionId).coverage;
  const res = approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: [
      { domain: 'identity', approvalId: a1 },
      { domain: 'pricing', approvalId: a1 },
      { domain: 'compliance', approvalId: coverage.compliance[0].approvalId },
    ],
  });
  assert.equal(res.ok, true);
  const rows = db.prepare('SELECT * FROM approval_domains WHERE approval_id = ? ORDER BY domain').all(res.approvalId);
  assert.deepEqual(rows.map((r) => [r.domain, r.via]), [
    ['compliance', 'carry'], ['identity', 'carry'], ['inventory', 'review'], ['pricing', 'carry'],
  ]);
});
