'use strict';
/**
 * 本地虚构身份登录。
 *
 * 明确声明：这不是电子签章/实名认证，只是本地演示用的角色扮演。
 * Cookie 里只放签名过的会话 ID；身份每次从数据库读取（可停用）。
 */
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const ROLE_LABELS = {
  steward: '资料管理员',
  reviewer: '业务审阅',
  compliance: '合规审阅',
  release: '发布经理',
  auditor: '审计员',
};

const ROLE_CAPABILITIES = {
  steward: ['version.create', 'version.read', 'build.retry', 'note.write'],
  reviewer: ['version.read', 'approval.submit', 'approval.withdraw', 'note.write', 'release.read'],
  compliance: ['version.read', 'approval.submit', 'approval.withdraw', 'approval.override_withdraw',
    'note.write', 'release.read', 'release.recall', 'rules.read'],
  release: ['version.read', 'release.read', 'release.publish', 'release.rollback', 'release.recall', 'verify.run', 'note.write'],
  auditor: ['version.read', 'release.read', 'audit.read', 'verify.run', 'rules.read'],
};

function hasCapability(user, capability) {
  return Boolean(user && ROLE_CAPABILITIES[user.role]?.includes(capability));
}

function sign(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function createSessionToken(secret) {
  const id = randomBytes(18).toString('base64url');
  return { id, token: `${id}.${sign(secret, id)}` };
}

function readSessionToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [id, mac] = token.split('.');
  const expected = sign(secret, id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}

function loadSessionUser(db, config, cookieHeader) {
  const token = parseCookies(cookieHeader)[config.sessionCookie];
  if (!token) return null;
  const sessionId = readSessionToken(config.sessionSecret, token);
  if (!sessionId) return null;
  const row = db.prepare(`SELECT s.*, u.handle, u.name, u.role, u.title, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?`).get(sessionId, Date.now());
  if (!row || !row.active) return null;
  return {
    sessionId: row.id,
    id: row.user_id,
    handle: row.handle,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] ?? row.role,
    title: row.title,
    capabilities: ROLE_CAPABILITIES[row.role] ?? [],
  };
}

function createSession(db, config, userId) {
  const { id, token } = createSessionToken(config.sessionSecret);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, now, now + config.sessionTtlMs);
  return { id, token };
}

function destroySession(db, sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

module.exports = {
  ROLE_LABELS,
  ROLE_CAPABILITIES,
  hasCapability,
  parseCookies,
  serializeCookie,
  loadSessionUser,
  createSession,
  destroySession,
};
