'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./src/config');
const { openDatabase } = require('./src/db');
const auth = require('./src/auth');
const { HttpError, sendJson, sendHtml, redirect, readJson, readForm, asArray, mapError } = require('./src/http');
const { esc } = require('./src/views/ui');

const config = loadConfig();
const db = openDatabase(config.dbPath);

// 每请求事务之外只读；写操作在领域层内部自行开事务。
const pages = require('./src/views/pages');
const versionPage = require('./src/views/versionPage');
const releasePage = require('./src/views/releasePage');
const adminPages = require('./src/views/adminPages');
const data = require('./src/views/data');
const pipeline = require('./src/domain/pipeline');
const approvals = require('./src/domain/approvals');
const releases = require('./src/domain/releases');
const rules = require('./src/domain/rules');
const samples = require('./src/samples');

const STATIC = {
  '/styles.css': { file: path.join(__dirname, 'public', 'styles.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { file: path.join(__dirname, 'public', 'app.js'), type: 'text/javascript; charset=utf-8' },
};

function requireUser(req) {
  return auth.loadSessionUser(db, config, req.headers.cookie);
}

function guard(user, capability) {
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', '请先选择身份登录');
  if (capability && !auth.hasCapability(user, capability)) {
    throw new HttpError(403, 'FORBIDDEN', `当前身份不能执行此操作`);
  }
  return user;
}

function nowMs() {
  return config.now();
}

function flashFrom(query) {
  const ok = query.get('ok');
  const err = query.get('err');
  if (ok) return { kind: 'good', text: decodeURIComponent(ok) };
  if (err) return { kind: 'bad', text: decodeURIComponent(err) };
  return null;
}

function redirectWith(res, location, { ok = null, err = null } = {}) {
  const url = new URL(location, 'http://local');
  if (ok) url.searchParams.set('ok', encodeURIComponent(ok));
  if (err) url.searchParams.set('err', encodeURIComponent(err));
  return redirect(res, url.pathname + url.search);
}

function navOf(user) {
  return pages.NAV('skus');
}

function errorPage(res, user, err) {
  const mapped = mapError(err);
  const title = mapped.status === 403 ? '没有权限' : mapped.status === 404 ? '未找到' : mapped.status === 401 ? '需要登录' : '操作未能完成';
  const body = `<div class="page-head"><h1>${esc(title)}</h1></div>
  <section class="card"><p class="error-box">${esc(mapped.message)}</p>
  <p class="small muted">代码：${esc(mapped.code)}</p>
  <p><a class="btn" href="/">返回商品列表</a></p></section>`;
  const { layout } = require('./src/views/ui');
  sendHtml(res, mapped.status, layout({ title, user, nav: user ? navOf(user) : [], body }));
}

function parseRawFromForm(form) {
  const raw = {
    sku: form.raw_sku,
    name: form.raw_name,
    brand: form.raw_brand,
    category: form.raw_category,
    description: form.raw_description,
    price: form.raw_price,
    currency: form.raw_currency,
    tax_included: form.raw_tax_included === 'true',
    inventory: form.raw_inventory,
    lead_time_days: form.raw_lead_time_days,
    status: form.raw_status,
    markets: asArray(form.raw_markets),
    labels: asArray(form.raw_labels),
    allergen_note: form.raw_allergen_note,
    origin_country: form.raw_origin_country,
  };
  for (const key of Object.keys(raw)) if (raw[key] === '') raw[key] = null;
  return raw;
}

// ---------------------------------------------------------------- routes

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  if (STATIC[p]) {
    const stat = STATIC[p];
    if (!fs.existsSync(stat.file)) throw new HttpError(404, 'NOT_FOUND', '资源不存在');
    const content = fs.readFileSync(stat.file);
    res.writeHead(200, { 'Content-Type': stat.type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
    return;
  }

  const user = requireUser(req);

  if (method === 'GET' && p === '/login') {
    const users = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY role, name').all();
    sendHtml(res, 200, pages.loginPage({ users, error: q.get('error'), next: q.get('next') ?? '/' }));
    return;
  }

  if (method === 'POST' && p === '/login') {
    const form = await readForm(req);
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(form.userId);
    if (!u) throw new HttpError(400, 'BAD_IDENTITY', '请选择一个有效身份');
    const { token } = auth.createSession(db, config, u.id);
    const session = auth.serializeCookie(config.sessionCookie, token, { maxAge: config.sessionTtlMs });
    redirect(res, form.next && form.next.startsWith('/') ? form.next : '/', { 'Set-Cookie': session });
    return;
  }

  if (method === 'POST' && p === '/logout') {
    if (user) auth.destroySession(db, user.sessionId);
    redirect(res, '/login', { 'Set-Cookie': auth.serializeCookie(config.sessionCookie, '', { maxAge: 0 }) });
    return;
  }

  if (!user) {
    if (p.startsWith('/api/')) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
    redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`);
    return;
  }

  // ---- 页面
  if (method === 'GET' && p === '/') {
    const skus = data.listSkus(db);
    const summaries = Object.fromEntries(skus.map((s) => [s.sku, data.skuOverview(db, s.sku, { now: nowMs() })]));
    sendHtml(res, 200, pages.skuListPage({ user, skus, summaries }));
    return;
  }

  if (method === 'GET' && p === '/rules') {
    const rulesets = rules.listRuleSets();
    const active = db.prepare('SELECT * FROM rulesets WHERE active = 1').get();
    sendHtml(res, 200, adminPages.rulesPage({ user, rulesets, activeId: q.get('set') ?? active?.id ?? rulesets[0].id }));
    return;
  }

  if (method === 'GET' && p === '/audit') {
    guard(user, 'audit.read');
    const entries = require('./src/store/audit').listAudit(db, { limit: 150 });
    const users = data.userMap(db);
    sendHtml(res, 200, adminPages.auditPage({ user, entries, users }));
    return;
  }

  if (method === 'GET' && p === '/samples') {
    sendHtml(res, 200, samples.samplesPage({ user, db, now: nowMs() }));
    return;
  }

  if (p === '/samples/run' && method === 'POST') {
    const form = await readForm(req);
    const name = form.name;
    let result;
    try {
      result = await samples.runSample({ db, name, user });
    } catch (err) {
      redirectWith(res, '/samples', { err: `样例运行失败：${err.message}` });
      return;
    }
    redirectWith(res, result.versionLink ?? '/samples', {
      ok: name === 'build-failure' ? '样例已运行：构建失败 → 重试成功，请查看版本页' : '样例已运行：批准已过期，发布被阻止',
    });
    return;
  }

  let m = p.match(/^\/skus\/([^/]+)$/);
  if (method === 'GET' && m) {
    const sku = decodeURIComponent(m[1]);
    const overview = data.skuOverview(db, sku, { now: nowMs() });
    if (!overview) throw new HttpError(404, 'SKU_NOT_FOUND', '商品不存在');
    sendHtml(res, 200, pages.skuPage({ user, data: overview, flash: flashFrom(q) }));
    return;
  }

  m = p.match(/^\/skus\/([^/]+)\/correct$/);
  if (m && (method === 'GET' || method === 'POST')) {
    guard(user, 'version.create');
    const sku = decodeURIComponent(m[1]);
    if (!data.getSku(db, sku)) throw new HttpError(404, 'SKU_NOT_FOUND', '商品不存在');
    const baseId = method === 'GET' ? q.get('base') : (await readForm(req)).base;
    const base = baseId ? data.getVersion(db, baseId) : null;
    if (base && base.sku !== sku) throw new HttpError(400, 'BAD_BASE', '基线版本不属于该 SKU');
    sendHtml(res, 200, adminPages.correctPage({ user, sku, base }));
    return;
  }

  m = p.match(/^\/versions\/([^/]+)$/);
  if (method === 'GET' && m) {
    const detail = data.versionDetail(db, decodeURIComponent(m[1]), { now: nowMs() });
    if (!detail) throw new HttpError(404, 'VERSION_NOT_FOUND', '版本不存在');
    sendHtml(res, 200, versionPage.versionPage({ user, detail, flash: flashFrom(q) }));
    return;
  }

  m = p.match(/^\/releases\/([^/]+)$/);
  if (method === 'GET' && m) {
    const detail = data.releaseDetail(db, decodeURIComponent(m[1]), { now: nowMs() });
    if (!detail) throw new HttpError(404, 'RELEASE_NOT_FOUND', '发布不存在');
    sendHtml(res, 200, releasePage.releasePage({ user, detail, flash: flashFrom(q) }));
    return;
  }

  // ---- 下载
  m = p.match(/^\/download\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && m) {
    const releaseId = decodeURIComponent(m[1]);
    const name = decodeURIComponent(m[2]);
    const row = db.prepare('SELECT * FROM release_artifacts WHERE release_id = ? AND name = ?').get(releaseId, name);
    if (!row) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    res.writeHead(200, {
      'Content-Type': row.content_type,
      'Content-Length': row.bytes.length,
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.from(row.bytes));
    return;
  }

  m = p.match(/^\/download\/([^/]+)\.zip$/);
  if (method === 'GET' && m) {
    const release = releases.getRelease(db, decodeURIComponent(m[1]));
    if (!release) throw new HttpError(404, 'RELEASE_NOT_FOUND', '发布不存在');
    const zip = samples.buildZip(db, release.id);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      'Content-Disposition': `attachment; filename="${release.sku}-gen${release.generation}.zip"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(zip);
    return;
  }

  // ---- API: 版本
  m = p.match(/^\/api\/skus\/([^/]+)\/versions$/);
  if (method === 'POST' && m) {
    guard(user, 'version.create');
    const sku = decodeURIComponent(m[1]);
    const form = await readForm(req);
    const raw = parseRawFromForm(form);
    if (!raw.sku) raw.sku = sku;
    if (raw.sku !== sku) throw new HttpError(400, 'SKU_MISMATCH', '表单 SKU 与路径不一致');
    const result = pipeline.createVersion({
      db, sku, raw, source: 'correction', baseVersionId: form.baseVersionId || null,
      reason: form.reason ?? '', actorId: user.id, at: nowMs(),
    });
    const dest = `/versions/${result.versionId}`;
    if (result.status === 'build_failed') {
      redirectWith(res, dest, { err: `构建失败：${result.error.message}` });
    } else if (result.status === 'check_failed') {
      redirectWith(res, dest, { err: '质量检查未通过，请查看阻断项后更正' });
    } else {
      redirectWith(res, dest, { ok: '已构建并通过检查，等待审阅' });
    }
    return;
  }

  m = p.match(/^\/api\/versions\/([^/]+)\/retry$/);
  if (method === 'POST' && m) {
    guard(user, 'build.retry');
    const versionId = decodeURIComponent(m[1]);
    const result = pipeline.retryBuild({ db, versionId, actorId: user.id, at: nowMs() });
    redirectWith(res, `/versions/${versionId}`, result.status === 'build_failed'
      ? { err: `重试仍失败：${result.error.message}` }
      : { ok: '重建成功' });
    return;
  }

  m = p.match(/^\/api\/versions\/([^/]+)\/decision$/);
  if (method === 'POST' && m) {
    const versionId = decodeURIComponent(m[1]);
    const form = await readForm(req);
    const mode = form.mode === 'reject' ? 'reject' : 'approve';
    guard(user, 'approval.submit');
    const reviewed = asArray(form.domains);
    const carry = [];
    for (const [key, value] of Object.entries(form)) {
      if (key.startsWith('carry_') && value) carry.push({ domain: key.slice('carry_'.length), approvalId: value });
    }
    const result = approvals.submitDecision({
      db, versionId, actorId: user.id, actorRole: user.role, actorName: user.name, mode,
      selection: { domains: reviewed, carry }, note: form.note ?? '',
      acknowledgedWarnings: asArray(form.warningAck),
      expected: {
        dataHash: form.expected_dataHash, rulesHash: form.expected_rulesHash,
        resultHash: form.expected_resultHash, checkRunId: form.expected_checkRunId,
        reviewSerial: Number(form.expected_reviewSerial),
      },
      at: nowMs(),
    });
    redirectWith(res, `/versions/${versionId}`, { ok: mode === 'approve' ? '批准已记录（绑定当前输入、规则与结果）' : '已记录拒绝' });
    return;
  }

  m = p.match(/^\/api\/approvals\/([^/]+)\/withdraw$/);
  if (method === 'POST' && m) {
    const approvalId = decodeURIComponent(m[1]);
    const form = await readForm(req);
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval) throw new HttpError(404, 'APPROVAL_NOT_FOUND', '批准不存在');
    const result = approvals.withdrawApproval({
      db, approvalId, actorId: user.id, actorRole: user.role, reason: form.reason ?? '', at: nowMs(),
    });
    redirectWith(res, `/versions/${approval.version_id}`, { ok: '批准已撤回，相关在途发布将失效' });
    return;
  }

  // ---- API: 发布
  m = p.match(/^\/api\/skus\/([^/]+)\/publish$/);
  if (method === 'POST' && m) {
    guard(user, 'release.publish');
    const sku = decodeURIComponent(m[1]);
    const form = await readForm(req);
    const task = releases.enqueuePublishTask({
      db, sku, versionId: form.versionId, actorId: user.id, note: form.note ?? '',
      expected: {
        approvalSetHash: form.approvalSetHash,
        currentReleaseId: form.currentReleaseId === '' ? null : form.currentReleaseId,
        generation: form.generation === undefined ? undefined : Number(form.generation),
      },
      at: nowMs(),
    });
    const out = releases.executePublishTask({ db, taskId: task.taskId, at: nowMs() });
    if (out.status === 'published') {
      redirectWith(res, `/releases/${out.releaseId}`, { ok: `已发布为第 ${out.generation} 代` });
    } else {
      redirectWith(res, `/skus/${encodeURIComponent(sku)}`, { err: `发布未执行：${out.reason}` });
    }
    return;
  }

  m = p.match(/^\/api\/skus\/([^/]+)\/rollback$/);
  if (method === 'POST' && m) {
    guard(user, 'release.rollback');
    const sku = decodeURIComponent(m[1]);
    const form = await readForm(req);
    const task = releases.enqueueRollbackTask({
      db, sku, targetReleaseId: form.targetReleaseId, actorId: user.id, reason: form.reason ?? '',
      expected: { currentReleaseId: form.currentReleaseId },
      at: nowMs(),
    });
    const out = releases.executeRollbackTask({ db, taskId: task.taskId, at: nowMs() });
    if (out.status === 'published') {
      redirectWith(res, `/releases/${out.releaseId}`, { ok: `已回滚为第 ${out.generation} 代` });
    } else {
      redirectWith(res, `/skus/${encodeURIComponent(sku)}`, { err: `回滚未执行：${out.reason}` });
    }
    return;
  }

  m = p.match(/^\/api\/skus\/([^/]+)\/recall$/);
  if (method === 'POST' && m) {
    guard(user, 'release.recall');
    const sku = decodeURIComponent(m[1]);
    const form = await readForm(req);
    const out = releases.recallCurrent({
      db, sku, actorId: user.id, actorRole: user.role, reason: form.reason ?? '', at: nowMs(),
    });
    redirectWith(res, `/skus/${encodeURIComponent(sku)}`, { ok: `已召回第 ${db.prepare('SELECT generation FROM releases WHERE id=?').get(out.recalledReleaseId)?.generation} 代` });
    return;
  }

  m = p.match(/^\/api\/releases\/([^/]+)\/verify$/);
  if (method === 'POST' && m) {
    guard(user, 'verify.run');
    const releaseId = decodeURIComponent(m[1]);
    const out = releases.verifyRelease(db, releaseId, { at: nowMs(), actorId: user.id });
    redirectWith(res, `/releases/${releaseId}`, out.ok
      ? { ok: `核验通过：${out.details.length} 项检查全部一致` }
      : { err: `核验失败：${out.details.filter((d) => !d.ok).map((d) => d.id).join(', ')}` });
    return;
  }

  // ---- API: JSON（供测试与自动化）
  if (p === '/api/status') {
    sendJson(res, 200, {
      user: { id: user.id, role: user.role },
      skus: data.listSkus(db).map((s) => {
        const cur = releases.currentRelease(db, s.sku);
        return { sku: s.sku, currentRelease: cur ? { id: cur.id, generation: cur.generation } : null };
      }),
      now: nowMs(),
    });
    return;
  }

  m = p.match(/^\/api\/versions\/([^/]+)$/);
  if (method === 'GET' && m) {
    const detail = data.versionDetail(db, decodeURIComponent(m[1]), { now: nowMs() });
    if (!detail) throw new HttpError(404, 'VERSION_NOT_FOUND', '版本不存在');
    sendJson(res, 200, {
      id: detail.version.id,
      sku: detail.version.sku,
      seq: detail.version.seq,
      status: detail.version.status,
      reviewSerial: detail.version.review_serial,
      binding: detail.binding,
      impact: {
        scope: detail.impact.scope,
        affectedDomains: detail.impact.affectedDomains,
        carryableDomains: detail.impact.carryableDomains,
        reasons: detail.impact.reasons,
      },
      approvals: detail.approvals.map((a) => ({
        id: a.id, status: a.status, valid: a.evaluation.valid, reason: a.evaluation.reason,
        domains: a.domainList, scope: a.scope, expiresAt: a.expires_at,
        domainValidity: a.evaluation.domainValidity ?? null,
      })),
      publishable: {
        ok: detail.publishable.publishable,
        approvalSetHash: detail.publishable.approvalSetHash,
        reasons: detail.publishable.reasons,
      },
    });
    return;
  }

  m = p.match(/^\/api\/releases\/([^/]+)$/);
  if (method === 'GET' && m) {
    const detail = data.releaseDetail(db, decodeURIComponent(m[1]), { now: nowMs() });
    if (!detail) throw new HttpError(404, 'RELEASE_NOT_FOUND', '发布不存在');
    sendJson(res, 200, {
      id: detail.release.id,
      sku: detail.release.sku,
      generation: detail.release.generation,
      status: detail.release.status,
      snapshotHash: detail.release.snapshot_hash,
      approvalSetHash: detail.release.approval_set_hash,
      manifestHash: detail.release.manifest_hash,
      artifacts: detail.artifacts,
      approvals: detail.approvals.map((a) => ({
        id: a.id, reviewerId: a.reviewer_id, nowValid: a.nowValid, nowReason: a.nowReason,
      })),
    });
    return;
  }

  if (p === '/api/samples/run' && method === 'POST') {
    const form = await readJson(req);
    const result = await samples.runSample({ db, name: form.name, user, config });
    sendJson(res, 200, result);
    return;
  }

  throw new HttpError(404, 'NOT_FOUND', '路径不存在');
}

const server = require('node:http').createServer((req, res) => {
  handle(req, res).catch((err) => {
    let user = null;
    try { user = requireUser(req); } catch { /* 忽略 */ }
    const mapped = mapError(err);
    if (req.url?.startsWith('/api/')) {
      sendJson(res, mapped.status, { error: { code: mapped.code, message: mapped.message, detail: mapped.detail } });
    } else {
      try { errorPage(res, user, err); } catch { sendJson(res, 500, { error: { code: 'INTERNAL' } }); }
    }
    if (mapped.status >= 500 && process.env.NODE_ENV !== 'test') {
      console.error('[error]', req.method, req.url, err);
    }
  });
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`资料发布台已启动：http://${config.host}:${config.port}`);
    console.log('本地虚构身份演示；非电子签章服务。');
  });
}

module.exports = { server, db, config, handle };
