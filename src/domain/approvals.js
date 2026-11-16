'use strict';
/**
 * 审阅与批准引擎。
 *
 * 三个必须分清的概念：
 *
 * 1. 批准有效性（approval validity）
 *    一条批准 = 一个人对 (版本, 检查记录, 规则集, 域集合) 的签名式记录。
 *    每个域还钉住该域的输入指纹与结果指纹（approval_domains）。
 *    “此刻是否有效”永远实时计算，不信任写入时的快照。
 *
 * 2. 审阅完整性（review completeness）
 *    规则集要求的域是否都被有效批准覆盖。域可以来自不同审阅人。
 *
 * 3. 可发布性（publishability）
 *    完整性 + 输入快照 = 当前数据 + 检查记录是当前检查 + 批准未过期。
 *    发布任务还额外钉住 approval set hash 与当前发布代号，防止越权。
 *
 * 更正的处理：
 *  - 更正永远产生新版本（旧版本与旧批准保留，作为审计证据）。
 *  - 新版本先构建、再检查；影响评估基于“域输入指纹”的差异。
 *  - 受影响域必须由人重新审阅；未受影响域可由人显式承继旧版本上
 *    仍然有效的域级批准。承继不是复制签名：发布时旧批准仍被逐条复验，
 *    且承继记录里保留 carried_approval_id 供追溯。
 *  - 出现 alwaysFullFields 变化时不允许任何承继，必须全审。
 *
 * 并发：
 *  - 所有变更走 BEGIN IMMEDIATE 单写事务。
 *  - 提交批准时带 expected 绑定值，事务内复读并比对。
 *  - 撤回/失效推进版本的 review_serial（单调计数），发布任务记录它，
 *    使任何在撤回前创建的发布任务无法越过撤回生效。
 */
const { newId } = require('../store/audit');
const { audit } = require('../store/audit');
const { canonicalJson, sha256Hex } = require('../canonical');
const { tx } = require('../db');
const {
  DOMAINS, DOMAIN_LABELS, buildSnapshot, diffSnapshots, domainHashes, domainResultHashes, changedDomains,
} = require('./catalog');
const { getRuleSetById } = require('./rules');

const REVIEW_DOMAINS = DOMAINS;

class ApprovalError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.detail = detail;
  }
}

function domainLabel(domain) {
  return DOMAIN_LABELS[domain] ?? domain;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function getVersion(db, versionId) {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId) ?? null;
}

function getCheck(db, checkId) {
  return db.prepare('SELECT * FROM check_runs WHERE id = ?').get(checkId) ?? null;
}

function rulesForCheck(db, check) {
  const row = db.prepare('SELECT * FROM rulesets WHERE id = ?').get(check.ruleset_id);
  if (!row) return null;
  return { ...JSON.parse(row.rules_json), hash: row.rules_hash, dbId: row.id };
}

/** 版本当前检查：只认 versions.current_check_id 指向且完成的记录。 */
function currentCheck(db, version) {
  if (!version?.current_check_id) return null;
  const check = getCheck(db, version.current_check_id);
  if (!check || !['passed', 'failed', 'error', 'stale'].includes(check.status)) return null;
  return check;
}

/** 计算一个版本的域级事实：各域输入指纹与结果指纹。 */
function versionFacts(db, version) {
  const check = currentCheck(db, version);
  if (!check) return null;
  const { normalized } = buildSnapshot(parseJson(version.raw_json, {}));
  const findings = parseJson(check.findings_json, []);
  return {
    normalized,
    check,
    inputHashes: domainHashes(normalized),
    resultHashes: domainResultHashes(findings),
    dataHash: version.data_hash,
    rulesHash: check.rules_hash,
    resultHash: check.findings_hash,
  };
}

/** 提交批准前，客户端必须回传的绑定值。 */
function bindingOf(db, version) {
  const check = currentCheck(db, version);
  if (!check) return null;
  const facts = versionFacts(db, version);
  return {
    versionId: version.id,
    dataHash: version.data_hash,
    rulesHash: check.rules_hash,
    resultHash: check.findings_hash,
    checkRunId: check.id,
    reviewSerial: version.review_serial,
    domainInputHashes: facts.inputHashes,
    domainResultHashes: facts.resultHashes,
  };
}

/**
 * 实时判定一条批准是否有效。
 * 返回结构供界面展示“为什么这条批准现在不能用”。
 */
