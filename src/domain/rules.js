'use strict';
/**
 * 规则集：带版本、带内容指纹。
 *
 * 两条独立策略：
 * - 质量规则（rules.quality）：机器可判定，产出 findings 与结论。
 * - 审阅策略（rules.review / rules.invalidation）：人工审阅的覆盖要求，
 *   以及“输入变化后哪些审阅域必须重做、哪些可承继”。
 *
 * 规则集内容一旦变化，依据旧规则产生的检查与批准必须全部失效。
 * 这里区分“质量规则变化”和“审阅策略变化”：两者都计入 rules_hash，
 * 任一变化都会使批准失效（审阅策略变化同样改变放行阈值，必须重审）。
 */
const { canonicalJson, sha256Hex } = require('../canonical');
const { DOMAIN_LABELS } = require('./catalog');

const ALLOWED_LABELS = new Set([
  'cosmetic', 'electronics', 'food', 'fragile', 'hazmat', 'textile', 'toy',
]);

/**
 * 字段 → 该字段变化后必须重审的域。
 * 映射体现业务耦合：
 * - 价格变化会同时影响价格展示、税务/含税说明与合规披露（促销价声明）。
 * - 描述变化可能夹带功效/过敏原声明，必须连带合规域。
 * - 市场变化影响定价展示与合规披露。
 * - 状态变化影响库存承诺与定价（清仓/预购）。
 */
const FIELD_REVIEW_DOMAINS_V1 = {
  sku: ['identity', 'compliance'],
  name: ['identity'],
  brand: ['identity'],
  category: ['identity'],
  description: ['identity', 'compliance'],
  price: ['pricing', 'compliance'],
  currency: ['pricing'],
  tax_included: ['pricing'],
  inventory: ['inventory'],
  lead_time_days: ['inventory'],
  status: ['inventory', 'pricing'],
  markets: ['compliance', 'pricing'],
  labels: ['compliance'],
  allergen_note: ['compliance'],
  origin_country: ['compliance'],
  specs: ['identity'],
  extras: ['identity'],
};

const RULES_V1 = {
  id: 'rs-okf-2026.11-a',
  version: 1,
  title: '商品资料门禁规则 2026.11-A',
  effectiveNote: '首版：EU 市场要求过敏原与原产地；预购商品必须有交期。',
  quality: [
    { id: 'q.sku.required', domain: 'identity', title: 'SKU 必填', severity: 'blocking' },
    { id: 'q.name.required', domain: 'identity', title: '商品名称必填（2–80 字）', severity: 'blocking' },
    { id: 'q.brand.required', domain: 'identity', title: '品牌必填', severity: 'blocking' },
    { id: 'q.category.required', domain: 'identity', title: '类目必填', severity: 'warning' },
    { id: 'q.description.min', domain: 'identity', title: '描述不少于 20 字', severity: 'warning' },
    { id: 'q.price.positive', domain: 'pricing', title: '价格必须为正数且最多两位小数', severity: 'blocking' },
    { id: 'q.currency.enum', domain: 'pricing', title: '币种必须为 CNY / USD / EUR', severity: 'blocking' },
    { id: 'q.tax.boolean', domain: 'pricing', title: '含税标记必须明确', severity: 'warning' },
    { id: 'q.markets.valid', domain: 'compliance', title: '销售市场必须为 CN / EU / US 且非空', severity: 'blocking' },
    { id: 'q.eu.allergen', domain: 'compliance', title: 'EU 市场必须填写过敏原说明', severity: 'blocking' },
    { id: 'q.eu.origin', domain: 'compliance', title: 'EU 市场必须填写原产国', severity: 'blocking' },
    { id: 'q.labels.known', domain: 'compliance', title: '标签必须来自允许集合', severity: 'warning' },
    { id: 'q.inventory.integer', domain: 'inventory', title: '库存必须为非负整数', severity: 'blocking' },
    { id: 'q.leadtime.range', domain: 'inventory', title: '交期必须在 0–120 天', severity: 'warning' },
    { id: 'q.status.enum', domain: 'inventory', title: '状态必须为 on_sale / preorder / discontinued', severity: 'blocking' },
    { id: 'q.preorder.leadtime', domain: 'inventory', title: '预购商品必须给出交期', severity: 'blocking' },
  ],
  review: {
    requiredDomains: ['identity', 'pricing', 'compliance', 'inventory'],
    noteMinLength: 4,
    warningAcknowledgement: 'required',
    // 同一审阅人可以在一条批准里覆盖多个域；不同审阅人可以分别覆盖不同域。
    allowSplitApprovals: true,
    // 补审时未受影响域必须由人显式选择承继来源，不能默认沿用。
    requireExplicitCarryover: true,
  },
  invalidation: {
    fieldDomains: FIELD_REVIEW_DOMAINS_V1,
    // 这些字段一变就是“全审”，不允许承继任何域（跨域耦合无法局部评估）。
    alwaysFullFields: ['sku', 'price', 'currency', 'markets', 'status', 'allergen_note', 'origin_country', 'labels'],
    // 检查结果（而非输入）变化时的策略：失效并要求重新审阅。
    onResultChange: 'invalidate_approvals',
    // 规则内容变化：该版本所有批准立即失效。
    onRulesChange: 'invalidate_all',
    // 源包被替换但内容相同：只记审计，不作废批准。
    onSourceReplacement: 'audit_only',
    // 批准到期：精确到毫秒，过期即不可用于发布。
    onExpiry: 'invalidate',
    // 只有“已发布版本”被更正时，才需要评估补审；未发布版本直接全审。
    allowTargetedReviewFor: 'unpublished_correction',
  },
  approval: {
    ttlHours: 72,
    // 承继的批准自身仍须有效（未撤回/未过期/规则一致），发布时逐条复验。
    verifyCarryoverAtPublish: true,
    // 同一版本同一审阅人只能有一条 live 批准。
    oneLivePerReviewer: true,
  },
  /** 影响评估里用于“等待 vs 误放”估算的审阅时长（分钟/域）。 */
  estimation: {
    minutesPerDomain: 20,
    falseReleaseIncidentCost: '高',
  },
};

