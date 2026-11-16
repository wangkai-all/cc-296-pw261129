'use strict';
const { esc, fmtTime, badge, layout, section, empty } = require('./ui');
const { NAV } = require('./pages');
const {
  DOMAIN_LABELS, DOMAINS, CURRENCIES, STATUSES, MARKETS, OWNED_FIELDS,
} = require('../domain/catalog');

/** 更正/新版本表单：源数据、来源说明、以及“这将触发什么审阅”的预告。 */
function correctPage({ user, sku, base, flash = null }) {
  const raw = base ? JSON.parse(base.raw_json) : {
    sku, name: '', brand: '', category: '', description: '', price: '', currency: 'CNY',
    tax_included: true, inventory: 0, lead_time_days: 3, status: 'on_sale',
    markets: ['CN'], labels: [], allergen_note: '', origin_country: 'CN',
  };
  const body = `<div class="page-head">
    <div>
      <p class="crumb"><a href="/skus/${esc(sku)}">${esc(sku)}</a> / ${base ? `基于 v${base.seq} 更正` : '新建版本'}</p>
      <h1>${base ? `基于 v${base.seq} 创建更正版本` : '创建首个版本'}</h1>
      <p class="sub">更正不会修改旧版本，而是生成新版本：旧版本与其批准保留作为审计证据，新版本重新构建与检查。</p>
    </div>
  </div>

  ${section('源数据', `<form method="post" action="/api/skus/${esc(sku)}/versions" class="stack" id="correction-form">
    <input type="hidden" name="baseVersionId" value="${esc(base?.id ?? '')}">
    <div class="form-grid">
      <label>SKU<input name="raw_sku" value="${esc(raw.sku ?? sku)}" readonly required></label>
      <label>名称<input name="raw_name" value="${esc(raw.name ?? '')}" required maxlength="80"></label>
      <label>品牌<input name="raw_brand" value="${esc(raw.brand ?? '')}" required maxlength="40"></label>
      <label>类目<input name="raw_category" value="${esc(raw.category ?? '')}" maxlength="40"></label>
      <label>价格<input name="raw_price" value="${esc(raw.price ?? '')}" required inputmode="decimal"></label>
      <label>币种<select name="raw_currency">${CURRENCIES.map((c) => `<option${raw.currency === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="check-line"><input type="checkbox" name="raw_tax_included" value="true"${raw.tax_included ? ' checked' : ''}> 含税</label>
      <label>库存<input name="raw_inventory" value="${esc(raw.inventory ?? '')}" inputmode="numeric"></label>
      <label>交期（天）<input name="raw_lead_time_days" value="${esc(raw.lead_time_days ?? '')}" inputmode="numeric"></label>
      <label>状态<select name="raw_status">${STATUSES.map((s) => `<option${raw.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>原产国<input name="raw_origin_country" value="${esc(raw.origin_country ?? '')}" maxlength="2"></label>
    </div>
    <fieldset class="inline-choices">
      <legend>销售市场</legend>
      ${MARKETS.map((m) => `<label class="checkbox"><input type="checkbox" name="raw_markets" value="${m}"${(raw.markets ?? []).includes(m) ? ' checked' : ''}> ${m}</label>`).join('')}
    </fieldset>
    <fieldset class="inline-choices">
      <legend>标签</legend>
      ${['cosmetic', 'electronics', 'food', 'fragile', 'hazmat', 'textile', 'toy'].map((m) => `<label class="checkbox"><input type="checkbox" name="raw_labels" value="${m}"${(raw.labels ?? []).includes(m) ? ' checked' : ''}> ${m}</label>`).join('')}
    </fieldset>
    <label>描述<textarea name="raw_description" rows="3" maxlength="400">${esc(raw.description ?? '')}</textarea></label>
    <label>过敏原说明<input name="raw_allergen_note" value="${esc(raw.allergen_note ?? '')}" maxlength="200"></label>
    <div class="field-group">
      <label class="field-label" for="reason">更正原因（必填，将写入审计）</label>
      <textarea id="reason" name="reason" rows="2" required maxlength="300" placeholder="例如：仓库盘点后库存由 120 改为 80"></textarea>
    </div>
    <div class="form-actions">
      <button class="btn primary" type="submit">构建并检查</button>
      <a class="btn" href="/skus/${esc(sku)}">取消</a>
    </div>
    <p class="hint">提交后立即构建并执行质量检查；随后系统会按受影响域给出补审/全审建议。不会直接发布。</p>
  </form>`)}`;
  return layout({ title: '更正', user, nav: NAV('skus'), body, wide: true, flash });
}

function rulesPage({ user, rulesets, activeId, preview = null }) {
  const set = rulesets.find((r) => r.id === activeId) ?? rulesets[0];
  const body = `<div class="page-head">
    <div><h1>规则集</h1><p class="sub">规则内容是数据：发布回执、检查与批准都引用具体规则版本与内容哈希。</p></div>
  </div>
  ${section('版本', `<table class="grid compact">
    <thead><tr><th>版本</th><th>标题</th><th>内容哈希</th><th>状态</th><th>批准有效期</th></tr></thead>
    <tbody>${rulesets.map((r) => `<tr class="${r.id === activeId ? 'row-current' : ''}">
      <td><a href="/rules?set=${esc(r.id)}">v${r.version}</a></td>
      <td>${esc(r.title)}<div class="muted small">${esc(r.effectiveNote ?? '')}</div></td>
      <td class="mono small">${esc(r.hashShort)}</td>
      <td>${r.active ? badge('当前启用', 'good') : badge('历史', 'muted')}</td>
      <td class="small">${r.approval.ttlHours} 小时</td>
    </tr>`).join('')}</tbody>
  </table>`, { subtitle: '切换规则内容会使依据旧规则产生的检查与批准失效；这是保守策略，见“失效策略”。' })}

  ${section(`质量规则 · ${set.title}`, `<table class="grid compact">
    <thead><tr><th>规则</th><th>域</th><th>级别</th><th>说明</th></tr></thead>
    <tbody>${set.quality.map((q) => `<tr><td class="mono small">${esc(q.id)}</td><td class="small">${esc(DOMAIN_LABELS[q.domain])}</td>
      <td>${q.severity === 'blocking' ? badge('阻断', 'bad') : badge('警告', 'warn')}</td><td class="small">${esc(q.title)}</td></tr>`).join('')}</tbody>
  </table>`)}

  ${section('审阅与失效策略', `<div class="policy-grid">
    <div>
      <h3>必需审阅域</h3>
      <p>${set.review.requiredDomains.map((d) => badge(DOMAIN_LABELS[d], 'role')).join(' ')}</p>
      <h3>警告处理</h3><p class="small">${set.review.warningAcknowledgement === 'required' ? '必须逐项确认后才能批准' : '可整体确认'}</p>
      <h3>补审承继</h3><p class="small">${set.review.requireExplicitCarryover ? '必须显式选择承继来源，不能默认沿用' : '允许默认沿用'}</p>
    </div>
    <div>
      <h3>字段 → 需重审的域</h3>
      <table class="grid compact"><thead><tr><th>字段</th><th>变化后需重审</th></tr></thead><tbody>
        ${Object.entries(set.invalidation.fieldDomains).map(([f, ds]) => `<tr><td class="mono small">${esc(f)}</td>
          <td class="small">${ds.map((d) => esc(DOMAIN_LABELS[d])).join('、')}${set.invalidation.alwaysFullFields.includes(f) ? ' ' + badge('且强制全审', 'warn') : ''}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>
  <div class="policy-notes">
    <h3>为什么这些变化一定使批准失效</h3>
    <ul class="reason-list">
      <li><strong>数据快照变化：</strong>批准绑定了规范化输入的哈希；任何字段改动都会改变它。</li>
      <li><strong>规则内容变化：</strong>批准绑定了规则哈希与检查结果哈希；规则一变，结论依据不复存在。</li>
      <li><strong>检查结果变化：</strong>即便输入相同，引擎或规则导致的结论变化也必须重新确认。</li>
      <li><strong>撤回/过期：</strong>审阅序号递增或超过有效期，批准不再可发布。</li>
      <li><strong>强制全审字段：</strong>${set.invalidation.alwaysFullFields.map((f) => `<code class="mono small">${esc(f)}</code>`).join(' ')} ——这些字段跨域耦合，无法只为局部承继背书。</li>
    </ul>
  </div>`)}

  ${preview ? rulesImpactSection(preview) : ''}
  `;
  return layout({ title: '规则集', user, nav: NAV('rules'), body, wide: true });
}

function rulesImpactSection(preview) {
  return section('规则变更影响预演', `<p class="small">拟启用的规则哈希：<code class="mono">${esc(preview.newHash)}</code></p>
  <table class="grid compact">
    <thead><tr><th>版本</th><th>状态</th><th>现有检查</th><th>有效批准</th><th>受影响批准</th></tr></thead>
    <tbody>${preview.rows.map((r) => `<tr>
      <td><a href="/versions/${esc(r.id)}">${esc(r.sku)} v${r.seq}</a></td>
      <td class="small">${esc(r.status)}</td>
      <td class="small">${r.checkRulesHash === preview.newHash ? badge('同规则', 'good') : badge('旧规则', 'warn')}</td>
      <td class="small">${r.validApprovals}</td>
      <td class="small">${r.affectedApprovals}</td>
    </tr>`).join('')}</tbody>
  </table>
  <p class="hint">本演示不自动切换规则版本；此预演用于说明策略影响面。</p>`);
}

function auditPage({ user, entries, users }) {
  const body = `<div class="page-head">
    <div><h1>审计</h1><p class="sub">追加式日志：状态变更、批准、撤回、失效、发布、回滚与核验都留痕，且数据库触发器禁止改写。</p></div>
  </div>
  ${section('最近事件', entries.length ? `<table class="grid compact">
    <thead><tr><th>时间</th><th>动作</th><th>对象</th><th>执行者</th><th>详情</th></tr></thead>
    <tbody>${entries.map((e) => `<tr>
      <td class="small nowrap">${esc(fmtTime(e.at))}</td>
      <td class="mono small">${esc(e.action)}</td>
      <td class="mono small">${esc(shortId(e.subject))}</td>
      <td class="small">${esc(e.actorId ? users[e.actorId]?.name ?? e.actorId : '系统')}</td>
      <td class="small wrap detail-cell">${esc(fmtDetail(e.detail))}</td>
    </tr>`).join('')}</tbody>
  </table>` : empty('暂无审计记录'))}`;
  return layout({ title: '审计', user, nav: NAV('audit'), body, wide: true });
}

function shortId(id) {
  return id && id.length > 18 ? `${id.slice(0, 16)}…` : id;
}

function fmtDetail(detail) {
  if (!detail) return '';
  const skip = new Set(['stack']);
  const pairs = [];
  for (const [k, v] of Object.entries(detail)) {
    if (skip.has(k)) continue;
    let s;
    if (typeof v === 'string') s = v;
    else if (Array.isArray(v)) s = v.join(', ');
    else if (v && typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    if (s.length > 120) s = `${s.slice(0, 117)}…`;
    pairs.push(`${k}=${s}`);
  }
  return pairs.join(' · ');
}

module.exports = { correctPage, rulesPage, auditPage };
