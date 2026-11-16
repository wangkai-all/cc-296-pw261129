'use strict';
/**
 * 商品资料领域模型（全部为虚构示例）。
 *
 * 原始上报（raw）保留来源字段原样，便于审计；构建（normalize）产出一个
 * 规范化快照，其哈希进入批准绑定。字段顺序、空白、键序都不影响快照指纹。
 */
const { canonicalJson, sha256Hex } = require('../canonical');

const DOMAINS = ['identity', 'pricing', 'compliance', 'inventory'];
const DOMAIN_LABELS = {
  identity: '商品身份',
  pricing: '价格与币种',
  compliance: '合规与标签',
  inventory: '库存与交期',
};
const CURRENCIES = ['CNY', 'USD', 'EUR'];
const STATUSES = ['on_sale', 'preorder', 'discontinued'];
const MARKETS = ['CN', 'EU', 'US'];

const FIELD_OWNERS = {
  sku: 'identity',
  name: 'identity',
  brand: 'identity',
  category: 'identity',
  description: 'identity',
  price: 'pricing',
  currency: 'pricing',
  tax_included: 'pricing',
  inventory: 'inventory',
  lead_time_days: 'inventory',
  status: 'inventory',
  markets: 'compliance',
  labels: 'compliance',
  allergen_note: 'compliance',
  origin_country: 'compliance',
};

const OWNED_FIELDS = Object.keys(FIELD_OWNERS);

/** 去掉首尾空白、合并内部空白、空串变 null。 */
function tidy(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const s = value.trim().replace(/\s+/g, ' ');
    return s === '' ? null : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return value;
}

/**
 * 将任意输入收敛成可稳定比较的结构。raw 里未知字段原样保留在 extras，
 * 并参与指纹，避免“悄悄改字段却被视为同一快照”。
 */
function normalizeInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('raw', '输入必须是对象');
  }
  const take = (k) => tidy(raw[k]);
  const markets = Array.isArray(raw.markets)
    ? [...new Set(raw.markets.map((m) => String(m).trim().toUpperCase()).filter(Boolean))].sort()
    : [];
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((l) => (typeof l === 'string' ? l.trim().toLowerCase() : l)).filter((l) => l !== null && l !== '').sort()
    : raw.labels ?? null;

  const core = {
    sku: take('sku'),
    name: take('name'),
    brand: take('brand'),
    category: take('category'),
    description: take('description'),
    price: parseMoney(raw.price),
    currency: take('currency')?.toUpperCase() ?? null,
    tax_included: typeof raw.tax_included === 'boolean' ? raw.tax_included : parseBoolish(raw.tax_included),
    inventory: parseInteger(raw.inventory),
    lead_time_days: parseInteger(raw.lead_time_days),
    status: take('status')?.toLowerCase() ?? null,
    markets,
    labels,
    allergen_note: take('allergen_note'),
    origin_country: take('origin_country')?.toUpperCase() ?? null,
    specs: normalizeSpecs(raw.specs),
  };

  const extras = {};
  for (const key of Object.keys(raw).sort()) {
    if (!(key in core)) extras[key] = raw[key];
  }
  return { ...core, extras };
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return s; // 保留非法原文，交给规则报告
    return Number(s);
  }
  return value;
}

function parseInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^-?\d+$/.test(s)) return s;
    return Number(s);
  }
  return value;
}

function parseBoolish(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(s)) return true;
    if (['false', 'no', '0'].includes(s)) return false;
  }
  return value;
}

function normalizeSpecs(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { _invalid: value };
  const out = {};
  for (const k of Object.keys(value).sort()) {
    const v = tidy(value[k]);
    if (v !== null) out[k] = v;
  }
  return out;
}

class InputError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InputError';
    this.field = field;
  }
}

function dataHashOf(normalized) {
  return sha256Hex(canonicalJson(normalized));
}

/**
 * 构建：输入 → 规范化快照 + 校验摘要。
 * 返回 { normalized, canonical, hash, fields, builtAt }。
 */