const RULES_V2 = {
  ...structuredClone(RULES_V1),
  id: 'rs-okf-2026.11-b',
  version: 2,
  title: '商品资料门禁规则 2026.11-B',
  effectiveNote: '收紧交期上限至 90 天并要求所有市场填写原产国；价格变更强制全审。',
  quality: RULES_V1.quality.map((rule) => {
    if (rule.id === 'q.leadtime.range') return { ...rule, severity: 'blocking' };
    if (rule.id === 'q.eu.origin') {
      return { ...rule, id: 'q.origin.required', title: '所有市场必须填写原产国', severity: 'blocking' };
    }
    return rule;
  }),
  invalidation: {
    ...structuredClone(RULES_V1.invalidation),
    // 新增：描述中含合规敏感词时（下文规则无法逐字段表达），直接把描述变动升级为全审。
    alwaysFullFields: [...RULES_V1.invalidation.alwaysFullFields, 'description'],
  },
  approval: { ...RULES_V1.approval, ttlHours: 48 },
};

function rulesHash(rules) {
  const { hash, hashShort, ...content } = rules;
  return sha256Hex(canonicalJson(content));
}

function listRuleSets() {
  return [RULES_V1, RULES_V2].map((rules) => {
    const hash = rulesHash(rules);
    return { ...rules, hash, hashShort: hash.slice(0, 12) };
  });
}

function getRuleSet(version) {
  return listRuleSets().find((r) => r.version === Number(version)) ?? null;
}

