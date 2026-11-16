'use strict';
/** 极简 HTTP 工具：JSON 响应、表单解析、错误映射。 */
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'BAD_JSON', '请求体必须是 JSON 对象');
  }
}

async function readForm(req) {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const out = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/** 把业务错误映射为状态码；未知错误不泄漏堆栈。 */
function mapError(err) {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message, detail: err.detail };
  const known = {
    ApprovalError: 409, ReleaseError: 409, BuildError: 409,
  };
  if (err?.name && known[err.name]) {
    const status = err.code === 'FORBIDDEN' ? 403 : 409;
    return { status, code: err.code ?? err.name, message: err.message, detail: err.detail ?? null };
  }
  return { status: 500, code: 'INTERNAL', message: '服务器内部错误', detail: null };
}

module.exports = {
  HttpError,
  sendJson,
  sendHtml,
  redirect,
  readBody,
  readJson,
  readForm,
  asArray,
  mapError,
};
