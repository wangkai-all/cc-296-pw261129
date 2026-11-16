'use strict';
/**
 * 演示样例必须可重复运行，且始终落在预期终态。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, getVersion } = require('./helpers');
const S = require('../src/samples');
const A = require('../src/domain/approvals');
const R = require('../src/domain/releases');

test('样例：构建失败 → 重试成功，输入未变不新建版本', () => {
  const db = makeWorld();
  S.ensureDemoWorld(db);
  const first = S.runBuildFailureSample(db);
  const row = getVersion(db, first.versionId);
  assert.equal(row.status, 'ready');
  assert.equal(row.seq, 1, '重试不产生新版本');
  assert.ok(row.data_hash);
  assert.equal(R.assessPublishability(db, { versionId: first.versionId }).publishable, false,
    '通过检查但未审阅，不能发布');

  // 可重复运行：每次新建版本，不改旧版本。
  const second = S.runBuildFailureSample(db);
  assert.notEqual(second.versionId, first.versionId);
  assert.equal(getVersion(db, first.versionId).status, 'ready');
});

test('样例：批准过期 → 清扫为 expired，发布被阻止', () => {
  const db = makeWorld();
  S.ensureDemoWorld(db);
  const now = Date.now();
  const out = S.runExpirySample(db, { now });
  const [approval] = A.approvalsForVersion(db, out.versionId, { at: now });
  assert.equal(approval.status, 'expired');
  assert.equal(approval.evaluation.valid, false);
  assert.match(out.steps.at(-2).text, /阻止/);
  assert.equal(R.currentRelease(db, 'OKF-S02'), null);
  const assess = R.assessPublishability(db, { versionId: out.versionId, at: now });
  assert.equal(assess.publishable, false);
});