function evaluateApproval(db, approval, { at = Date.now() } = {}) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  // 域级结论：全局条件（版本/状态/有效期/检查/数据/规则/结果）不成立时全部域失效；
  // 全局条件成立时，只有指纹不符或承继源失效的那个域失效，其余域仍可用。
  // 这样“撤回了承继源”不会连带作废同一条批准里本人亲自审阅的域。
  const globalChecks = [];
  const domainChecks = {};
  const addGlobal = (id, ok, detail) => { checks.push({ id, ok, detail }); globalChecks.push({ id, ok }); };
  const addDomain = (domain, id, ok, detail) => {
    checks.push({ id, ok, detail });
    (domainChecks[domain] ??= []).push({ id, ok });
  };

  const version = getVersion(db, approval.version_id);
  addGlobal('version', Boolean(version), version ? '版本存在' : '版本已不存在');
  if (!version) return verdict(checks);
  const usableStatus = ['ready', 'published'].includes(version.status);
  addGlobal('version_status', usableStatus, usableStatus
    ? `版本状态 ${version.status}`
    : `版本状态为 ${version.status}，已不能发布`);

  addGlobal('status', approval.status === 'approved', `状态 ${approval.status}`);
  addGlobal('expiry', approval.expires_at > at, approval.expires_at > at
    ? `有效期至 ${new Date(approval.expires_at).toISOString()}`
    : `已于 ${new Date(approval.expires_at).toISOString()} 过期`);

  const check = getCheck(db, approval.check_run_id);
  addGlobal('check_run', Boolean(check), check ? '检查记录存在' : '检查记录缺失');
  const isCurrentCheck = Boolean(check) && version.current_check_id === check.id;
  addGlobal('current_check', isCurrentCheck, isCurrentCheck ? '检查记录仍是版本当前结果' : '检查记录已被更新的检查取代');
  addGlobal('check_status', check?.status === 'passed', `检查状态 ${check?.status ?? '缺失'}`);
  addGlobal('data_hash', approval.data_hash === version.data_hash, approval.data_hash === version.data_hash ? '输入快照一致' : '输入快照已变化');
  addGlobal('rules_hash', Boolean(check) && approval.rules_hash === check.rules_hash, '规则集指纹一致');
  addGlobal('result_hash', Boolean(check) && approval.result_hash === check.findings_hash, '检查结果指纹一致');

  const facts = versionFacts(db, version);
  const rows = db.prepare('SELECT * FROM approval_domains WHERE approval_id = ? ORDER BY domain').all(approval.id);
  if (!facts) addGlobal('facts', false, '无法重建版本事实');
  else {
    if (!rows.length) addGlobal('domains', false, '批准未绑定任何审阅域');
    for (const row of rows) {
      addDomain(row.domain, `domain.${row.domain}.input`, facts.inputHashes[row.domain] === row.input_hash,
        `${domainLabel(row.domain)}输入指纹${facts.inputHashes[row.domain] === row.input_hash ? '一致' : '不一致'}`);
      addDomain(row.domain, `domain.${row.domain}.result`, facts.resultHashes[row.domain] === row.result_hash,
        `${domainLabel(row.domain)}结果指纹${facts.resultHashes[row.domain] === row.result_hash ? '一致' : '不一致'}`);
    }
    // 承继的旧批准也必须此刻仍有效（二级校验，按域判定）。
    for (const row of rows.filter((r) => r.via === 'carry')) {
      const old = db.prepare('SELECT * FROM approvals WHERE id = ?').get(row.carried_approval_id);
      if (!old) {
        addDomain(row.domain, `carry.${row.domain}`, false, `承继源批准 ${row.carried_approval_id} 不存在`);
        continue;
      }
      const oldCheck = getCheck(db, old.check_run_id);
      const oldFacts = (() => {
        const oldVersion = getVersion(db, old.version_id);
        return oldVersion ? versionFacts(db, oldVersion) : null;
      })();
      const ok = old.status === 'approved' && old.expires_at > at && oldCheck?.status === 'passed'
        && Boolean(oldFacts) && oldFacts.inputHashes[row.domain] === row.input_hash
        && oldFacts.resultHashes[row.domain] === row.result_hash;
      addDomain(row.domain, `carry.${row.domain}.valid`, ok, ok
        ? `承继自 ${old.id}（${old.reviewer_id}）仍有效`
        : `承继源批准 ${old.id} 已失效/过期/指纹不符`);
    }
  }
  return verdict(checks, { globalChecks, domainChecks });
}

