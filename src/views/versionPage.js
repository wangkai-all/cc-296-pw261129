'use strict';
const {
  esc, fmtTime, fmtShortTime, untilText, short, hashChip, badge, statusBadge,
  layout, section, empty,
} = require('./ui');
const { NAV } = require('./pages');
const { DOMAIN_LABELS } = require('../domain/catalog');

function humanValue(value) {
  if (value === null || value === undefined) return '<span class="null">（空）</span>';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return esc(value.join('、')) || '<span class="null">（空）</span>';
  if (typeof value === 'object') return `<code class="mono small">${esc(JSON.stringify(value))}</code>`;
  return esc(value);
}

function findingsTable(findings, { showDomain = true } = {}) {
  if (!findings.length) return empty('没有检查项');
  return `<table class="grid compact findings">
    <thead><tr>${showDomain ? '<th>域</th>' : ''}<th>规则</th><th>结论</th><th>说明</th></tr></thead>
    <tbody>${findings.map((f) => `<tr class="${f.passed ? '' : f.severity === 'blocking' ? 'row-bad' : 'row-warn'}">
      ${showDomain ? `<td class="small">${esc(DOMAIN_LABELS[f.domain] ?? f.domain)}</td>` : ''}
      <td class="mono small">${esc(f.ruleId)}</td>
      <td>${f.passed ? badge('通过', 'good') : badge(f.severity === 'blocking' ? '阻断' : '警告', f.severity === 'blocking' ? 'bad' : 'warn')}</td>
      <td class="wrap small">${esc(f.message)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function bindingPanel(detail) {
  const { binding, version, check, rules } = detail;
  if (!binding) {
    return `<div class="binding-grid">
      <div class="binding-item">
        <span class="binding-k">输入数据指纹</span>
        <span class="mono binding-v"><span class="null">—</span></span>
        <span class="muted small">源包 ${esc((version.raw_hash ?? '').slice(0, 16))}… 尚未产生规范化快照</span>
      </div>
      <div class="binding-item">
        <span class="binding-k">规则集</span>
        <span class="binding-v"><span class="null">—</span></span>
        <span class="muted small">构建失败，未执行质量检查</span>
      </div>
      <div class="binding-item">
        <span class="binding-k">检查结果指纹</span>
        <span class="mono binding-v"><span class="null">—</span></span>
        <span class="muted small">没有检查记录</span>
      </div>
      <div class="binding-item">
        <span class="binding-k">审阅序号</span>
        <span class="mono binding-v">#${version.review_serial}</span>
        <span class="muted small">构建失败时不产生可批准的绑定值</span>
      </div>
    </div>
    <p class="hint">构建失败没有可审阅的数据快照，因此不存在可绑定的四项指纹；该版本不能被批准或发布。</p>`;
  }
  return `<div class="binding-grid">
    <div class="binding-item">
      <span class="binding-k">输入数据指纹</span>
      <span class="mono binding-v">${esc(binding.dataHash)}</span>
      <span class="muted small">源包 ${esc(version.raw_hash.slice(0, 16))}… → 规范化快照</span>
    </div>
    <div class="binding-item">
      <span class="binding-k">规则集</span>
      <span class="binding-v">${esc(rules?.id ?? '—')} <span class="mono small">${esc(binding.rulesHash)}</span></span>
      <span class="muted small">${esc(rules?.title ?? '')}</span>
    </div>
    <div class="binding-item">
      <span class="binding-k">检查结果指纹</span>
      <span class="mono binding-v">${esc(binding.resultHash)}</span>
      <span class="muted small">检查 ${esc(short(check?.id ?? '', 14))} · 引擎 ${esc(check?.engine_version ?? '—')}</span>
    </div>
    <div class="binding-item">
      <span class="binding-k">审阅序号</span>
      <span class="mono binding-v">#${version.review_serial}</span>
      <span class="muted small">撤回/失效/更正会递增，使在途批准与发布任务失效</span>
    </div>
  </div>
  <p class="hint">批准将同时绑定以上四项。任一变化都会使已有批准在核验时立即失效——即使页面上还显示着“已批准”。</p>`;
}

function statusStrip(detail) {
  const { version, check, publishable, impact } = detail;
  return `<ol class="pipeline" aria-label="流程状态">
    <li class="${version.status === 'build_failed' ? 'bad' : 'done'}"><span>1</span>构建 ${version.status === 'build_failed' ? '失败' : '完成'}</li>
    <li class="${check ? (check.status === 'passed' ? 'done' : 'bad') : ''}"><span>2</span>质量检查 ${check ? (check.status === 'passed' ? '通过' : '未通过') : '—'}</li>
    <li class="${detail.approvals.some((a) => a.evaluation.valid) ? 'done' : ''}"><span>3</span>审阅批准</li>
    <li class="${version.status === 'published' ? 'done' : ''}"><span>4</span>发布</li>
  </ol>
  <div class="status-meta">
    ${impact.scope === 'targeted'
    ? badge(`补审 ${impact.requiredReviewDomains.map((d) => DOMAIN_LABELS[d]).join('、')}`, 'info')
    : badge('需全审', 'info')}
    ${publishable.publishable ? badge('可发布', 'good') : badge('不可发布', 'warn')}
    ${version.status === 'retired' ? badge('版本已退役', 'muted') : ''}
  </div>`;
}

function impactPanel(detail) {
  const { impact, base } = detail;
  const reasons = impact.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('');
  const diffRows = impact.diff?.length
    ? impact.diff.map((d) => `<tr><td class="mono small">${esc(d.field)}</td><td class="small">${esc(DOMAIN_LABELS[d.domain] ?? d.domain)}</td>
        <td class="small wrap">${humanValue(d.before)}</td><td class="small wrap">${humanValue(d.after)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">与基线相比没有字段差异</td></tr>';
  const carry = impact.carryableDomains.length
    ? `<div class="carry-summary"><strong>可承继域：</strong>${impact.carryableDomains.map((d) => badge(DOMAIN_LABELS[d], 'info')).join(' ')}
       <p class="small muted">承继只能引用基线版本上仍有效的同域批准；发布时会再次复验该批准与本次输入的域指纹是否逐字节一致。</p></div>`
    : '';
  return `<div class="impact">
    <div class="impact-head">
      <div><span class="impact-k">审阅范围</span><strong>${impact.scope === 'targeted' ? `按影响范围补审（${impact.requiredReviewDomains.length} 个域）` : '完整重审（4 个域）'}</strong></div>
      ${base ? `<div class="muted small">相对基线 <a href="/versions/${esc(base.id)}">v${base.seq}</a></div>` : '<div class="muted small">无基线，首个版本</div>'}
    </div>
    <ul class="reason-list">${reasons}</ul>
    ${carry}
    <details class="diff-details"${impact.diff?.length && impact.diff.length <= 12 ? ' open' : ''}>
      <summary>字段级差异（${impact.diff?.length ?? 0}）</summary>
      <table class="grid compact"><thead><tr><th>字段</th><th>域</th><th>此前</th><th>此后</th></tr></thead><tbody>${diffRows}</tbody></table>
    </details>
    <div class="tradeoff">
      <div><span class="tradeoff-k">等待成本</span>${esc(impact.risk.wait)}</div>
      <div><span class="tradeoff-k">误放风险</span>${esc(impact.risk.falseRelease)}</div>
    </div>
  </div>`;
}

function approvalsTable(detail) {
  if (!detail.approvals.length) return empty('还没有人提交决定。');
  return `<table class="grid">
    <thead><tr><th>审阅人</th><th>决定</th><th>覆盖域</th><th>绑定</th><th>有效期</th><th>核验</th></tr></thead>
    <tbody>${detail.approvals.map((a) => {
    const partial = a.status === 'approved' && !a.evaluation.valid
      && a.evaluation.globalValid !== false
      && Object.values(a.evaluation.domainValidity ?? {}).some((d) => d.valid);
    const st = a.status === 'approved' && !a.evaluation.valid && !partial ? 'invalidated' : a.status;
    return `<tr class="${a.evaluation.valid ? '' : 'row-muted'}">
      <td>${esc(a.reviewer?.name ?? a.reviewer_name ?? a.reviewer_id)}
        <div class="muted small">${esc(a.reviewer?.role ?? a.reviewer_role)}</div></td>
      <td>${statusBadge(st)}
        ${a.scope === 'targeted' ? badge('含承继', 'info') : ''}
        ${partial ? `<div class="small">${badge('部分域失效', 'warn')}</div>` : ''}
        ${a.carriedFrom?.length ? `<div class="muted small">承继 ${a.carriedFrom.length} 条</div>` : ''}</td>
      <td class="small">${a.domainLabels.map((l, i) => {
      const row = a.domains[i];
      const dv = row ? a.evaluation.domainValidity?.[row.domain] : null;
      const dead = dv ? !dv.valid : !a.evaluation.valid;
      const why = dead ? (dv?.reason ?? '该批准已失效') : (row?.via === 'carry' ? '承继' : '本人审阅');
      return `<span class="dom-tag ${row?.via === 'carry' ? 'dom-carry' : ''}${dead ? ' dom-dead' : ''}" title="${esc(why)}">${esc(l)}${row?.via === 'carry' ? ' ↩' : ''}</span>`;
    }).join(' ')}</td>
      <td class="small">${hashChip('数据', a.data_hash)}<br>${hashChip('结果', a.result_hash)}</td>
      <td class="small">${esc(fmtShortTime(a.expires_at))}
        <div class="muted small">${esc(untilText(a.expires_at))}</div></td>
      <td class="small wrap">${a.evaluation.valid ? badge('当前有效', 'good')
      : partial ? `<span class="warn-text">部分域仍有效；其余：${esc(a.evaluation.reason)}</span>`
        : `<span class="bad">${esc(a.evaluation.reason)}</span>`}
        ${a.invalidation_reason ? `<div class="muted small">${esc(a.invalidation_reason)}</div>` : ''}</td>
    </tr>`;
  }).join('')}</tbody>
  </table>`;
}

function reviewForm(detail, user, { now = Date.now() } = {}) {
  const { version, binding, rules, findings, impact, publishable } = detail;
  if (!['ready', 'check_failed', 'published'].includes(version.status)) {
    return `<p class="empty">当前状态（${esc(version.status)}）不能提交审阅。</p>`;
  }
  const canApprove = user.capabilities.includes('approval.submit');
  if (!canApprove) {
    return `<p class="empty">当前身份「${esc(user.roleLabel)}」只能查看审阅证据，不能提交决定。</p>`;
  }
  const warnings = findings.filter((f) => !f.passed && f.severity === 'warning');
  const required = rules?.review?.requiredDomains ?? ['identity', 'pricing', 'compliance', 'inventory'];
  const affected = new Set(impact.requiredReviewDomains);
  const carryOptions = {};
  for (const domain of impact.carryableDomains) carryOptions[domain] = impact.carrySources?.[domain] ?? [];

  const domainRows = required.map((d) => {
    const f = detail.reviewDomains.find((r) => r.id === d);
    const mustReview = affected.has(d);
    return `<div class="domain-choice ${mustReview ? 'must-review' : 'may-carry'}">
      <div class="domain-choice-head">
        <label class="checkbox">
          <input type="checkbox" name="domains" value="${esc(d)}"${mustReview ? ' checked' : ''}>
          <span>${esc(DOMAIN_LABELS[d])}</span>
        </label>
        ${mustReview ? badge('本次需重审', 'warn') : badge('输入/结果未变', 'info')}
      </div>
      <div class="domain-hash small">
        <span>输入 <code title="${esc(f.inputHash ?? '')}">${esc(short(f.inputHash ?? '', 10))}</code></span>
        <span>结果 <code title="${esc(f.resultHash ?? '')}">${esc(short(f.resultHash ?? '', 10))}</code></span>
      </div>
      ${mustReview ? '' : `<label class="small carry-label">或承继
        <select name="carry_${esc(d)}" data-carry-domain="${esc(d)}">
          <option value="">（不承继，我自己审）</option>
          ${(carryOptions[d] ?? []).map((c) => `<option value="${esc(c.approvalId)}">批准 ${esc(short(c.approvalId, 12))} · ${esc(c.reviewerId)}${c.via === 'carry' ? '（链式承继）' : ''}</option>`).join('')}
        </select>
      </label>`}
    </div>`;
  }).join('');

  const approveDisabled = !publishable.check || findings.some((f) => !f.passed && f.severity === 'blocking');
  return `<form method="post" action="/api/versions/${esc(version.id)}/decision" class="review-form" id="review-form" data-blocking="${approveDisabled ? '1' : '0'}">
    <input type="hidden" name="expected_dataHash" value="${esc(binding.dataHash)}">
    <input type="hidden" name="expected_rulesHash" value="${esc(binding.rulesHash)}">
    <input type="hidden" name="expected_resultHash" value="${esc(binding.resultHash)}">
    <input type="hidden" name="expected_checkRunId" value="${esc(binding.checkRunId)}">
    <input type="hidden" name="expected_reviewSerial" value="${esc(binding.reviewSerial)}">
    <div class="field-group">
      <span class="field-label">我审阅的范围</span>
      <div class="domain-grid">${domainRows}</div>
    </div>
    ${warnings.length ? `<fieldset class="warnings">
      <legend>警告项确认（${warnings.length}）</legend>
      ${warnings.map((w) => `<label class="checkbox">
        <input type="checkbox" name="warningAck" value="${esc(w.ruleId)}">
        <span>${esc(w.ruleId)} · ${esc(w.message)}</span>
      </label>`).join('')}
      <p class="hint">规则集要求逐项确认。全部勾选后，“批准”按钮才会启用。</p>
    </fieldset>` : ''}
    <div class="field-group">
      <label class="field-label" for="note">审阅意见（必填，≥ ${rules?.review?.noteMinLength ?? 0} 字）</label>
      <textarea id="note" name="note" rows="3" required minlength="${rules?.review?.noteMinLength ?? 0}" maxlength="500" placeholder="说明你核对了哪些内容、依据是什么"></textarea>
    </div>
    <div class="form-actions">
      <button class="btn primary" type="submit" name="mode" value="approve"${approveDisabled ? ' disabled' : ''}>批准</button>
      <button class="btn danger" type="submit" name="mode" value="reject">拒绝</button>
      <span class="hint" id="review-hint">${approveDisabled ? '存在阻断项或缺少检查结果，无法批准。' : `提交时会比对四项指纹；若页面已过期将拒绝提交。`}</span>
    </div>
  </form>`;
}

function withdrawForms(detail, user) {
  const mine = detail.approvals.filter((a) => a.reviewer_id === user.id && a.status === 'approved');
  const all = user.role === 'compliance' ? detail.approvals.filter((a) => a.status === 'approved') : [];
  const list = [...new Set([...mine, ...all].map((a) => a.id))].map((id) => detail.approvals.find((a) => a.id === id));
  if (!list.length) return '';
  return `<div class="withdraw-block">
    <h3>撤回批准</h3>
    <p class="small muted">撤回会把版本审阅序号 +1，令在途发布任务失效。已发布的版本若要下线，请使用回滚或召回。</p>
    ${list.map((a) => `<form method="post" action="/api/approvals/${esc(a.id)}/withdraw" class="inline-row" data-confirm="确认撤回 ${esc(a.reviewer?.name ?? a.reviewer_id)} 的批准？">
      <span class="small">${esc(a.reviewer?.name ?? a.reviewer_id)} · ${statusBadge(a.status)}</span>
      <input name="reason" placeholder="撤回原因（必填）" required maxlength="200" class="input-inline">
      <button class="btn small danger" type="submit"${a.reviewer_id !== user.id && user.role !== 'compliance' ? ' disabled' : ''}>撤回</button>
    </form>`).join('')}
  </div>`;
}

function versionPage({ user, detail, flash = null, now = Date.now() }) {
  const { version, check, findings } = detail;
  const canCreate = user.capabilities.includes('version.create');
  const buildFailed = version.status === 'build_failed';

  const body = `<div class="page-head">
    <div>
      <p class="crumb"><a href="/skus/${esc(version.sku)}">${esc(version.sku)}</a> / v${version.seq}</p>
      <h1>版本 v${version.seq} ${statusBadge(version.status)}</h1>
      <p class="sub">${esc(version.reason)} · 由 ${esc(detail.author?.name ?? version.created_by)} 于 ${esc(fmtTime(version.created_at))} 创建</p>
    </div>
    <div class="head-actions">
      ${canCreate ? `<a class="btn" href="/skus/${esc(version.sku)}/correct?base=${esc(version.id)}">基于此版本更正</a>` : ''}
      ${detail.releases.length ? `<a class="btn" href="/releases/${esc(detail.releases.at(-1).id)}">查看发布回执</a>` : ''}
      ${user.capabilities.includes('release.publish') && detail.canPublish ? `<a class="btn primary" href="#publish-panel">去发布</a>` : ''}
    </div>
  </div>
  ${detail.version.status === 'retired' ? `<div class="flash flash-warn">该版本已被上游更正退役：其批准不能再用于发布，发布任务也已作废。</div>` : ''}
  ${statusStrip(detail)}

  ${buildFailed ? section('构建失败', `<div class="error-box">
    <p><strong>${esc(detail.version.build_error_json ? JSON.parse(detail.version.build_error_json).code : 'E_BUILD')}</strong></p>
    <p>${esc(detail.version.build_error_json ? JSON.parse(detail.version.build_error_json).message : '构建失败')}</p>
    <p class="small muted">构建失败未产生可审阅的数据快照；不会出现“部分成功”的版本。</p>
    ${user.capabilities.includes('build.retry') ? `<form method="post" action="/api/versions/${esc(version.id)}/retry" class="inline">
      <button class="btn primary" type="submit">重试构建</button></form>
      <form method="post" action="/skus/${esc(version.sku)}/correct" class="inline">
        <input type="hidden" name="base" value="${esc(version.id)}">
        <button class="btn" type="submit">更正源数据（新建版本）</button></form>
      <p class="hint">重试仅适用于构建阶段可重试的错误；源数据本身有问题时请更正并新建版本。</p>` : '<p class="hint">仅资料管理员可重试构建。</p>'}
    </div>`) : ''}

  ${section('绑定证据', bindingPanel(detail), { subtitle: '批准绑定的是这一组具体指纹，不是“这个 SKU 大概没问题”。' })}
  ${!buildFailed ? section('自动质量检查', `
    ${check ? `<div class="check-summary">
      ${check.status === 'passed' ? badge('检查通过', 'good') : badge('检查未通过', 'bad')}
      <span class="muted small">执行于 ${esc(fmtTime(check.finished_at))} · ${esc(check.engine_version)}</span>
      <span class="muted small">${esc(check.findings_json ? JSON.parse(check.findings_json).length : 0)} 项</span>
    </div>
    ${check.status === 'stale' ? '<p class="flash flash-warn">该检查已被规则变更标记为作废。</p>' : ''}
    ${findingsTable(findings)}
    ${detail.facts ? `<p class="hint">域输入指纹：${Object.entries(detail.facts.inputHashes).map(([d, h]) => `<code class="mono small">${esc(DOMAIN_LABELS[d])}=${esc(short(h))}</code>`).join(' ')}</p>` : ''}`
    : empty('尚未完成检查')}
  `, { subtitle: '与人工审阅并行执行；任一步完成都不等待另一步。' }) : ''}

  ${!buildFailed ? section('影响范围与审阅策略', impactPanel(detail), { subtitle: '更正后由域指纹差异决定补审范围；跨域耦合字段变化会升级为全审。' }) : ''}

  ${!buildFailed ? section('已提交的决定', approvalsTable(detail), { subtitle: '“当前有效”为实时核验结果，不依赖历史状态标记。' }) : ''}

  ${!buildFailed ? section('提交审阅', reviewForm(detail, user, { now }) + withdrawForms(detail, user), { subtitle: '全审与补审共用同一表单；补审时需为未变化域显式选择承继或自行审阅。' }) : ''}

  ${detail.canPublish ? publishPanel(detail, user) : ''}

  ${detail.notes?.length ? section('审阅备注', detail.notes.map((n) => `<div class="note"><strong>${esc(n.author?.name ?? n.author_id)}</strong> <span class="muted small">${esc(fmtTime(n.created_at))}</span><p class="wrap">${esc(n.body)}</p></div>`).join(''), {}) : ''}

  ${detail.tasks.length ? section('该版本的发布任务', `<table class="grid compact">
    <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>说明</th><th>时间</th></tr></thead>
    <tbody>${detail.tasks.map((t) => `<tr><td class="mono small">${esc(short(t.id, 12))}</td><td>${t.kind}</td>
      <td>${statusBadge(t.status === 'published' ? 'published_task' : t.status)}</td>
      <td class="small wrap">${esc(t.blocked_reason ?? t.note ?? '')}</td><td class="small">${esc(fmtShortTime(t.created_at))}</td></tr>`).join('')}</tbody>
  </table>`) : ''}
  `;
  return layout({ title: `${version.sku} v${version.seq}`, user, nav: NAV('skus'), body, wide: true, flash });
}

function publishPanel(detail, user) {
  const { publishable, version } = detail;
  const canPublish = user.capabilities.includes('release.publish');
  return `<section class="card publish-card" id="publish-panel">
    <div class="card-head"><h2>发布</h2><p class="sub">发布前会再次核验批准集合；撤销/过期/新检查都会阻止发布。</p></div>
    <div class="publish-checks">
      ${publishable.checks.map((c) => `<div class="pub-check ${c.ok ? 'ok' : 'bad'}">
        <span class="pub-check-mark">${c.ok ? '✓' : '✕'}</span>
        <span>${esc(c.detail)}</span>
      </div>`).join('')}
    </div>
    <p class="small">批准集合指纹：<code class="mono">${esc(publishable.approvalSetHash)}</code></p>
    <p class="small">将发布的版本：<strong>v${version.seq}</strong> · 数据 ${esc(short(version.data_hash))} · 规则 ${esc(short(detail.check?.rules_hash ?? ''))} · 结果 ${esc(short(detail.check?.findings_hash ?? ''))}</p>
    ${canPublish ? `<form method="post" action="/api/skus/${esc(version.sku)}/publish" class="inline-row" data-confirm="发布 v${version.seq}？此操作会生成不可回改的发布回执。">
      <input type="hidden" name="versionId" value="${esc(version.id)}">
      <input type="hidden" name="approvalSetHash" value="${esc(publishable.approvalSetHash)}">
      <button class="btn primary" type="submit">发布为第 ${(R_gen(detail) + 1)} 代</button>
      <input name="note" placeholder="发布说明（必填）" required maxlength="200" class="input-inline">
    </form>` : '<p class="hint">当前身份不能执行发布；请由发布经理操作。</p>'}
  </section>`;
}

function R_gen(detail) {
  return detail.publishable?.currentGeneration ?? 0;
}

module.exports = { versionPage, findingsTable, humanValue };
