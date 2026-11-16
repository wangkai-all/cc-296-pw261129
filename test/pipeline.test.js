'use strict';
/**
 * 构建、检查与规则引擎。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, create, getVersion, RAW } = require('./helpers');
const { runChecks, summarizeResults, RULES_V1, RULES_V2, rulesHash } = require('../src/domain/rules');
const { buildSnapshot, normalizeInput, domainHashes, changedDomains } = require('../src/domain/catalog');
const { performBuild } = require('../src/domain/pipeline');
const A = require('../src/domain/approvals');

test('规范化：空白与键序不影响快照指纹，非法价格如实保留', () => {
  const a = buildSnapshot({ ...RAW, name: '  山岚   无香洗衣液 ' });
  const b = buildSnapshot(Object.fromEntries(Object.entries({ ...RAW, name: '山岚 无香洗衣液' }).reverse()));
  assert.equal(a.hash, b.hash);
  const c = buildSnapshot({ ...RAW, price: 'abc' });
  assert.equal(c.normalized.price, 'abc');
});

test('规范化：未知字段参与指纹，不能悄悄改字段却视为同一快照', () => {
  const a = buildSnapshot(RAW);
  const b = buildSnapshot({ ...RAW, extra_note: 'x' });
  assert.notEqual(a.hash, b.hash);
});

test('质量检查：缺 EU 过敏原为阻断，缺描述为警告', () => {
  const snap = buildSnapshot({ ...RAW, allergen_note: null, description: '短' });
  const summary = summarizeResults(runChecks(snap.normalized, RULES_V1));
  assert.equal(summary.passed, false);
  assert.ok(summary.blocking.some((b) => b.ruleId === 'q.eu.allergen'));
  assert.ok(summary.warnings.some((w) => w.ruleId === 'q.description.min'));
});

test('质量检查：v2 规则收紧交期上限、要求所有市场原产国', () => {
  const snap = buildSnapshot({ ...RAW, lead_time_days: 100, origin_country: null, markets: ['CN'] });
  const v1 = summarizeResults(runChecks(snap.normalized, RULES_V1));
  const v2 = summarizeResults(runChecks(snap.normalized, RULES_V2));
  assert.equal(v1.passed, true, 'v1 下 100 天与无原产国可放行（仅 EU 要求）');
  assert.equal(v2.passed, false);
  assert.ok(v2.blocking.some((b) => b.ruleId === 'q.leadtime.range'));
  assert.ok(v2.blocking.some((b) => b.ruleId === 'q.origin.required'));
});

test('规则集内容不同 → 哈希不同；同一内容哈希稳定', () => {
  assert.notEqual(rulesHash(RULES_V1), rulesHash(RULES_V2));
  assert.equal(rulesHash(RULES_V1), rulesHash(structuredClone(RULES_V1)));
});

test('域指纹：只改库存只影响库存域输入指纹', () => {
  const a = buildSnapshot(RAW).normalized;
  const b = buildSnapshot({ ...RAW, inventory: 80 }).normalized;
  const ha = domainHashes(a);
  const hb = domainHashes(b);
  assert.notEqual(ha.inventory, hb.inventory);
  assert.equal(ha.pricing, hb.pricing);
  assert.equal(ha.identity, hb.identity);
  assert.equal(ha.compliance, hb.compliance);
  assert.deepEqual(changedDomains(a, b).domains, ['inventory']);
});

test('域指纹：字段归属只反映直接域，跨域耦合由审阅策略决定', () => {
  const db = makeWorld();
  const v1 = create(db, 'OKF-1001', RAW);
  const v2 = create(db, 'OKF-1001', { ...RAW, price: 35.5 }, { baseVersionId: v1.versionId });
  // changedDomains：字段直接归属 → pricing
  const a = buildSnapshot(RAW).normalized;
  const b = buildSnapshot({ ...RAW, price: 35.5 }).normalized;
  assert.deepEqual(changedDomains(a, b).domains, ['pricing']);
  // assessImpact：审阅策略把 price 映射到 pricing + compliance，且强制全审
  const impact = A.assessImpact(db, { newVersion: getVersion(db, v2.versionId), baseVersion: getVersion(db, v1.versionId) });
  assert.equal(impact.scope, 'full');
  assert.deepEqual(impact.affectedDomains.sort(), ['compliance', 'pricing']);
});

test('影响评估：无基线时返回与补审同形的结构（页面不会缺字段）', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  const impact = A.assessImpact(db, { newVersion: getVersion(db, v.versionId), baseVersion: null });
  assert.equal(impact.scope, 'full');
  assert.ok(impact.risk && typeof impact.risk.wait === 'string' && typeof impact.risk.falseRelease === 'string');
  assert.ok(Array.isArray(impact.diff));
  assert.ok(impact.requiredReviewDomains.length === 4);
  assert.equal(impact.carrySources && typeof impact.carrySources, 'object');
  assert.ok(impact.estimateMinutes > 0);
});

test('构建失败不产生可审阅数据：版本停在 build_failed 且无 data_hash', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW, { fault: 'invalid_input' });
  assert.equal(v.status, 'build_failed');
  const row = getVersion(db, v.versionId);
  assert.equal(row.status, 'build_failed');
  assert.equal(row.data_hash, null);
  assert.equal(row.current_check_id, null);
});

test('performBuild 可重试异常在第二次尝试成功', () => {
  assert.throws(() => performBuild(RAW, { fault: 'transient', priorAttempts: 0 }), /可重试/);
  const ok = performBuild(RAW, { fault: 'transient', priorAttempts: 1 });
  assert.match(ok.hash, /^[0-9a-f]{64}$/);
});

test('构建与检查落库：检查结果绑定输入哈希与规则哈希', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  assert.equal(v.status, 'ready');
  const row = getVersion(db, v.versionId);
  const check = db.prepare('SELECT * FROM check_runs WHERE id = ?').get(row.current_check_id);
  assert.equal(check.data_hash, row.data_hash);
  assert.equal(check.status, 'passed');
  assert.ok(check.findings_hash);
});
