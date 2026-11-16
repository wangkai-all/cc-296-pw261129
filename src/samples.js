'use strict';
/**
 * 演示样例与发布包下载。
 *
 * 所有样例都跑在专用 SKU 上，可重复执行：每次生成新版本，
 * 不修改既有版本与回执。样例数据全部虚构。
 */
const zlib = require('node:zlib');
const { esc, fmtTime, badge, layout, section, empty } = require('./views/ui');
const { NAV } = require('./views/pages');
const { openDatabase } = require('./db');
const { tx } = require('./db');
const { canonicalJson } = require('./canonical');
const pipeline = require('./domain/pipeline');
const A = require('./domain/approvals');
const R = require('./domain/releases');

const SAMPLE_SKUS = [
  {
    sku: 'OKF-S01', name: '样例：构建失败与恢复', owner: 'steward',
    description: '构建遇到可重试异常 → 版本停留在构建失败（不可批准）→ 重试成功 → 进入审阅。',
    action: 'build-failure',
  },
  {
    sku: 'OKF-S02', name: '样例：审批过期', owner: 'steward',
    description: '批准在有效期内完成，但发布前已过期 → 发布被阻止；需要重新审阅。',
    action: 'expiry',
  },
];

const BASE_RAW = {
  brand: '山岚', category: 'homecare', tax_included: true, status: 'on_sale',
  price: 19.9, currency: 'CNY', inventory: 30, lead_time_days: 2,
  markets: ['CN'], labels: ['cosmetic'], allergen_note: null, origin_country: 'CN',
  description: '用于本地演示的虚构商品资料，与任何真实商品无关。',
};

function ensureDemoWorld(db) {
  const now = Date.now();
  const users = [
    ['u-linzhou', 'lin-zhou', '林舟', 'steward', '资料管理员'],
    ['u-shenhe', 'shen-he', '沈禾', 'reviewer', '类目审阅'],
    ['u-guqing', 'gu-qing', '顾青', 'compliance', '合规审阅'],
    ['u-luxing', 'lu-xing', '陆行', 'release', '发布经理'],
    ['u-yan', 'yan-shu', '颜述', 'auditor', '审计员'],
  ];
  tx(db, () => {
    for (const [id, handle, name, role, title] of users) {
      db.prepare('INSERT OR IGNORE INTO users (id, handle, name, role, title) VALUES (?, ?, ?, ?, ?)')
        .run(id, handle, name, role, title);
    }
    const skus = [
      ['OKF-1001', '山岚 无香洗衣液'],
      ['OKF-1002', '野原 冷萃咖啡液'],
      ['OKF-1003', '砾石 桌面音箱'],
      ...SAMPLE_SKUS.map((s) => [s.sku, s.name]),
    ];
    for (const [sku, name] of skus) {
      db.prepare('INSERT OR IGNORE INTO skus (sku, name, generation, created_at) VALUES (?, ?, 0, ?)')
        .run(sku, name, now);
    }
  });
}

const PRODUCTS = {
  'OKF-1001': {
    name: '山岚 无香洗衣液', brand: '山岚', category: 'homecare',
    description: '一款用于日常衣物的无香型浓缩洗衣液，低泡易漂洗，适用于机洗与手洗。',
    price: 39.9, currency: 'CNY', inventory: 120, lead_time_days: 3, status: 'on_sale',
    markets: ['CN', 'EU'], labels: ['cosmetic', 'textile'], allergen_note: '不含常见过敏原',
    origin_country: 'CN', tax_included: true,
  },
  'OKF-1002': {
    name: '野原 冷萃咖啡液', brand: '野原', category: 'food',
    description: '低温慢萃的浓缩咖啡液，单条 20ml，冷热水皆可冲泡，适合通勤。',
    price: 59, currency: 'CNY', inventory: 60, lead_time_days: 2, status: 'on_sale',
    markets: ['CN'], labels: ['food'], allergen_note: '含咖啡因', origin_country: 'CN',
    tax_included: true,
  },
  'OKF-1003': {
    name: '砾石 桌面音箱', brand: '砾石', category: 'electronics',
    description: '桌面近场有源音箱，蓝牙与 USB-C 双输入，附 3.5mm 音频线。',
    price: 329, currency: 'CNY', inventory: 25, lead_time_days: 7, status: 'preorder',
    markets: ['CN', 'EU'], labels: ['electronics'], allergen_note: '', origin_country: 'CN',
    tax_included: true,
  },
};

