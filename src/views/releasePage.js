'use strict';
const {
  esc, fmtTime, fmtShortTime, short, hashChip, badge, statusBadge, layout, section, empty,
} = require('./ui');
const { NAV } = require('./pages');
const { DOMAIN_LABELS } = require('../domain/catalog');

function releasePage({ user, detail, flash = null }) {
  const { release, version, approvals, manifest, artifacts, verifications } = detail;
  const body = `<div class="page-head">
    <div>
      <p class="crumb"><a href="/skus/${esc(release.sku)}">${esc(release.sku)}</a> / 发布回执</p>
      <h1>第 ${release.generation} 代 ${statusBadge(release.status)}</h1>
      <p class="sub">${esc(release.note ?? '')} · ${esc(detail.publisher?.name ?? release.published_by)} · ${esc(fmtTime(release.published_at))}</p>
    </div>
    <div class="head-actions">
      ${user.capabilities.includes('verify.run') ? `<form method="post" action="/api/releases/${esc(release.id)}/verify" class="inline">
        <button class="btn primary" type="submit">重新核验</button></form>` : ''}
      <a class="btn" href="/download/${esc(release.id)}.zip">下载发布包</a>
      ${release.status === 'published' && user.capabilities.includes('release.recall') ? `<details class="inline-details">
        <summary class="btn danger">紧急召回</summary>
        <form method="post" action="/api/skus/${esc(release.sku)}/recall" class="inline-row" data-confirm="召回会让线上归零，且阻止在途发布。确认？">
          <input type="hidden" name="currentReleaseId" value="${esc(release.id)}">
          <input name="reason" required maxlength="200" placeholder="召回原因（必填）" class="input-inline">
          <button class="btn danger small" type="submit">确认召回</button>
        </form>
      </details>` : ''}
    </div>
  </div>

  ${release.status === 'recalled' ? `<div class="flash flash-bad">该发布已被召回：产物已禁止重新上线。原因：${esc(release.end_reason ?? '—')}</div>` : ''}

  ${section('回执指纹', `<div class="binding-grid">
    <div class="binding-item"><span class="binding-k">发布 ID</span><span class="mono binding-v">${esc(release.id)}</span></div>
    <div class="binding-item"><span class="binding-k">数据快照</span><span class="mono binding-v">${esc(release.snapshot_hash)}</span></div>
    <div class="binding-item"><span class="binding-k">批准集</span><span class="mono binding-v">${esc(release.approval_set_hash)}</span></div>
    <div class="binding-item"><span class="binding-k">规则集</span><span class="mono binding-v">${esc(release.rules_hash)}</span></div>
    <div class="binding-item"><span class="binding-k">检查结果</span><span class="mono binding-v">${esc(release.check_result_hash)}</span></div>
    <div class="binding-item"><span class="binding-k">manifest</span><span class="mono binding-v">${esc(release.manifest_hash)}</span></div>
  </div>
  <p class="hint">回执与四个产物文件不可修改；核验会逐文件重算哈希并与 manifest、回执比对。</p>`)}

  ${section('版本与来源', `<dl class="kv">
    <dt>版本</dt><dd><a href="/versions/${esc(version?.id ?? '')}">v${esc(version?.seq ?? '?')}</a>（${esc(version?.reason ?? '')}）</dd>
    <dt>取代</dt><dd>${detail.replaces ? `<a href="/releases/${esc(detail.replaces.id)}">第 ${detail.replaces.generation} 代</a>` : '无（首代）'}</dd>
    <dt>回滚来源</dt><dd>${detail.restores ? `<a href="/releases/${esc(detail.restores.id)}">第 ${detail.restores.generation} 代</a>（原样重用其产物）` : '无'}</dd>
    <dt>被此回执取代</dt><dd>${detail.restoredBy.length ? detail.restoredBy.map((r) => `<a href="/releases/${esc(r.id)}">第 ${r.generation} 代</a>`).join('、') : '无'}</dd>
    <dt>结束</dt><dd>${release.ended_at ? `${esc(fmtTime(release.ended_at))} · ${esc(detail.ender?.name ?? '')} · ${esc(release.end_reason ?? '')}` : '仍是当前发布或尚未结束'}</dd>
  </dl>`)}

  ${section('发布时依据的批准', `<table class="grid">
    <thead><tr><th>审阅人</th><th>审阅域</th><th>决定于</th><th>当时绑定</th><th>现在</th></tr></thead>
    <tbody>${approvals.map((a) => a.missing
    ? `<tr><td colspan="5" class="bad">批准 ${esc(a.id)} 记录缺失（异常）</td></tr>`
    : `<tr>
        <td>${esc(a.reviewer?.name ?? a.reviewer_id)}<div class="muted small">${esc(a.reviewer_role)}</div></td>
        <td class="small">${a.domains.map((d) => `<span class="dom-tag ${d.via === 'carry' ? 'dom-carry' : ''}">${esc(DOMAIN_LABELS[d.domain] ?? d.domain)}</span>`).join(' ')}</td>
        <td class="small">${esc(fmtShortTime(a.decided_at))}</td>
        <td class="small">${a.atReleaseTime.dataHash && a.atReleaseTime.resultHash && a.atReleaseTime.rulesHash
      ? badge('与回执一致', 'good')
      : badge('不一致', 'bad')}
          <div class="mono muted small">${esc(short(a.data_hash))} / ${esc(short(a.result_hash))}</div></td>
        <td class="small">${a.nowValid ? badge('仍有效', 'good') : `<span class="muted">${esc(a.nowReason ?? '已失效')}</span>`}</td>
      </tr>`).join('')}</tbody>
  </table>
  <p class="hint">批准之后可能被撤回或过期；这不影响回执——回执证明的是“发布当时”依据了这些批准。</p>`)}

  ${section('产物文件', `<table class="grid compact">
    <thead><tr><th>文件</th><th>类型</th><th>大小</th><th>SHA-256</th><th></th></tr></thead>
    <tbody>${artifacts.map((f) => `<tr>
      <td class="mono small">${esc(f.name)}</td><td class="small">${esc(f.content_type)}</td>
      <td class="small">${(Number(f.size) / 1024).toFixed(1)} KB</td>
      <td class="mono small" title="${esc(f.hash)}">${esc(short(f.hash, 20))}</td>
      <td><a class="small" href="/download/${esc(release.id)}/${esc(f.name)}">下载</a></td>
    </tr>`).join('')}</tbody>
  </table>
  <p class="hint">发布包 zip 内含 manifest 与四个文件，names 与哈希均来自不可变产物表。</p>`)}

  ${manifest ? section('Manifest 摘要', `<pre class="code-block">${esc(JSON.stringify(manifest, null, 2))}</pre>`) : ''}

  ${section('核验记录', verifications.length ? `<table class="grid compact">
    <thead><tr><th>时间</th><th>结果</th><th>执行者</th></tr></thead>
    <tbody>${verifications.map((v) => `<tr><td class="small">${esc(fmtTime(v.at))}</td>
      <td>${v.ok ? badge('通过', 'good') : badge('失败', 'bad')}</td>
      <td class="small">${esc(detail.publisher?.id === v.actor_id ? detail.publisher?.name : (v.actor_id ?? '系统'))}</td></tr>`).join('')}</tbody>
  </table>` : empty('尚未手动核验。发布时记录了自检。'))}
  `;
  return layout({ title: `发布第 ${release.generation} 代`, user, nav: NAV('skus'), body, wide: true, flash });
}

module.exports = { releasePage };
