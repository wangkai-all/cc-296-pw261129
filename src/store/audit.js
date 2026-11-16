'use strict';
const { randomUUID } = require('node:crypto');
const { canonicalJson } = require('../canonical');

/** 追加式审计：所有状态变更都必须留痕，且由触发器保证不可改。 */
function audit(db, actorId, action, subject, detail = {}) {
  db.prepare(
    'INSERT INTO audit_log (at, actor_id, action, subject, detail_json) VALUES (?, ?, ?, ?, ?)',
  ).run(Date.now(), actorId ?? null, action, subject, canonicalJson(detail));
}

function listAudit(db, { limit = 100, subject = null } = {}) {
  const rows = subject
    ? db.prepare('SELECT * FROM audit_log WHERE subject = ? ORDER BY id DESC LIMIT ?').all(subject, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actorId: r.actor_id,
    action: r.action,
    subject: r.subject,
    detail: JSON.parse(r.detail_json),
  }));
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

module.exports = { audit, listAudit, newId };
