'use strict';
/**
 * 发布、回滚、召回、核验与并发不变量。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeWorld, create, getVersion, binding, approve, RAW, ALL_DOMAINS,
} = require('./helpers');
const A = require('../src/domain/approvals');
const R = require('../src/domain/releases');

function worldWithApprovedVersion() {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  approve(db, v.versionId);
  approve(db, v.versionId, { actorId: 'u-cmp', role: 'compliance', name: '顾青', domains: ['compliance'] });
  return { db, versionId: v.versionId };
}

function publish(db, versionId, { at = Date.now(), note = '发布' } = {}) {
  const assess = R.assessPublishability(db, { versionId, at });
  const current = R.currentRelease(db, 'OKF-1001');
  const task = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId, actorId: 'u-rel', note, at,
    expected: {
      approvalSetHash: assess.approvalSetHash,
      currentReleaseId: current?.id ?? null,
      generation: current?.generation ?? 0,
    },
  });
  return { taskId: task.taskId, result: R.executePublishTask({ db, taskId: task.taskId, at }) };
}

test('发布：生成不可变回执与四个产物，当前发布唯一', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const { result } = publish(db, versionId);
  assert.equal(result.status, 'published');
  assert.equal(result.generation, 1);
  const rel = R.getRelease(db, result.releaseId);
  assert.equal(rel.status, 'published');
  const files = R.artifactsOf(db, result.releaseId).map((f) => f.name).sort();
  assert.deepEqual(files, ['approvals.json', 'checks.json', 'data.json', 'manifest.json']);
  const current = db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE sku='OKF-1001' AND status='published'`).get();
  assert.equal(current.n, 1);
});

test('发布：缺少任一必需域的批准 → 拒绝', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  approve(db, v.versionId, { domains: ['identity', 'pricing'] });
  const assess = R.assessPublishability(db, { versionId: v.versionId });
  assert.equal(assess.publishable, false);
  assert.ok(assess.reasons.some((r) => /合规与标签|库存与交期/.test(r)));
  assert.throws(
    () => R.enqueuePublishTask({ db, sku: 'OKF-1001', versionId: v.versionId, actorId: 'u-rel', note: 'x', at: Date.now() }),
    (err) => err.code === 'NOT_PUBLISHABLE',
  );
});

test('发布：批准在排队后被撤回 → 任务 blocked，不覆盖当前发布', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const first = publish(db, versionId);
  assert.equal(first.result.status, 'published');

  // 第二个版本获批后排队
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 60 }, { baseVersionId: versionId });
  const { approvalId } = approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: ALL_DOMAINS.filter((d) => d !== 'inventory').map((domain) => ({ domain, approvalId: A.effectiveCoverage(db, versionId).coverage[domain][0].approvalId })),
  });
  const assess = R.assessPublishability(db, { versionId: v2.versionId });
  assert.equal(assess.publishable, true);
  const current = R.currentRelease(db, 'OKF-1001');
  const task = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v2.versionId, actorId: 'u-rel', note: '库存更正', at: Date.now(),
    expected: { approvalSetHash: assess.approvalSetHash, currentReleaseId: current.id, generation: current.generation },
  });

  A.withdrawApproval({ db, approvalId, actorId: 'u-rev', actorRole: 'reviewer', reason: '撤回以阻止错误发布' });
  const out = R.executePublishTask({ db, taskId: task.taskId });
  assert.equal(out.status, 'blocked');
  assert.equal(out.code, 'REVIEW_CHANGED');
  const stillCurrent = R.currentRelease(db, 'OKF-1001');
  assert.equal(stillCurrent.id, current.id, '当前发布未被替换');
});

test('并发发布：同一版本的两个重复任务只有一个产生回执', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const a = R.assessPublishability(db, { versionId });
  const mk = (note) => R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId, actorId: 'u-rel', note,
    expected: { approvalSetHash: a.approvalSetHash, currentReleaseId: null, generation: 0 },
  }).taskId;
  const t1 = mk('任务一');
  const t2 = mk('任务二');
  const first = R.executePublishTask({ db, taskId: t1 });
  const second = R.executePublishTask({ db, taskId: t2 });
  assert.equal(first.status, 'published');
  assert.equal(second.status, 'blocked');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE sku='OKF-1001'`).get().n, 1,
    '重复任务不能产生第二个回执');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE sku='OKF-1001' AND status='published'`).get().n, 1);
});

test('更正未发布版本会退役基线：旧版本不可再发布，在途任务作废', () => {
  const db = makeWorld();
  const v1 = create(db, 'OKF-1001', RAW);
  approve(db, v1.versionId);
  const assess = R.assessPublishability(db, { versionId: v1.versionId });
  assert.equal(assess.publishable, true);
  const task = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v1.versionId, actorId: 'u-rel', note: '首发',
    expected: { approvalSetHash: assess.approvalSetHash, currentReleaseId: null, generation: 0 },
  });
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 90 }, { baseVersionId: v1.versionId, reason: '盘点更正' });
  assert.equal(getVersion(db, v1.versionId).status, 'retired');
  assert.equal(getVersion(db, v1.versionId).review_serial, 1);
  assert.equal(R.assessPublishability(db, { versionId: v1.versionId }).publishable, false);
  const out = R.executePublishTask({ db, taskId: task.taskId });
  assert.equal(out.status, 'blocked');
  assert.equal(R.currentRelease(db, 'OKF-1001'), null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE sku='OKF-1001'`).get().n, 0);
  assert.equal(getVersion(db, v2.versionId).status, 'ready');
});

test('发布：同一任务重复执行不会产生第二代', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const { taskId, result } = publish(db, versionId);
  const again = R.executePublishTask({ db, taskId });
  assert.equal(again.status, 'published');
  assert.equal(again.alreadyFinal, true);
  const rows = db.prepare(`SELECT * FROM releases WHERE sku='OKF-1001'`).all();
  assert.equal(rows.length, 1);
  assert.equal(result.generation, 1);
});

test('回滚：生成新代号，重用原产物，旧发布标记 rolled_back', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const p1 = publish(db, versionId);
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 60 }, { baseVersionId: versionId });
  approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: ALL_DOMAINS.filter((d) => d !== 'inventory').map((domain) => ({ domain, approvalId: A.effectiveCoverage(db, versionId).coverage[domain][0].approvalId })),
  });
  const p2 = publish(db, v2.versionId);
  assert.equal(p2.result.generation, 2);

  const task = R.enqueueRollbackTask({
    db, sku: 'OKF-1001', targetReleaseId: p1.result.releaseId, actorId: 'u-rel', reason: '更正有误，回滚',
    expected: { currentReleaseId: p2.result.releaseId },
  });
  const rb = R.executeRollbackTask({ db, taskId: task.taskId });
  assert.equal(rb.status, 'published');
  assert.equal(rb.generation, 3);
  assert.equal(rb.restoresReleaseId, p1.result.releaseId);

  const old = R.getRelease(db, p2.result.releaseId);
  assert.equal(old.status, 'rolled_back');
  const newRel = R.getRelease(db, rb.releaseId);
  assert.equal(newRel.snapshot_hash, R.getRelease(db, p1.result.releaseId).snapshot_hash, '产物哈希一致');
  const oldFiles = R.artifactsOf(db, p1.result.releaseId);
  const newFiles = R.artifactsOf(db, rb.releaseId);
  assert.deepEqual(oldFiles.map((f) => f.hash), newFiles.map((f) => f.hash));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE sku='OKF-1001' AND status='published'`).get().n, 1);
});

test('回滚：目标发布被召回后不可再上线', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const p1 = publish(db, versionId);
  R.recallCurrent({ db, sku: 'OKF-1001', actorId: 'u-cmp', actorRole: 'compliance', reason: '严重合规问题' });
  assert.throws(
    () => R.enqueueRollbackTask({ db, sku: 'OKF-1001', targetReleaseId: p1.result.releaseId, actorId: 'u-rel', reason: '回滚', expected: { currentReleaseId: null } }),
    (err) => err.code === 'RELEASE_RECALLED',
  );
});

test('召回：线上归零，在途任务被阻止，版本退役', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const p1 = publish(db, versionId);
  const out = R.recallCurrent({ db, sku: 'OKF-1001', actorId: 'u-cmp', actorRole: 'compliance', reason: '召回' });
  assert.equal(out.recalledReleaseId, p1.result.releaseId);
  assert.equal(R.currentRelease(db, 'OKF-1001'), null);
  assert.equal(getVersion(db, versionId).status, 'retired');
  assert.equal(getVersion(db, versionId).review_serial, 1);
});

test('召回阻止在途发布：召回后旧任务执行只能 blocked', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const p1 = publish(db, versionId);
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 60 }, { baseVersionId: versionId });
  approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: ALL_DOMAINS.filter((d) => d !== 'inventory').map((domain) => ({ domain, approvalId: A.effectiveCoverage(db, versionId).coverage[domain][0].approvalId })),
  });
  const assess = R.assessPublishability(db, { versionId: v2.versionId });
  const current = R.currentRelease(db, 'OKF-1001');
  const task = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v2.versionId, actorId: 'u-rel', note: '在途',
    expected: { approvalSetHash: assess.approvalSetHash, currentReleaseId: current.id, generation: current.generation },
  });
  const recalled = R.recallCurrent({ db, sku: 'OKF-1001', actorId: 'u-cmp', actorRole: 'compliance', reason: '紧急召回' });
  assert.ok(recalled.blockedTasks.includes(task.taskId), '召回直接作废在途任务');
  const out = R.executePublishTask({ db, taskId: task.taskId });
  assert.equal(out.status, 'blocked');
  assert.equal(out.alreadyFinal, true);
  assert.equal(R.currentRelease(db, 'OKF-1001'), null);
  assert.equal(p1.result.status, 'published');
});

test('核验：产物或 manifest 被篡改会被发现', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const { result } = publish(db, versionId);
  assert.equal(R.verifyRelease(db, result.releaseId).ok, true);

  // 触发器禁止 UPDATE 产物；这里用 DROP TRIGGER 模拟最坏情况下的存储损坏。
  db.exec('DROP TRIGGER artifacts_no_update');
  db.prepare(`UPDATE release_artifacts SET bytes = ? WHERE release_id = ? AND name = 'data.json'`)
    .run(Buffer.from('{"tampered":true}'), result.releaseId);
  const verified = R.verifyRelease(db, result.releaseId);
  assert.equal(verified.ok, false);
  assert.ok(verified.details.some((d) => d.id === 'artifact.data.json' && !d.ok));
});

test('核验：批准之后过期，不影响回执本身', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const t0 = Date.now();
  const p = publish(db, versionId, { at: t0 });
  const later = t0 + 80 * 3600_000;
  const out = R.verifyRelease(db, p.result.releaseId, { at: later });
  assert.equal(out.ok, true, '回执仍然可核验');
  const approvalDetails = out.details.filter((d) => /approval\..*\.now/.test(d.id));
  assert.ok(approvalDetails.some((d) => /已失效|已过期/.test(d.detail)));
});

test('撤销承继源批准后，新版本上的承继批准立即失效', () => {
  const { db, versionId } = worldWithApprovedVersion();
  publish(db, versionId); // 已发布基线才不会被更正退役，承继链才成立
  const source = A.effectiveCoverage(db, versionId).coverage.identity[0].approvalId;
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 60 }, { baseVersionId: versionId });
  const { approvalId } = approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: ALL_DOMAINS.filter((d) => d !== 'inventory').map((domain) => ({ domain, approvalId: A.effectiveCoverage(db, versionId).coverage[domain][0].approvalId })),
  });
  assert.equal(A.effectiveCoverage(db, v2.versionId).coverage.identity.length, 1);

  A.withdrawApproval({ db, approvalId: source, actorId: 'u-cmp', actorRole: 'compliance', reason: '合规复核推翻原结论' });
  const coverage = A.effectiveCoverage(db, v2.versionId).coverage;
  assert.equal(coverage.identity.length, 0, '承继链必须随源批准一起失效');
  assert.equal(coverage.pricing.length, 0);
  assert.equal(coverage.inventory.length, 1, '本人重审的域不受影响，不因他人的承继源失效而连带重审');
  const [carried] = A.approvalsForVersion(db, v2.versionId).filter((a) => a.id === approvalId);
  assert.equal(carried.evaluation.valid, false, '整条批准不再是“全部域有效”');
  assert.equal(carried.evaluation.globalValid, true, '全局绑定仍成立');
  assert.equal(carried.evaluation.domainValidity.identity.valid, false);
  assert.equal(carried.evaluation.domainValidity.inventory.valid, true);
  assert.match(carried.evaluation.reason, /承继源批准/);
  const assess = R.assessPublishability(db, { versionId: v2.versionId });
  assert.equal(assess.publishable, false, '缺身份与价格域，仍不可发布');
  assert.ok(assess.reasons.some((r) => /商品身份|价格与币种/.test(r)));

  // 重审被撤回的两个承继域（身份/价格）与同源合规域后即可发布；库存域不需要重做。
  approve(db, v2.versionId, { actorId: 'u-rev2', name: '穆岩', domains: ['identity', 'pricing', 'compliance'] });
  const full = A.effectiveCoverage(db, v2.versionId).coverage;
  for (const d of ALL_DOMAINS) assert.ok(full[d].length > 0, `${d} 应被覆盖`);
  const finalAssess = R.assessPublishability(db, { versionId: v2.versionId });
  assert.equal(finalAssess.publishable, true);
  const ids = finalAssess.approvals.map((a) => a.id);
  assert.ok(ids.includes(approvalId));
});

test('回执与产物不可篡改（触发器）', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const { result } = publish(db, versionId);
  assert.throws(
    () => db.prepare('UPDATE releases SET snapshot_hash = ? WHERE id = ?').run('x', result.releaseId),
    /immutable/,
  );
  assert.throws(
    () => db.prepare('UPDATE release_artifacts SET hash = ? WHERE release_id = ?').run('x', result.releaseId),
    /immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM release_artifacts WHERE release_id = ?').run(result.releaseId),
    /immutable/,
  );
});

test('回滚与发布交错：先执行者生效，后执行者 blocked，只留一个当前版本', () => {
  const { db, versionId } = worldWithApprovedVersion();
  const p1 = publish(db, versionId);
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 60 }, { baseVersionId: versionId });
  approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: ALL_DOMAINS.filter((d) => d !== 'inventory').map((domain) => ({ domain, approvalId: A.effectiveCoverage(db, versionId).coverage[domain][0].approvalId })),
  });
  const p2 = publish(db, v2.versionId);

  // v3 是 v2 的更正（v2 已发布，不会被退役），获批后与“回滚到 p1”同时排队。
  const v3 = create(db, 'OKF-1001', { ...RAW, inventory: 70 }, { baseVersionId: v2.versionId });
  approve(db, v3.versionId, {
    domains: ['inventory'],
    carry: ALL_DOMAINS.filter((d) => d !== 'inventory').map((domain) => ({ domain, approvalId: A.effectiveCoverage(db, v2.versionId).coverage[domain][0].approvalId })),
  });
  assert.equal(R.assessPublishability(db, { versionId: v3.versionId }).publishable, true);

  const rollbackTask = R.enqueueRollbackTask({
    db, sku: 'OKF-1001', targetReleaseId: p1.result.releaseId, actorId: 'u-rel', reason: '回滚到首发',
    expected: { currentReleaseId: p2.result.releaseId },
  });
  const a3 = R.assessPublishability(db, { versionId: v3.versionId });
  const publishTask = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v3.versionId, actorId: 'u-rel', note: '再更正',
    expected: { approvalSetHash: a3.approvalSetHash, currentReleaseId: p2.result.releaseId, generation: 2 },
  });

  const rbOut = R.executeRollbackTask({ db, taskId: rollbackTask.taskId });
  const pubOut = R.executePublishTask({ db, taskId: publishTask.taskId });
  assert.equal(rbOut.status, 'published');
  assert.equal(rbOut.generation, 3);
  assert.equal(pubOut.status, 'blocked');
  assert.ok(['RELEASE_STALE', 'GENERATION_STALE'].includes(pubOut.code));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE sku='OKF-1001' AND status='published'`).get().n, 1);
  assert.equal(R.currentRelease(db, 'OKF-1001').generation, 3);
});
