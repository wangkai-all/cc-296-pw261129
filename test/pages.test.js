'use strict';
/**
 * 页面渲染回归：任何版本状态都必须能渲染，不能因缺字段 500。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, create, getVersion, approve, RAW } = require('./helpers');
const data = require('../src/views/data');
const versionPage = require('../src/views/versionPage');
const A = require('../src/domain/approvals');
const R = require('../src/domain/releases');

const REVIEWER = {
  id: 'u-rev', name: '沈禾', role: 'reviewer', roleLabel: '业务审阅', title: '类目审阅',
  capabilities: ['version.read', 'approval.submit', 'approval.withdraw', 'release.read', 'note.write'],
};
const RELEASE = {
  id: 'u-rel', name: '陆行', role: 'release', roleLabel: '发布经理', title: '发布经理',
  capabilities: ['version.read', 'release.read', 'release.publish', 'release.rollback', 'verify.run'],
};

function render(db, versionId, user) {
  const detail = data.versionDetail(db, versionId);
  assert.ok(detail, '版本详情应存在');
  return versionPage.versionPage({ user, detail, now: Date.now() });
}

test('页面：无基线的首个版本可渲染，且显示全审与两侧代价', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  const html = render(db, v.versionId, REVIEWER);
  assert.match(html, /完整重审（4 个域）/);
  assert.match(html, /等待成本/);
  assert.match(html, /误放风险/);
});

test('页面：构建失败版本可渲染且不出现伪造的绑定值', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW, { fault: 'invalid_input' });
  const html = render(db, v.versionId, REVIEWER);
  assert.match(html, /构建失败/);
  assert.match(html, /不存在可绑定的四项指纹/);
  assert.doesNotMatch(html, /expected_dataHash" value="[0-9a-f]/);
});

test('页面：检查失败版本可渲染，批准按钮禁用并解释原因', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', { ...RAW, allergen_note: null });
  const html = render(db, v.versionId, REVIEWER);
  assert.match(html, /检查未通过/);
  assert.match(html, /data-blocking="1"/);
  assert.match(html, /无法批准/);
});

test('页面：补审版本显示可承继域与承继来源', () => {
  const db = makeWorld();
  const v1 = create(db, 'OKF-1001', RAW);
  approve(db, v1.versionId);
  approve(db, v1.versionId, { actorId: 'u-cmp', role: 'compliance', name: '顾青', domains: ['compliance'] });
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 80 }, { baseVersionId: v1.versionId });
  const html = render(db, v2.versionId, REVIEWER);
  assert.match(html, /按影响范围补审（1 个域）/);
  assert.match(html, /本次需重审/);
  assert.match(html, /carry_identity/);
  assert.match(html, /carry_pricing/);
  assert.doesNotMatch(html, /carry_inventory/, '受影响域不能承继');
  const detail = data.versionDetail(db, v2.versionId);
  assert.equal(detail.impact.scope, 'targeted');
  assert.deepEqual(detail.impact.requiredReviewDomains, ['inventory']);
});

test('页面：已发布版本可渲染，并展示发布回执入口', () => {
  const db = makeWorld();
  const v = create(db, 'OKF-1001', RAW);
  approve(db, v.versionId);
  approve(db, v.versionId, { actorId: 'u-cmp', role: 'compliance', name: '顾青', domains: ['compliance'] });
  const assess = R.assessPublishability(db, { versionId: v.versionId });
  const task = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v.versionId, actorId: 'u-rel', note: '页面回归',
    expected: { approvalSetHash: assess.approvalSetHash, currentReleaseId: null, generation: 0 },
  });
  const out = R.executePublishTask({ db, taskId: task.taskId });
  assert.equal(out.status, 'published');
  const html = render(db, v.versionId, RELEASE);
  assert.match(html, /已发布/);
  assert.match(html, /查看发布回执/);
  const release = data.releaseDetail(db, out.releaseId);
  assert.ok(release);
  assert.equal(release.release.generation, 1);
  assert.equal(A.effectiveCoverage(db, v.versionId).coverage.inventory.length, 1);
});

test('页面：退役版本明确提示批准不可再用', () => {
  const db = makeWorld();
  const v1 = create(db, 'OKF-1001', RAW);
  approve(db, v1.versionId);
  create(db, 'OKF-1001', { ...RAW, inventory: 50 }, { baseVersionId: v1.versionId, reason: '上游更正' });
  const html = render(db, v1.versionId, REVIEWER);
  assert.equal(getVersion(db, v1.versionId).status, 'retired');
  assert.match(html, /该版本已被上游更正退役/);
  assert.match(html, /不可发布/);
  assert.equal(A.effectiveCoverage(db, v1.versionId).coverage.identity.length, 0);
});

test('页面：承继源被撤回后，只标记该域失效，本人重审域仍有效', () => {
  const db = makeWorld();
  const v1 = create(db, 'OKF-1001', RAW);
  approve(db, v1.versionId);
  approve(db, v1.versionId, { actorId: 'u-cmp', role: 'compliance', name: '顾青', domains: ['compliance'] });
  const assess0 = R.assessPublishability(db, { versionId: v1.versionId });
  const t0 = R.enqueuePublishTask({
    db, sku: 'OKF-1001', versionId: v1.versionId, actorId: 'u-rel', note: '首发',
    expected: { approvalSetHash: assess0.approvalSetHash, currentReleaseId: null, generation: 0 },
  });
  assert.equal(R.executePublishTask({ db, taskId: t0.taskId }).status, 'published');

  const source = A.effectiveCoverage(db, v1.versionId).coverage.identity[0].approvalId;
  const v2 = create(db, 'OKF-1001', { ...RAW, inventory: 60 }, { baseVersionId: v1.versionId });
  approve(db, v2.versionId, {
    domains: ['inventory'],
    carry: ['identity', 'pricing', 'compliance'].map((domain) => ({
      domain, approvalId: A.effectiveCoverage(db, v1.versionId).coverage[domain][0].approvalId,
    })),
  });
  A.withdrawApproval({ db, approvalId: source, actorId: 'u-cmp', actorRole: 'compliance', reason: '推翻身份结论' });

  const detail = data.versionDetail(db, v2.versionId);
  const html = versionPage.versionPage({ user: REVIEWER, detail, now: Date.now() });
  assert.match(html, /部分域失效/);
  assert.match(html, /partial|dom-dead/);
  assert.doesNotMatch(html, /<span class="badge badge-good">当前有效<\/span>/);
});