function verdict(checks, { globalChecks = null, domainChecks = null } = {}) {
  const failed = checks.filter((c) => !c.ok);
  const result = {
    valid: failed.length === 0,
    checks,
    reason: failed.length ? failed.map((f) => f.detail).join('；') : null,
    failed: failed.map((f) => f.id),
  };
  if (globalChecks && domainChecks) {
    const globalOk = globalChecks.every((c) => c.ok);
    const globalDetail = globalChecks.filter((c) => !c.ok).map((c) => c.id);
    const domainValidity = {};
    for (const [domain, listed] of Object.entries(domainChecks)) {
      const domainOk = listed.every((c) => c.ok);
      const localDetail = listed.filter((c) => !c.ok).map((c) => c.id);
      domainValidity[domain] = {
        valid: globalOk && domainOk,
        reason: globalOk
          ? (domainOk ? null : `该域已失效：${localDetail.join('、')}`)
          : `整条批准已失效：${globalDetail.join('、')}`,
      };
    }
    result.globalValid = globalOk;
    result.globalFailed = globalDetail;
    result.domainValidity = domainValidity;
  }
  return result;
}

/** 某版本所有批准（含已失效），附带实时判定。 */
function approvalsForVersion(db, versionId, { at = Date.now() } = {}) {
  const rows = db.prepare('SELECT * FROM approvals WHERE version_id = ? ORDER BY decided_at, id').all(versionId);
  return rows.map((row) => decorateApproval(db, row, { at }));
}

function decorateApproval(db, row, { at = Date.now() } = {}) {
  const evaluation = evaluateApproval(db, row, { at });
  const domains = db.prepare('SELECT * FROM approval_domains WHERE approval_id = ? ORDER BY domain').all(row.id);
  return {
    ...row,
    scope: row.scope,
    evaluation,
    domains: domains.map((d) => ({ ...d })),
    domainList: domains.map((d) => d.domain),
    carriedFrom: parseJson(row.carried_from_json, []),
  };
}

/** 有效批准的域覆盖。 */
function effectiveCoverage(db, versionId, { at = Date.now() } = {}) {
  const approvals = approvalsForVersion(db, versionId, { at });
  const coverage = Object.fromEntries(REVIEW_DOMAINS.map((d) => [d, []]));
  for (const approval of approvals) {
    for (const domain of approval.domainList) {
      if (!coverage[domain]) continue;
      // 域级有效性：全局条件必须成立，且该域自身指纹/承继源必须成立。
      const domainValid = approval.evaluation.domainValidity?.[domain]?.valid
        ?? approval.evaluation.valid;
      if (!domainValid) continue;
      coverage[domain].push({
        approvalId: approval.id,
        reviewerId: approval.reviewer_id,
        reviewerName: approval.reviewer_name,
        via: approval.domains.find((x) => x.domain === domain)?.via,
        carriedApprovalId: approval.domains.find((x) => x.domain === domain)?.carried_approval_id ?? null,
      });
    }
  }
  return { approvals, coverage };
}

/**
 * 影响评估：新版本相对基线。
 * 输出决定“补审 vs 全审”，并把理由逐条写清楚，供界面和审计使用。
 */