function getRuleSetById(id) {
  return listRuleSets().find((r) => r.id === id) ?? null;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 纯函数：输入规范化快照 + 规则集 → 逐条检查结果。
 * 结果参与 resultHash，因此任何结论变化都会使批准失效。
 */
function runChecks(normalized, rules) {
  const results = [];
  const push = (rule, passed, message) => {
    results.push({
      ruleId: rule.id,
      domain: rule.domain,
      title: rule.title,
      severity: rule.severity,
      passed,
      message,
    });
  };
  const byId = Object.fromEntries(rules.quality.map((r) => [r.id, r]));
  const get = (id) => {
    const rule = byId[id];
    if (!rule) throw new Error(`规则集缺少 ${id}`);
    return rule;
  };

  push(get('q.sku.required'), Boolean(normalized.sku), normalized.sku ? `SKU ${normalized.sku}` : '缺少 SKU');

  const nameLen = typeof normalized.name === 'string' ? [...normalized.name].length : 0;
  push(get('q.name.required'), nameLen >= 2 && nameLen <= 80, nameLen ? `名称长度 ${nameLen}` : '缺少名称');

  push(get('q.brand.required'), Boolean(normalized.brand), normalized.brand ? `品牌 ${normalized.brand}` : '缺少品牌');
  push(get('q.category.required'), Boolean(normalized.category), normalized.category ? `类目 ${normalized.category}` : '缺少类目');

  const descLen = typeof normalized.description === 'string' ? [...normalized.description].length : 0;
  push(get('q.description.min'), descLen >= 20, `描述长度 ${descLen}（要求 ≥ 20）`);

  const priceOk = isFiniteNumber(normalized.price) && normalized.price > 0;
  const precisionOk = priceOk && Math.round(normalized.price * 100) / 100 === normalized.price;
  push(get('q.price.positive'), priceOk && precisionOk, priceOk ? `价格 ${normalized.price}` : `价格无效：${JSON.stringify(normalized.price)}`);

  push(get('q.currency.enum'), ['CNY', 'USD', 'EUR'].includes(normalized.currency), `币种 ${normalized.currency ?? '缺失'}`);
  push(get('q.tax.boolean'), typeof normalized.tax_included === 'boolean', `含税标记 ${JSON.stringify(normalized.tax_included)}`);

  const markets = Array.isArray(normalized.markets) ? normalized.markets : [];
  const marketsOk = markets.length > 0 && markets.every((m) => ['CN', 'EU', 'US'].includes(m));
  push(get('q.markets.valid'), marketsOk, markets.length ? `市场 ${markets.join(', ')}` : '缺少销售市场');

  const needsEu = markets.includes('EU');
  if (byId['q.eu.allergen']) {
    const ok = !needsEu || Boolean(normalized.allergen_note);
    push(byId['q.eu.allergen'], ok, needsEu ? (ok ? '已填写过敏原' : 'EU 市场缺过敏原说明') : '不涉及 EU');
  }
  if (byId['q.eu.origin']) {
    const ok = !needsEu || Boolean(normalized.origin_country);
    push(byId['q.eu.origin'], ok, needsEu ? (ok ? `原产国 ${normalized.origin_country}` : 'EU 市场缺原产国') : '不涉及 EU');
  }
  if (byId['q.origin.required']) {
    const ok = Boolean(normalized.origin_country);
    push(byId['q.origin.required'], ok, ok ? `原产国 ${normalized.origin_country}` : '缺原产国');
  }

  const labels = Array.isArray(normalized.labels) ? normalized.labels : normalized.labels == null ? [] : null;
  const labelsOk = labels !== null && labels.every((l) => ALLOWED_LABELS.has(l));
  push(get('q.labels.known'), labelsOk, labels === null ? '标签格式非法' : labels.length ? `标签 ${labels.join(', ')}` : '未打标签');

  const invOk = Number.isInteger(normalized.inventory) && normalized.inventory >= 0;
  push(get('q.inventory.integer'), invOk, invOk ? `库存 ${normalized.inventory}` : `库存无效：${JSON.stringify(normalized.inventory)}`);

  const maxLead = rules.version >= 2 ? 90 : 120;
  const leadOk = Number.isInteger(normalized.lead_time_days)
    && normalized.lead_time_days >= 0
    && normalized.lead_time_days <= maxLead;
  push(get('q.leadtime.range'), leadOk, `交期 ${JSON.stringify(normalized.lead_time_days)}（允许 0–${maxLead} 天）`);

  const statusOk = ['on_sale', 'preorder', 'discontinued'].includes(normalized.status);
  push(get('q.status.enum'), statusOk, `状态 ${normalized.status ?? '缺失'}`);

  const preorderOk = normalized.status !== 'preorder' || Number.isInteger(normalized.lead_time_days);
  push(get('q.preorder.leadtime'), preorderOk, normalized.status === 'preorder' ? `预购交期 ${JSON.stringify(normalized.lead_time_days)}` : '非预购');

  return results;
}

function summarizeResults(results) {
  const byDomain = {};
  for (const result of results) {
    const d = (byDomain[result.domain] ??= { passed: 0, failed: 0, blocking: 0, warning: 0, results: [] });
    d.results.push(result);
    if (result.passed) d.passed += 1;
    else {
      d.failed += 1;
      if (result.severity === 'blocking') d.blocking += 1;
      else if (result.severity === 'warning') d.warning += 1;
    }
  }
  const blocking = results.filter((r) => !r.passed && r.severity === 'blocking');
  const warnings = results.filter((r) => !r.passed && r.severity === 'warning');
  return {
    byDomain,
    blocking,
    warnings,
    total: results.length,
    failed: results.filter((r) => !r.passed).length,
    // 自动检查通过 = 没有阻断项。警告可由审阅人逐项确认后放行。
    passed: blocking.length === 0,
    domainLabels: DOMAIN_LABELS,
  };
}

module.exports = {
  ALLOWED_LABELS,
  RULES_V1,
  RULES_V2,
  rulesHash,
  listRuleSets,
  getRuleSet,
  getRuleSetById,
  runChecks,
  summarizeResults,
};