function buildSnapshot(raw) {
  const normalized = normalizeInput(raw);
  const canonical = canonicalJson(normalized);
  return {
    normalized,
    canonical,
    hash: sha256Hex(canonical),
    builtAt: Date.now(),
    fieldKeys: OWNED_FIELDS.filter((k) => normalized[k] !== null && normalized[k] !== undefined),
  };
}

/** 计算两次快照之间改了哪些“归属域”。用于影响范围补审。 */
function changedDomains(prev, next) {
  const changedFields = [];
  const domains = new Set();
  const allKeys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const key of allKeys) {
    const owner = FIELD_OWNERS[key];
    const before = canonicalJson(prev?.[key] ?? null);
    const after = canonicalJson(next?.[key] ?? null);
    if (before === after) continue;
    if (owner) {
      changedFields.push(key);
      domains.add(owner);
    } else if (key === 'specs' || key === 'extras') {
      // 规格与未知字段：逐键判定，保守归入身份域且视为实质变更。
      const b = prev?.[key] ?? {};
      const a = next?.[key] ?? {};
      const subKeys = new Set([...Object.keys(b), ...Object.keys(a)]);
      for (const sk of subKeys) {
        if (canonicalJson(b?.[sk] ?? null) !== canonicalJson(a?.[sk] ?? null)) {
          changedFields.push(`${key}.${sk}`);
          domains.add('identity');
        }
      }
    } else {
      changedFields.push(key);
      domains.add('identity');
    }
  }
  return { changedFields: changedFields.sort(), domains: [...domains].sort() };
}

/**
 * 将两份规范化快照逐字段比对，返回明细，供界面解释“为什么批准失效”。
 */
function diffSnapshots(prev, next) {
  const out = [];
  const allKeys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const key of [...allKeys].sort()) {
    const before = prev?.[key] ?? null;
    const after = next?.[key] ?? null;
    if (canonicalJson(before) === canonicalJson(after)) continue;
    out.push({ field: key, domain: FIELD_OWNERS[key] ?? 'identity', before, after });
  }
  return out;
}

/**
 * 按域计算输入指纹。批准绑定的是“域内字段的精确取值”，
 * 因此未受影响域上的旧批准可以逐字节沿用，而不必重审整个商品。
 *
 * specs 归入 identity；未知字段归入 identity（保守）。
 */
const DOMAIN_FIELDS = (() => {
  const map = Object.fromEntries(DOMAINS.map((d) => [d, []]));
  for (const [field, domain] of Object.entries(FIELD_OWNERS)) map[domain].push(field);
  map.identity.push('specs', 'extras');
  for (const d of DOMAINS) map[d].sort();
  return map;
})();

function domainInputs(normalized) {
  const out = {};
  for (const domain of DOMAINS) {
    const picked = {};
    for (const field of DOMAIN_FIELDS[domain]) picked[field] = normalized[field] ?? null;
    out[domain] = picked;
  }
  return out;
}

/** domain → sha256(规范化字段集)。 */
function domainHashes(normalized) {
  const inputs = domainInputs(normalized);
  return Object.fromEntries(DOMAINS.map((d) => [d, sha256Hex(canonicalJson(inputs[d]))]));
}

/** 逐域检查结果指纹：同一域内规则结论的任何变化都会改变它。 */
function domainResultHashes(results) {
  const byDomain = Object.fromEntries(DOMAINS.map((d) => [d, []]));
  for (const r of results) {
    const bucket = byDomain[r.domain] ?? (byDomain[r.domain] = []);
    bucket.push({ ruleId: r.ruleId, passed: r.passed, message: r.message, severity: r.severity });
  }
  return Object.fromEntries(
    Object.entries(byDomain).map(([d, rows]) => [d, sha256Hex(canonicalJson(rows.sort((a, b) => a.ruleId.localeCompare(b.ruleId))))]),
  );
}

module.exports = {
  DOMAINS,
  DOMAIN_LABELS,
  DOMAIN_FIELDS,
  CURRENCIES,
  STATUSES,
  MARKETS,
  FIELD_OWNERS,
  OWNED_FIELDS,
  InputError,
  normalizeInput,
  buildSnapshot,
  dataHashOf,
  changedDomains,
  diffSnapshots,
  domainInputs,
  domainHashes,
  domainResultHashes,
};