function assessImpact(db, { newVersion, baseVersion }) {
  const newCheck = currentCheck(db, newVersion);
  const rules = newCheck ? rulesForCheck(db, newCheck) : null;
  const invalidation = rules?.invalidation ?? {};
  const fieldDomains = invalidation.fieldDomains ?? {};
  const alwaysFull = new Set(invalidation.alwaysFullFields ?? []);

  if (!baseVersion) {
    return {
      scope: 'full',
      mode: 'full',
      modes: [],
      reasons: [{ code: 'no_base', text: '没有可承继的基线版本，需全审' }],
      changedFields: [], diff: [], changedDomains: REVIEW_DOMAINS,
      affectedDomains: REVIEW_DOMAINS,
      carryableDomains: [], carrySources: {},
      requiresFullReview: true,
      requiredReviewDomains: REVIEW_DOMAINS,
      estimateMinutes: REVIEW_DOMAINS.length * (rules?.estimation?.minutesPerDomain ?? 20),
      baseVersionId: null,
      risk: { wait: '完整重审等待较久', falseRelease: '最低' },
    };
  }

  const prevFacts = versionFacts(db, baseVersion);
  const nextFacts = newCheck ? versionFacts(db, newVersion) : null;
  const prevNorm = prevFacts?.normalized ?? buildSnapshot(parseJson(baseVersion.raw_json, {})).normalized;
  const nextNorm = nextFacts?.normalized ?? buildSnapshot(parseJson(newVersion.raw_json, {})).normalized;
  const changes = changedDomains(prevNorm, nextNorm);
  const diff = diffSnapshots(prevNorm, nextNorm);

  const affected = new Set();
  const reasons = [];
  const fullReasons = [];
  for (const field of changes.changedFields) {
    const top = field.split('.')[0];
    if (alwaysFull.has(field) || alwaysFull.has(top)) {
      fullReasons.push({ code: 'always_full', text: `字段 ${field} 变化按规则必须全审` });
    }
    const mapped = fieldDomains[field] ?? fieldDomains[top] ?? ['identity'];
    for (const d of mapped) affected.add(d);
  }
  if (changes.changedFields.length === 0) {
    fullReasons.push({ code: 'no_field_diff', text: '未发现字段级差异（保守按全审处理）' });
  }

  // 规则集或检查引擎变化：不可承继。
  const prevRulesHash = prevFacts?.rulesHash;
  const nextRulesHash = nextFacts?.rulesHash;
  if (prevFacts && nextFacts && prevRulesHash !== nextRulesHash) {
    fullReasons.push({ code: 'rules_changed', text: '规则集内容变化，旧批准所依据的规则已不存在' });
  }
  // 输入未变但结果变了（例如检查引擎修复）：保守重审受影响域，且不可承继。
  if (prevFacts && nextFacts && changes.changedFields.length === 0 && prevFacts.resultHash !== nextFacts.resultHash) {
    fullReasons.push({ code: 'result_changed', text: '输入未变但检查结论变化，需重新审阅' });
  }

  const isFull = fullReasons.length > 0;
  const affectedDomains = [...affected].sort();
  const carryable = isFull
    ? []
    : REVIEW_DOMAINS.filter((d) => !affected.has(d));

  if (isFull) {
    reasons.push(...fullReasons);
  } else {
    reasons.push({ code: 'targeted', text: `仅受影响域需重审：${affectedDomains.map(domainLabel).join('、')}` });
    if (carryable.length) {
      reasons.push({
        code: 'carryable',
        text: `以下域输入与结果均未变化，可显式承继旧批准：${carryable.map(domainLabel).join('、')}`,
      });
    }
  }

  // 旧版本上每个域的可用承继来源。
  const carrySources = {};
  if (!isFull && prevFacts) {
    const { coverage } = effectiveCoverage(db, baseVersion.id);
    for (const domain of carryable) {
      carrySources[domain] = coverage[domain].map((c) => ({
        approvalId: c.approvalId,
        reviewerId: c.reviewerId,
        via: c.via,
      }));
    }
  }

  const scope = isFull ? 'full' : 'targeted';
  const requiredReviewDomains = scope === 'full' ? REVIEW_DOMAINS : affectedDomains;
  const estimateMinutes = requiredReviewDomains.length * (rules?.estimation?.minutesPerDomain ?? 20);

  return {
    scope,
    reasons,
    mode: scope,
    changedFields: changes.changedFields,
    diff,
    changedDomains: changes.domains,
    affectedDomains,
    carryableDomains: carryable,
    carrySources,
    requiresFullReview: isFull,
    requiredReviewDomains,
    estimateMinutes,
    baseVersionId: baseVersion.id,
    risk: scope === 'full'
      ? { wait: '完整重审等待较久', falseRelease: '最低' }
      : { wait: `仅需 ${requiredReviewDomains.length} 个域、约 ${estimateMinutes} 分钟`, falseRelease: '仅在已核验的同域输入/结果完全一致时可承继' },
  };
}

/**
 * 提交决定。mode: approve | reject
 * expected: { dataHash, rulesHash, resultHash, checkRunId, reviewSerial }
 * selection: { domains: [...], carry: [{ domain, approvalId }] }
 */
