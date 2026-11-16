'use strict';
/** 测试夹具：内存库 + 虚构人员 + 商品。 */
const { openDatabase, tx } = require('../src/db');
const { createVersion } = require('../src/domain/pipeline');
const A = require('../src/domain/approvals');

const USERS = [
  ['u-stew', 'lin-zhou', '林舟', 'steward', '资料管理员'],
  ['u-rev', 'shen-he', '沈禾', 'reviewer', '类目审阅'],
  ['u-rev2', 'mu-yan', '穆岩', 'reviewer', '价格审阅'],
  ['u-cmp', 'gu-qing', '顾青', 'compliance', '合规审阅'],
  ['u-rel', 'lu-xing', '陆行', 'release', '发布经理'],
  ['u-aud', 'yan-shu', '颜述', 'auditor', '审计员'],
];

const RAW = {
  sku: 'OKF-1001',
  name: '山岚 无香洗衣液',
  brand: '山岚',
  category: 'homecare',
  description: '一款用于日常衣物的无香型浓缩洗衣液，低泡易漂洗，适用于机洗与手洗。',
  price: 39.9,
  currency: 'CNY',
  tax_included: true,
  inventory: 120,
  lead_time_days: 3,
  status: 'on_sale',
  markets: ['CN', 'EU'],
  labels: ['cosmetic'],
  allergen_note: '不含常见过敏原',
  origin_country: 'CN',
};

const ALL_DOMAINS = ['identity', 'pricing', 'compliance', 'inventory'];

function makeWorld({ sku = 'OKF-1001', name = '山岚 无香洗衣液' } = {}) {
  const db = openDatabase(':memory:');
  for (const [id, handle, uname, role, title] of USERS) {
    db.prepare('INSERT INTO users (id, handle, name, role, title) VALUES (?, ?, ?, ?, ?)').run(id, handle, uname, role, title);
  }
  db.prepare('INSERT INTO skus (sku, name, generation, created_at) VALUES (?, ?, 0, ?)').run(sku, name, Date.now());
  return db;
}

function getVersion(db, id) {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
}

function binding(db, versionId) {
  return A.bindingOf(db, getVersion(db, versionId));
}

function approve(db, versionId, {
  actorId = 'u-rev', role = 'reviewer', name = '沈禾', domains = ALL_DOMAINS,
  carry = [], note = '已核对输入、规则与全部检查结果', acknowledgedWarnings = true,
  at = Date.now(), expected = null,
} = {}) {
  return A.submitDecision({
    db, versionId, actorId, actorRole: role, actorName: name, mode: 'approve',
    selection: { domains, carry }, note, acknowledgedWarnings, at,
    expected: expected ?? binding(db, versionId),
  });
}

function reject(db, versionId, { actorId = 'u-rev', note = '资料不完整，拒绝', at = Date.now() } = {}) {
  return A.submitDecision({
    db, versionId, actorId, actorRole: 'reviewer', actorName: '沈禾', mode: 'reject',
    note, at, expected: binding(db, versionId),
  });
}

function create(db, sku, raw, opts = {}) {
  return createVersion({
    db, sku, raw, reason: opts.reason ?? '测试版本', actorId: opts.actorId ?? 'u-stew',
    baseVersionId: opts.baseVersionId ?? null, rulesetVersion: opts.rulesetVersion ?? 1,
    fault: opts.fault ?? null, at: opts.at,
  });
}

module.exports = { USERS, RAW, ALL_DOMAINS, makeWorld, getVersion, binding, approve, reject, create };
