'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    root: ROOT,
    port: Number(env.PORT || overrides.port || 8787),
    host: env.HOST || overrides.host || '127.0.0.1',
    dbPath: env.DB_PATH || overrides.dbPath || path.join(ROOT, 'data', 'app.db'),
    // 审批授权的有效期。过期样例由演示沙盒单独把 TTL 设短，见 README。
    approvalTtlMs: Number(env.APPROVAL_TTL_MS || overrides.approvalTtlMs || 72 * 3600 * 1000),
    // 会话签名密钥：本地演示默认值；生产应由环境注入。
    sessionSecret: env.SESSION_SECRET || overrides.sessionSecret || 'okf-local-dev-only-not-a-secret',
    sessionCookie: 'okf_session',
    sessionTtlMs: 12 * 3600 * 1000,
    /** 演示沙盒每个会话播种不同的时间/并发边界。 */
    sandbox: env.SANDBOX === '1' || overrides.sandbox === true,
    now: overrides.now || (() => Date.now()),
  };
}

module.exports = { ROOT, loadConfig };