function submitDecision({
  db, versionId, actorId, actorRole, actorName = '', mode, selection = {}, note = '',
  acknowledgedWarnings = false, expected = {}, at = Date.now(),
}) {
  if (!['approve', 'reject'].includes(mode)) throw new ApprovalError('BAD_MODE', '未知决定');
  const version = getVersion(db, versionId);
  if (!version) throw new ApprovalError('VERSION_MISSING', '版本不存在');
  const check = currentCheck(db, version);
  if (!check) throw new ApprovalError('NO_CHECK', '版本缺少当前检查记录');
  if (version.status === 'building' || version.status === 'checking') {
    throw new ApprovalError('NOT_READY', '版本仍在构建或检查中');
  }
  if (version.status === 'build_failed') throw new ApprovalError('BUILD_FAILED', '构建失败的版本不能审阅');
  if (mode === 'approve' && check.status !== 'passed') {
    throw new ApprovalError('CHECK_FAILED', '质量检查未通过，不能批准');
  }
  const rules = rulesForCheck(db, check);
  if (!rules) throw new ApprovalError('RULESET_MISSING', '规则集不存在');

  // 客户端绑定校验。
  for (const [key, actual] of Object.entries({
    dataHash: version.data_hash,
    rulesHash: check.rules_hash,
    resultHash: check.findings_hash,
    checkRunId: check.id,
    reviewSerial: version.review_serial,
  })) {
    if (expected[key] !== undefined && expected[key] !== actual) {
      throw new ApprovalError('BINDING_STALE', '页面展示的输入/规则/结果已被更新，请刷新后重新审阅', {
        field: key, expected: expected[key], actual,
      });
    }
  }

  const facts = versionFacts(db, version);
  if (mode === 'approve' && (!facts || facts.check.id !== check.id)) {
    throw new ApprovalError('BINDING_STALE', '无法重建当前检查结果，请刷新');
  }

  const findings = parseJson(check.findings_json, []);
  const warnings = findings.filter((r) => !r.passed && r.severity === 'warning');
  const blocking = findings.filter((r) => !r.passed && r.severity === 'blocking');

  const policy = rules.review ?? {};
  const required = new Set(policy.requiredDomains ?? REVIEW_DOMAINS);
  const noteMin = mode === 'approve' ? (policy.noteMinLength ?? 0) : 0;
  if ([...note].length < noteMin) {
    throw new ApprovalError('NOTE_TOO_SHORT', `审阅意见至少 ${noteMin} 字，需说明依据`);
  }

  let domains = [];
  let carryPlan = [];
  if (mode === 'approve') {
    if (blocking.length && !(policy.allowBlockingOverride && actorRole === 'compliance')) {
      throw new ApprovalError('CHECK_FAILED', '存在阻断项，不能批准', {
        blocking: blocking.map((b) => ({ ruleId: b.ruleId, message: b.message })),
      });
    }
    // 逐项确认：页面会提交每个已确认的 ruleId；true 仅作为“全部确认”的兼容写法。
    const acknowledged = Array.isArray(acknowledgedWarnings)
      ? new Set(acknowledgedWarnings)
      : new Set(acknowledgedWarnings ? warnings.map((w) => w.ruleId) : []);
    const missingAck = warnings.filter((w) => !acknowledged.has(w.ruleId));
    if (policy.warningAcknowledgement === 'required' && missingAck.length) {
      throw new ApprovalError('WARNINGS_UNACKNOWLEDGED', '存在警告项，必须逐项确认后才能批准', {
        warnings: missingAck.map((w) => ({ ruleId: w.ruleId, message: w.message })),
      });
    }

    const reviewed = Array.isArray(selection.domains) ? [...new Set(selection.domains)] : [];
    for (const d of reviewed) {
      if (!REVIEW_DOMAINS.includes(d)) throw new ApprovalError('BAD_DOMAIN', `未知审阅域 ${d}`);
    }
    for (const d of reviewed) required.delete(d);
    const carryInput = Array.isArray(selection.carry) ? selection.carry : [];
    if (carryInput.length && !policy.requireExplicitCarryover) {
      // 策略允许隐式承继时也仍然需要来源；这里保持显式，避免误放。
    }
    const carryByDomain = new Map();
    for (const item of carryInput) {
      if (!item || !REVIEW_DOMAINS.includes(item.domain)) throw new ApprovalError('BAD_DOMAIN', '承继项域非法');
      if (carryByDomain.has(item.domain)) throw new ApprovalError('DUPLICATE_CARRY', `域 ${domainLabel(item.domain)} 重复指定承继`);
      carryByDomain.set(item.domain, item.approvalId);
    }
    for (const d of carryByDomain.keys()) {
      if (reviewed.includes(d)) throw new ApprovalError('DOMAIN_CONFLICT', `域 ${domainLabel(d)} 既审阅又承继`);
      required.delete(d);
    }
    domains = [...new Set([...reviewed, ...carryByDomain.keys()])].sort();
    if (!domains.length) {
      throw new ApprovalError('DOMAIN_EMPTY', '至少选择一个审阅域或承继项');
    }
    // 完整性不在这里判定：规则允许拆分批准，不同审阅人可以各覆盖一部分域。
    // 版本级完整性由发布前的 effectiveCoverage 统一判定（缺哪个域会明确列出）。
    // 这里只记录本次覆盖哪些域，避免越权声称覆盖了未审的域。

    // 评估是否允许承继：依据版本的影响评估。
    const baseVersion = version.base_version_id ? getVersion(db, version.base_version_id) : null;
    const impact = assessImpact(db, { newVersion: version, baseVersion });
    if (carryByDomain.size) {
      if (!baseVersion) throw new ApprovalError('CARRYOVER_NOT_ALLOWED', '没有基线版本，不能承继');
      if (impact.requiresFullReview) {
        throw new ApprovalError('CARRYOVER_NOT_ALLOWED', '本次更正要求全审，不能承继任何域', { reasons: impact.reasons });
      }
      for (const [domain, approvalId] of carryByDomain) {
        if (!impact.carryableDomains.includes(domain)) {
          throw new ApprovalError('CARRYOVER_DOMAIN_BLOCKED', `域 ${domainLabel(domain)} 本次有变化，不能承继`);
        }
        const old = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
        if (!old) throw new ApprovalError('CARRYOVER_MISSING', `承继源批准 ${approvalId} 不存在`);
        if (old.version_id !== baseVersion.id) {
          throw new ApprovalError('CARRYOVER_NOT_ALLOWED', '承继源必须属于直接基线版本', { approvalId });
        }
        const ev = evaluateApproval(db, old, { at });
        const domainOk = ev.domainValidity?.[domain]?.valid ?? ev.valid;
        if (!domainOk) {
          throw new ApprovalError('CARRYOVER_INVALID', `承继源批准在该域已失效：${ev.domainValidity?.[domain]?.reason ?? ev.reason}`, { approvalId });
        }
        const srcRow = db.prepare('SELECT * FROM approval_domains WHERE approval_id = ? AND domain = ?').get(approvalId, domain);
        if (!srcRow) throw new ApprovalError('CARRYOVER_MISSING', `承继源批准未覆盖域 ${domainLabel(domain)}`, { approvalId });
        if (srcRow.input_hash !== facts.inputHashes[domain]) {
          throw new ApprovalError('CARRYOVER_MISMATCH', `域 ${domainLabel(domain)} 输入指纹不一致，不能承继`, { approvalId });
        }
        if (srcRow.result_hash !== facts.resultHashes[domain]) {
          throw new ApprovalError('CARRYOVER_MISMATCH', `域 ${domainLabel(domain)} 检查结果不一致，不能承继`, { approvalId });
        }
        carryPlan.push({ domain, approvalId, source: old });
      }
    } else {
      // 存在可承继域却选择全审，是允许的（更保守）。
    }

    return tx(db, () => {
      const fresh = getVersion(db, versionId);
      const freshCheck = currentCheck(db, fresh);
      if (fresh.review_serial !== version.review_serial
        || fresh.current_check_id !== check.id
        || fresh.data_hash !== version.data_hash
        || freshCheck?.findings_hash !== check.findings_hash) {
        throw new ApprovalError('BINDING_STALE', '审阅期间输入、检查或批准状态已变化，请刷新');
      }
      if (db.prepare(`SELECT id FROM approvals WHERE version_id=? AND reviewer_id=? AND status='approved'`).get(versionId, actorId)) {
        throw new ApprovalError('ALREADY_APPROVED', '你已对该版本提交过有效批准；如需修改请先撤回');
      }

      const ttl = (rules.approval?.ttlHours ?? 72) * 3600 * 1000;
      const id = newId('apr');
      const carriedIds = carryPlan.map((c) => c.approvalId);
      db.prepare(`INSERT INTO approvals
        (id, version_id, sku, check_run_id, ruleset_id, rules_hash, data_hash, result_hash,
         scope, status, reviewer_role, reviewer_name, reviewer_id, decided_at, expires_at,
         carried_from_json, note, acknowledged_warnings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, versionId, fresh.sku, freshCheck.id, check.ruleset_id, check.rules_hash, fresh.data_hash,
          freshCheck.findings_hash, carriedIds.length ? 'targeted' : 'full',
          actorRole, actorName, actorId, at, at + ttl,
          canonicalJson(carriedIds), note, missingAck.length === 0 ? 1 : 0);

      const insertDomain = db.prepare(`INSERT INTO approval_domains
        (approval_id, domain, input_hash, result_hash, via, carried_approval_id) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const domain of domains) {
        const carried = carryPlan.find((c) => c.domain === domain);
        insertDomain.run(
          id, domain, facts.inputHashes[domain], facts.resultHashes[domain],
          carried ? 'carry' : 'review', carried ? carried.approvalId : null,
        );
      }
      db.prepare('INSERT INTO approval_events (id, approval_id, action, actor_id, at, detail_json) VALUES (?,?,?,?,?,?)')
        .run(newId('aev'), id, 'approved', actorId, at, canonicalJson({
          domains, carriedFrom: carriedIds, acknowledgedWarnings: [...acknowledged].sort(),
          findingsHash: freshCheck.findings_hash, rulesHash: check.rules_hash, dataHash: fresh.data_hash,
        }));
      audit(db, actorId, 'approval.approved', versionId, {
        approvalId: id, domains, carriedFrom: carriedIds, rulesHash: check.rules_hash,
        resultHash: freshCheck.findings_hash, dataHash: fresh.data_hash,
      });
      return {
        ok: true, approvalId: id, domains, carriedFrom: carriedIds,
        expiresAt: at + ttl, binding: bindingOf(db, fresh),
      };
    });
  }

  // reject
  return tx(db, () => {
    const id = newId('apr');
    db.prepare(`INSERT INTO approvals
      (id, version_id, sku, check_run_id, ruleset_id, rules_hash, data_hash, result_hash,
       scope, status, reviewer_role, reviewer_name, reviewer_id, decided_at, expires_at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'full', 'rejected', ?, ?, ?, ?, ?, ?)`)
      .run(id, versionId, version.sku, check.id, check.ruleset_id, check.rules_hash,
        version.data_hash, check.findings_hash, actorRole, actorName, actorId, at, at, note);
    db.prepare('INSERT INTO approval_events (id, approval_id, action, actor_id, at, detail_json) VALUES (?,?,?,?,?,?)')
      .run(newId('aev'), id, 'rejected', actorId, at, canonicalJson({ note }));
    audit(db, actorId, 'approval.rejected', versionId, { approvalId: id, note });
    return { ok: true, approvalId: id, status: 'rejected' };
  });
}

