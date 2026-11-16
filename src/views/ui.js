'use strict';
/**
 * 无框架服务端渲染。所有动态文本都经 esc()，所有用户输入不回显为 HTML。
 * 页面不依赖外部资源；脚本只有一份本地 app.js。
 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(name, value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return ` ${name}`;
  return ` ${name}="${esc(value)}"`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtShortTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function untilText(ms, now = Date.now()) {
  const diff = Number(ms) - now;
  if (!Number.isFinite(diff)) return '—';
  if (diff <= 0) return '已过期';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function short(hex, n = 10) {
  return hex ? String(hex).slice(0, n) : '—';
}

function hashChip(label, hash, extraClass = '') {
  return `<span class="chip mono ${extraClass}" title="${esc(hash ?? '')}"><span class="chip-k">${esc(label)}</span>${esc(short(hash))}</span>`;
}

function badge(text, kind = 'neutral') {
  return `<span class="badge badge-${esc(kind)}">${esc(text)}</span>`;
}

const STATUS_LABELS = {
  building: '构建中', build_failed: '构建失败', checking: '检查中', check_failed: '检查未通过',
  ready: '待审阅', published: '已发布', retired: '已退役',
  queued: '排队中', running: '执行中', blocked: '已阻止', failed: '失败',
  approved: '批准有效', rejected: '已拒绝', withdrawn: '已撤回', invalidated: '已失效', expired: '已过期',
  passed: '通过', failed_check: '未通过', error: '错误', stale: '已作废',
  superseded: '已被取代', recalled: '已召回', rolled_back: '已回滚',
  published_task: '已发布',
};
const STATUS_KINDS = {
  ready: 'info', published: 'good', building: 'neutral', checking: 'neutral',
  build_failed: 'bad', check_failed: 'bad', retired: 'muted',
  approved: 'good', rejected: 'bad', withdrawn: 'warn', invalidated: 'bad', expired: 'warn',
  passed: 'good', failed: 'bad', stale: 'muted', error: 'bad',
  queued: 'neutral', running: 'info', blocked: 'warn', failed_task: 'bad',
  superseded: 'muted', recalled: 'bad', rolled_back: 'warn',
};

function statusBadge(status) {
  return badge(STATUS_LABELS[status] ?? status, STATUS_KINDS[status] ?? 'neutral');
}

function layout({ title, user, nav = [], body, flash = null, wide = false, scripts = ['/app.js'] }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 资料发布台</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="${wide ? 'wide' : ''}">
<a class="skip" href="#main">跳到正文</a>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">OKF</span>
    <div>
      <strong>资料发布台</strong>
      <span class="brand-sub">质量检查 ∥ 业务审阅 → 原子发布</span>
    </div>
  </div>
  ${user ? `<div class="whoami">
    <span class="who-name">${esc(user.name)}</span>
    ${badge(user.roleLabel, 'role')}
    <span class="who-title">${esc(user.title)}</span>
    <form method="post" action="/logout" class="inline"><button class="linklike" type="submit">退出</button></form>
  </div>` : ''}
</header>
${nav.length ? `<nav class="tabs" aria-label="主导航">${nav.map((n) => `<a href="${esc(n.href)}" class="${n.active ? 'active' : ''}"${n.active ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('')}</nav>` : ''}
<main id="main">
${flash ? `<div class="flash flash-${esc(flash.kind)}" role="${flash.kind === 'bad' ? 'alert' : 'status'}">${esc(flash.text)}</div>` : ''}
${body}
</main>
<footer class="foot">
  <p><strong>虚构演示环境。</strong>全部商品、品牌、人员身份均为虚构，仅存于本机数据库。本系统<b>不是</b>电子签章或实名认证服务；批准仅是本地角色扮演记录，不具法律效力。</p>
</footer>
${scripts.map((s) => `<script src="${esc(s)}" defer></script>`).join('')}
</body>
</html>`;
}

function section(title, content, { subtitle = '', className = '', id = '' } = {}) {
  return `<section class="card ${className}"${id ? ` id="${esc(id)}"` : ''}>
  <div class="card-head">
    <h2>${esc(title)}</h2>
    ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
  </div>
  ${content}
</section>`;
}

function empty(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

module.exports = {
  esc, attr, fmtTime, fmtShortTime, untilText, short, hashChip, badge, statusBadge,
  layout, section, empty, STATUS_LABELS, STATUS_KINDS,
};