function rawFor(sku, overrides = {}) {
  const base = PRODUCTS[sku] ?? { ...BASE_RAW, name: '样例商品' };
  return { sku, ...base, ...overrides };
}

function userId(db, handle) {
  return db.prepare('SELECT id FROM users WHERE handle = ?').get(handle)?.id ?? null;
}

function approveFully(db, versionId, { reviewerHandle = 'shen-he', at = Date.now(), note = '已逐项核对检查结果与输入指纹' } = {}) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  const binding = A.bindingOf(db, version);
  const uid = userId(db, reviewerHandle);
  return A.submitDecision({
    db, versionId, actorId: uid, actorRole: 'reviewer', actorName: db.prepare('SELECT name FROM users WHERE id=?').get(uid).name,
    mode: 'approve',
    selection: { domains: ['identity', 'pricing', 'compliance', 'inventory'], carry: [] },
    note, acknowledgedWarnings: true, at,
    expected: {
      dataHash: binding.dataHash, rulesHash: binding.rulesHash, resultHash: binding.resultHash,
      checkRunId: binding.checkRunId, reviewSerial: binding.reviewSerial,
    },
  });
}

/** 构建失败样例。返回结构化结果，页面展示可点击的版本链接。 */
function runBuildFailureSample(db) {
  const sku = 'OKF-S01';
  const actor = userId(db, 'lin-zhou');
  const failed = pipeline.createVersion({
    db, sku, raw: rawFor(sku), reason: '样例：首次构建（故意注入可重试异常）',
    actorId: actor, fault: 'transient', rulesetVersion: 1, independent: true,
  });
  const retried = pipeline.retryBuild({ db, versionId: failed.versionId, actorId: actor });
  return {
    sku, versionId: failed.versionId,
    steps: [
      { text: '构建注入可重试异常，版本进入“构建失败”；未产生数据快照', status: failed.status },
      { text: '对同一版本重试构建（输入未变，不新建版本）', status: retried.status },
      { text: '构建成功并完成质量检查，版本进入“待审阅”', status: retried.status },
    ],
    versionLink: `/versions/${failed.versionId}`,
    publishable: R.assessPublishability(db, { versionId: failed.versionId }).publishable,
  };
}

/** 审批过期样例。 */
function runExpirySample(db, { now = Date.now() } = {}) {
  const sku = 'OKF-S02';
  const actor = userId(db, 'lin-zhou');
  const version = pipeline.createVersion({
    db, sku, raw: rawFor(sku, { name: '样例：档案夹', category: 'stationery', description: '用于审批过期演示的虚构商品资料。', price: 12.5, labels: ['textile'] }),
    reason: '样例：创建并批准，但批准早于现在 100 小时',
    actorId: actor, rulesetVersion: 1, at: now - 100 * 3600 * 1000, independent: true,
  });
  // 当时的批准：有效期为 72 小时，因此现在已过期。
  const approval = approveFully(db, version.versionId, {
    at: now - 100 * 3600 * 1000, note: '当时核对无误，但发布拖延了',
  });
  const before = A.approvalsForVersion(db, version.versionId, { at: now })[0];
  const sweep = A.sweepExpired(db, { at: now, sku });
  const after = A.approvalsForVersion(db, version.versionId, { at: now })[0];
  const assess = R.assessPublishability(db, { versionId: version.versionId, at: now });
  const versionRow = db.prepare('SELECT * FROM versions WHERE id = ?').get(version.versionId);
  let taskId = null;
  let out;
  try {
    taskId = R.enqueuePublishTask({
      db, sku, versionId: version.versionId, actorId: userId(db, 'lu-xing'),
      note: '样例：尝试发布已过期的批准', at: now,
      expected: { approvalSetHash: assess.approvalSetHash, currentReleaseId: null, generation: 0 },
    }).taskId;
    out = R.executePublishTask({ db, taskId, at: now });
  } catch (err) {
    // 过期批准在入队复验时即被拒绝，这是预期的最短失败路径。
    out = { status: 'blocked', reason: `${err.code}：${err.message}`, code: err.code };
  }
  return {
    sku, versionId: version.versionId,
    steps: [
      { text: `批准于 ${fmtTime(now - 100 * 3600 * 1000)} 提交（有效期 72 小时）`, status: 'approved' },
      { text: '发布前评估：批准已过期，不能使用', status: before.evaluation.valid ? 'unexpected' : 'expired' },
      { text: `过期清扫：${sweep.length} 条批准标记为 expired`, status: sweep.length ? 'expired' : 'none' },
      { text: `发布被阻止：${out.reason}`, status: out.status },
      { text: '结论：需重新审阅并生成新的批准；旧批准不能“续期”', status: 'info' },
    ],
    approvalId: approval.approvalId,
    versionLink: `/versions/${version.versionId}`,
    taskId,
  };
}