/** 撤回（本人）或强制撤回（合规角色），推进 review_serial。 */
function withdrawApproval({ db, approvalId, actorId, actorRole, reason = '', at = Date.now() }) {
  if (!reason.trim()) throw new ApprovalError('REASON_REQUIRED', '撤回必须说明原因');
  return tx(db, () => {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval) throw new ApprovalError('APPROVAL_MISSING', '批准不存在');
    if (approval.status !== 'approved') throw new ApprovalError('NOT_ACTIVE', `批准状态为 ${approval.status}，不能撤回`);
    if (approval.reviewer_id !== actorId && actorRole !== 'compliance') {
      throw new ApprovalError('FORBIDDEN', '只能撤回自己的批准；合规角色可代为撤回');
    }
    db.prepare(`UPDATE approvals SET status='withdrawn', invalidation_reason=?, invalidated_at=? WHERE id=?`)
      .run(reason.trim(), at, approvalId);
    db.prepare('UPDATE versions SET review_serial = review_serial + 1 WHERE id = ?').run(approval.version_id);
    db.prepare('INSERT INTO approval_events (id, approval_id, action, actor_id, at, detail_json) VALUES (?,?,?,?,?,?)')
      .run(newId('aev'), approvalId, 'withdrawn', actorId, at, canonicalJson({ reason: reason.trim() }));
    audit(db, actorId, 'approval.withdrawn', approval.version_id, { approvalId, reason: reason.trim() });
    return { ok: true, approvalId };
  });
}

