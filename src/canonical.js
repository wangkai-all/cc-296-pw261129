'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

/** 递归键排序后的规范 JSON，用于计算稳定指纹。 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** 带前缀的短摘要，界面与审计里便于人读；完整值另存。 */
function digest(value) {
  const hex = sha256Hex(typeof value === 'string' ? value : canonicalJson(value));
  return { hex, short: hex.slice(0, 12) };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 把任意一次“输入快照”归一为可比较的结构：
 * 数据内容、规则内容、检查结果三者分别计指纹。
 */
function fingerprintBundle({ dataset, rules, findings }) {
  const data = digest(dataset);
  const ruleSet = digest(rules);
  const result = digest(findings);
  return {
    dataHex: data.hex,
    dataShort: data.short,
    rulesHex: ruleSet.hex,
    rulesShort: ruleSet.short,
    resultHex: result.hex,
    resultShort: result.short,
    // 组合指纹用于“批准绑定”与界面上的单枚印章。
    combinedHex: digest({ data: data.hex, rules: ruleSet.hex, result: result.hex }).hex,
  };
}

module.exports = { canonicalJson, sha256Hex, digest, safeEqual, fingerprintBundle };