async function runSample({ db, name, user }) {
  if (!user) throw new Error('需要登录');
  ensureDemoWorld(db);
  if (name === 'build-failure') return runBuildFailureSample(db);
  if (name === 'expiry') return runExpirySample(db, { now: Date.now() });
  throw new Error('未知样例');
}

function samplesPage({ user, db, now }) {
  ensureDemoWorld(db);
  const rows = SAMPLE_SKUS.map((s) => {
    const versions = db.prepare('SELECT * FROM versions WHERE sku = ? ORDER BY seq DESC LIMIT 3').all(s.sku);
    return `<div class="sample-card">
      <div class="sample-head">
        <div>
          <h3>${esc(s.name)}</h3>
          <p class="mono small muted">${esc(s.sku)}</p>
        </div>
        <form method="post" action="/samples/run" class="inline" data-sample="${esc(s.action)}">
          <input type="hidden" name="name" value="${esc(s.action)}">
          <button class="btn primary small" type="submit">运行样例</button>
        </form>
      </div>
      <p class="small">${esc(s.description)}</p>
      <div class="sample-versions">
        ${versions.length ? versions.map((v) => `<a class="mini" href="/versions/${esc(v.id)}">v${v.seq}</a>`).join(' ') : '<span class="muted small">尚未运行</span>'}
      </div>
    </div>`;
  }).join('');
  const body = `<div class="page-head">
    <div><h1>演示样例</h1><p class="sub">覆盖两类高风险路径：构建失败后的恢复，以及审批在发布前过期。所有数据虚构。</p></div>
  </div>
  ${section('可运行的样例', `<div class="sample-grid">${rows}</div>
    <p class="hint">样例在专用 SKU 上运行，每次生成新版本，不修改既有回执。可重复运行。</p>`)}
  ${section('不做什么', `<ul class="reason-list">
    <li>不做电子签章、CA 或实名认证；批准是本地角色记录，不具法律效力。</li>
    <li>不自动替任何人批准；补审与承继都需要具名操作者显式提交。</li>
    <li>不在回滚时改写历史回执；回滚生成新代号，指向原产物。</li>
  </ul>`)}`;
  return layout({ title: '演示样例', user, nav: NAV('samples'), body, wide: true });
}

// ---------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 最小 ZIP（store 方式，无压缩），保证发布包内容与数据库产物逐字节一致。
 * 不使用第三方库，避免供应链面。
 */
function buildZip(db, releaseId) {
  const rows = db.prepare('SELECT name, bytes FROM release_artifacts WHERE release_id = ? ORDER BY name').all(releaseId);
  const files = rows.map((r) => {
    const data = Buffer.from(r.bytes);
    return { name: r.name, data, crc: crc32(data), offset: 0 };
  });
  const localParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 flag
    header.writeUInt16LE(0, 8); // store
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(f.crc, 14);
    header.writeUInt32LE(f.data.length, 18);
    header.writeUInt32LE(f.data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    f.offset = offset;
    localParts.push(header, nameBuf, f.data);
    offset += header.length + nameBuf.length + f.data.length;
  }
  const centralParts = [];
  const cdStart = offset;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(0x0800, 8);
    rec.writeUInt16LE(0, 10);
    rec.writeUInt16LE(0, 12);
    rec.writeUInt16LE(0, 14);
    rec.writeUInt32LE(f.crc, 16);
    rec.writeUInt32LE(f.data.length, 20);
    rec.writeUInt32LE(f.data.length, 24);
    rec.writeUInt16LE(nameBuf.length, 28);
    rec.writeUInt16LE(0, 30);
    rec.writeUInt16LE(0, 32);
    rec.writeUInt16LE(0, 34);
    rec.writeUInt16LE(0, 36);
    rec.writeUInt32LE(0, 38);
    rec.writeUInt32LE(f.offset, 42);
    centralParts.push(rec, nameBuf);
    offset += rec.length + nameBuf.length;
  }
  const cdSize = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

module.exports = {
  SAMPLE_SKUS,
  PRODUCTS,
  ensureDemoWorld,
  rawFor,
  runSample,
  runBuildFailureSample,
  runExpirySample,
  samplesPage,
  buildZip,
  crc32,
};