/** 系统失效：状态置 invalidated/expired，推进 review_serial。 */
function invalidateApproval(db, approvalId, reason, { actorId = null, at = Date.now(), action = 'invalidated' } = {}) {
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  if (!approval || approval.status !== 'approved') return false;
  const status = action === 'expired' ? 'expired' : 'invalidated';
  db.prepare(`UPDATE approvals SET status=?, invalidation_reason=?, invalidated_at=? WHERE id=?`)
    .run(status, reason, at, approvalId);
  db.prepare('UPDATE versions SET review_serial = review_serial + 1 WHERE id = ?').run(approval.version_id);
  db.prepare('INSERT INTO approval_events (id, approval_id, action, actor_id, at, detail_json) VALUES (?,?,?,?,?,?)')
    .run(newId('aev'), approvalId, status, actorId, at, canonicalJson({ reason }));
  audit(db, actorId, `approval.${status}`, approval.version_id, { approvalId, reason });
  return true;
}

/**
 * 过期清扫。发布路径必然先调用它；也提供独立入口供定时任务/演示。
 * 注意：清扫会推进 review_serial，因此不能放在发布事务内对“已验证集合”之外乱扫，
 * 发布服务会在自己的事务里先扫后验。
 */
function sweepExpired(db, { at = Date.now(), sku = null } = {}) {
  const rows = sku
    ? db.prepare(`SELECT a.id, a.expires_at FROM approvals a JOIN versions v ON v.id = a.version_id
                  WHERE a.status='approved' AND a.expires_at <= ? AND v.sku = ?`).all(at, sku)
    : db.prepare(`SELECT id, expires_at FROM approvals WHERE status='approved' AND expires_at <= ?`).all(at);
  const expired = [];
  for (const row of rows) {
    if (invalidateApproval(db, row.id, `批准有效期至 ${new Date(row.expires_at).toISOString()}，已过期`, { at, action: 'expired' })) {
      expired.push(row.id);
    }
  }
  return expired;
}

