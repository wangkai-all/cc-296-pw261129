'use strict';
const {
  esc, attr, fmtTime, fmtShortTime, untilText, short, hashChip, badge, statusBadge,
  layout, section, empty,
} = require('./ui');
const { DOMAIN_LABELS } = require('../domain/catalog');

const NAV = (active) => [
  { href: '/', label: '商品', active: active === 'skus' },
  { href: '/rules', label: '规则集', active: active === 'rules' },
  { href: '/audit', label: '审计', active: active === 'audit' },
  { href: '/samples', label: '演示样例', active: active === 'samples' },
];

function loginPage({ users, error = null, next = '/' }) {
  const groups = {};
  for (const u of users) (groups[u.role] ??= []).push(u);
  const roleNames = {
    steward: '资料管理员（上报与更正）', reviewer: '业务审阅（可批准）',
    compliance: '合规审阅（可批准/强制撤回/召回）', release: '发布经理（发布/回滚）', auditor: '审计（只读+核验）',
  };
  const body = `<div class="login-wrap">
  <section class="card login-card">
    <h1>以虚构身份进入</h1>
    <p class="sub">这是本地演示环境。选择一个角色开始；不存在密码、短信或电子签章流程。</p>
    ${error ? `<div class="flash flash-bad" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${esc(next)}">
      ${Object.entries(groups).map(([role, list]) => `<fieldset class="identity-group">
        <legend>${esc(roleNames[role] ?? role)}</legend>
        ${list.map((u) => `<label class="identity-option">
          <input type="radio" name="userId" value="${esc(u.id)}"${u.handle === 'shen-he' ? ' checked' : ''}>
          <span class="identity-name">${esc(u.name)}</span>
          <span class="identity-meta mono">@${esc(u.handle)}</span>
          <span class="identity-title">${esc(u.title)}</span>
        </label>`).join('')}
      </fieldset>`).join('')}
      <button class="btn primary" type="submit">进入发布台</button>
    </form>
    <p class="disclaimer">身份与商品均属虚构；批准记录不是电子签名。</p>
  </section>
</div>`;
  return layout({ title: '登录', user: null, body, nav: [] });
}

function skuListPage({ user, skus, summaries }) {
  const rows = skus.map((s) => {
    const o = summaries[s.sku];
    const current = o?.current;
    return `<tr>
      <td><a class="strong" href="/skus/${esc(s.sku)}">${esc(s.sku)}</a><div class="muted small">${esc(s.name)}</div></td>
      <td>${current
    ? `<span class="mono small">第 ${current.generation} 代</span> ${statusBadge('published')}<div class="muted small">${esc(fmtShortTime(current.published_at))}</div>`
    : '<span class="muted">尚未发布</span>'}</td>
      <td>${o.pending.length ? o.pending.map((v) => `<a class="mini" href="/versions/${esc(v.id)}">v${v.seq} ${statusBadge(v.status)}</a>`).join(' ') : '<span class="muted">—</span>'}</td>
      <td>${o.publishableVersions.length ? badge(`${o.publishableVersions.length} 个可发布`, 'good') : '<span class="muted">—</span>'}</td>
      <td class="right"><a class="btn small" href="/skus/${esc(s.sku)}">查看</a></td>
    </tr>`;
  }).join('');
  const body = `<div class="page-head">
    <div>
      <h1>商品资料</h1>
      <p class="sub">先过质量检查，再经业务与合规审阅，最后由发布经理落一枚可核验的发布回执。</p>
    </div>
  </div>
  ${section('全部商品', `<table class="grid">
    <thead><tr><th>SKU / 名称</th><th>当前发布</th><th>待审阅版本</th><th>可发布</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">暂无商品</td></tr>'}</tbody>
  </table><p class="hint">提示：每个 SKU 同一时刻只可能有一个“当前发布”。回滚不会改写历史回执，而是生成新代号并指向原产物。</p>`)}`;
  return layout({ title: '商品资料', user, nav: NAV('skus'), body });
}

function skuPage({ user, data }) {
  const { sku: skuRecord, current, versions, releases, tasks, publishableVersions } = data;
  const sku = skuRecord;
  const canCreate = user.capabilities.includes('version.create');
  const versionRows = versions.map((v) => `<tr class="${v.status === 'retired' ? 'row-muted' : ''}">
    <td><a href="/versions/${esc(v.id)}" class="strong">v${v.seq}</a>
      <div class="muted small">${esc(fmtShortTime(v.created_at))}</div></td>
    <td>${statusBadge(v.status === 'published' ? 'published' : v.status)}</td>
    <td class="wrap">${esc(v.reason)}</td>
    <td>${v.warnings ? badge(`${v.warnings} 警告`, 'warn') : ''}${v.blocking ? badge(`${v.blocking} 阻断`, 'bad') : ''}${!v.warnings && !v.blocking ? '<span class="muted small">无问题项</span>' : ''}</td>
    <td><div class="dom-mini">${v.coveredDomains.map((d) => `<span class="dot-on" title="${esc(DOMAIN_LABELS[d])} 已有有效批准">${esc(DOMAIN_LABELS[d].slice(0, 2))}</span>`).join('')}${['identity', 'pricing', 'compliance', 'inventory'].filter((d) => !v.coveredDomains.includes(d)).map((d) => `<span class="dot-off" title="${esc(DOMAIN_LABELS[d])} 尚无有效批准">${esc(DOMAIN_LABELS[d].slice(0, 2))}</span>`).join('')}</div></td>
    <td>${v.canPublish.publishable ? badge('可发布', 'good') : `<span class="muted small">${esc(v.canPublish.reasons[0] ?? '—')}</span>`}</td>
    <td class="right"><a class="btn small" href="/versions/${esc(v.id)}">打开</a></td>
  </tr>`).join('');

  const releaseRows = releases.map((r) => `<tr class="${r.status === 'published' ? 'row-current' : ''}">
    <td><span class="strong mono">第 ${r.generation} 代</span>${r.status === 'published' ? ' ' + badge('当前', 'good') : ''}
      <div class="muted small">${esc(fmtShortTime(r.published_at))}</div></td>
    <td>${statusBadge(r.status)}</td>
    <td><a href="/releases/${esc(r.id)}" class="mono small">${esc(short(r.id, 14))}</a>
      ${r.restores_release_id ? `<div class="muted small">回落自 ${esc(short(r.restores_release_id, 10))}</div>` : ''}</td>
    <td>${hashChip('版本', r.snapshot_hash)}</td>
    <td><a class="btn small" href="/releases/${esc(r.id)}">回执</a></td>
  </tr>`).join('');

  const canPublishTask = user.capabilities.includes('release.publish');
  const pendingCards = publishableVersions.map((v) => `<div class="pending-card">
    <div>
      <a href="/versions/${esc(v.id)}" class="strong">v${v.seq}</a> ${badge('可发布', 'good')}
      <p class="muted small">${esc(v.reason)}</p>
    </div>
    ${canPublishTask ? `<form method="post" action="/api/skus/${esc(skuRecord.sku)}/publish" class="inline" data-confirm="确认将该版本发布为第 ${(current?.generation ?? 0) + 1} 代？">
      <input type="hidden" name="versionId" value="${esc(v.id)}">
      <input type="hidden" name="approvalSetHash" value="${esc(v.canPublish.approvalSetHash)}">
      <input type="hidden" name="currentReleaseId" value="${esc(current?.id ?? '')}">
      <input type="hidden" name="generation" value="${esc(current?.generation ?? 0)}">
      <button class="btn primary small" type="submit">发布</button>
    </form>` : ''}
  </div>`).join('');

  const taskRows = tasks.slice(0, 8).map((t) => `<tr>
    <td class="mono small">${esc(short(t.id, 14))}</td>
    <td>${t.kind === 'publish' ? '发布' : '回滚'}</td>
    <td>${statusBadge(t.status === 'published' ? 'published_task' : t.status)}</td>
    <td class="wrap small">${esc(t.blocked_reason ?? t.note ?? '')}</td>
    <td class="small muted">${esc(fmtShortTime(t.created_at))}</td>
    <td>${t.release_id ? `<a class="small" href="/releases/${esc(t.release_id)}">回执</a>` : ''}</td>
  </tr>`).join('');

  const latestSeq = versions[0]?.seq ?? 0;
  const body = `<div class="page-head">
    <div>
      <h1>${esc(sku.sku)} <span class="muted">${esc(sku.name)}</span></h1>
      <p class="sub">当前发布：${current ? `第 ${current.generation} 代（${esc(fmtTime(current.published_at))}）` : '无'}</p>
    </div>
    ${canCreate ? `<a class="btn" href="/skus/${esc(sku.sku)}/correct">新版本 / 更正</a>` : ''}
  </div>

  ${section('当前发布', current
    ? `<div class="live-banner">
        <div><span class="live-k">当前线上</span><a class="mono" href="/releases/${esc(current.id)}">第 ${current.generation} 代</a></div>
        <div>${hashChip('数据', current.snapshot_hash)}${hashChip('批准集', current.approval_set_hash)}</div>
        <div class="small muted">发布于 ${esc(fmtTime(current.published_at))}</div>
        ${user.capabilities.includes('release.rollback') ? rollbackForm(current, releases) : ''}
      </div>`
    : `<div class="empty-banner">当前没有已发布版本。${publishableVersions.length ? '有版本可发布，见下方。' : '完成审阅后即可发布。'}</div>`)}

  ${section('待发布', pendingCards || empty('没有可发布的版本。'), { subtitle: '发布前会再次复验批准集合指纹；任何撤回/过期都会使发布失败。' })}

  ${section('版本历史', `<table class="grid">
    <thead><tr><th>版本</th><th>状态</th><th>原因</th><th>检查</th><th>审阅覆盖</th><th>可发布</th><th></th></tr></thead>
    <tbody>${versionRows || '<tr><td colspan="7" class="muted">尚无版本</td></tr>'}</tbody>
  </table>`)}

  ${section('发布回执', `<table class="grid">
    <thead><tr><th>代号</th><th>状态</th><th>回执</th><th>数据快照</th><th></th></tr></thead>
    <tbody>${releaseRows || '<tr><td colspan="5" class="muted">尚无发布</td></tr>'}</tbody>
  </table><p class="hint">回执与产物不可修改；回滚会生成新的代号并指回原产物。</p>`)}

  ${section('近期发布任务', `<table class="grid compact">
    <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>说明</th><th>时间</th><th></th></tr></thead>
    <tbody>${taskRows || '<tr><td colspan="6" class="muted">无</td></tr>'}</tbody>
  </table>`, { subtitle: '任务创建时钉住当前代号、批准集指纹与版本审阅序号；执行时逐项复验。' })}
  `;
  return layout({ title: sku.sku, user, nav: NAV('skus'), body, wide: true });
}

function rollbackForm(current, releases) {
  const targets = releases.filter((r) => r.id !== current.id && r.status !== 'recalled' && r.status !== 'rolled_back');
  if (!targets.length) return '<span class="muted small">暂无可回滚的历史发布</span>';
  return `<form method="post" action="/api/skus/${esc(current.sku)}/rollback" class="inline rollback-form" data-confirm="回滚会生成新代号并把线上指回所选产物，确认？">
    <input type="hidden" name="currentReleaseId" value="${esc(current.id)}">
    <label class="small">回滚至
      <select name="targetReleaseId" required>
        ${targets.map((r) => `<option value="${esc(r.id)}">第 ${r.generation} 代 · ${esc(short(r.id, 10))} · ${esc(fmtShortTime(r.published_at))}</option>`).join('')}
      </select>
    </label>
    <input name="reason" placeholder="回滚原因（必填）" required maxlength="200" class="input-inline">
    <button class="btn small" type="submit">回滚</button>
  </form>`;
}

function notFoundPage({ user, what = '页面' }) {
  return layout({
    title: '未找到', user, nav: NAV(null),
    body: `<div class="page-head"><h1>404</h1></div>${section('找不到内容', empty(`${what}不存在，或已被移到别处。`))}`,
  });
}

module.exports = { NAV, loginPage, skuListPage, skuPage, notFoundPage };