/**
 * 上游更正：把旧版本上的 live 批准显式作废，并记录更正来源。
 * 调用方负责在同一写事务内创建新版本。这里不做事务管理。
 */
function invalidateForCorrection(db, { oldVersionId, newVersionId, actorId, at = Date.now(), reason }) {
  const rows = db.prepare(`SELECT id FROM approvals WHERE version_id = ? AND status = 'approved'`).all(oldVersionId);
  const out = [];
  for (const row of rows) {
    if (invalidateApproval(db, row.id, `上游已更正（新版本 ${newVersionId}）：${reason}`, { actorId, at })) {
      out.push(row.id);
    }
  }
  return out;
}

/** 规则集内容变更：该规则集下的检查标记 stale，批准全部失效。 */
function invalidateForRulesChange(db, { rulesetId, candidateIds = null, actorId = null, at = Date.now() }) {
  const checks = candidateIds
    ? candidateIds.map((id) => getCheck(db, id)).filter(Boolean)
    : db.prepare(`SELECT * FROM check_runs WHERE ruleset_id = ? AND status IN ('passed','failed')`).all(rulesetId);
  let approvals = 0;
  for (const check of checks) {
    db.prepare(`UPDATE check_runs SET status='stale' WHERE id=?`).run(check.id);
    const rows = db.prepare(`SELECT id FROM approvals WHERE check_run_id = ? AND status='approved'`).all(check.id);
    for (const row of rows) {
      if (invalidateApproval(db, row.id, '规则集内容已变化，原批准依据失效', { actorId, at })) approvals += 1;
    }
  }
  return { checks: checks.length, approvals };
}

module.exports = {
  REVIEW_DOMAINS,
  ApprovalError,
  currentCheck,
  rulesForCheck,
  versionFacts,
  bindingOf,
  evaluateApproval,
  approvalsForVersion,
  decorateApproval,
  effectiveCoverage,
  assessImpact,
  submitDecision,
  withdrawApproval,
  invalidateApproval,
  sweepExpired,
  invalidateForCorrection,
  invalidateForRulesChange,
};
