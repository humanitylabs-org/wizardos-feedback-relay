// WizardOS Feedback relay — Cloudflare Worker (ES module, no dependencies, no build).
//
// Takes bug/feature reports from the Feedback app (signed in or not) and files them
// as GitHub issues in humanitylabs-org using the "WizardOS Feedback Relay" GitHub App.
// Trusted reporters go straight to TRIAGE_REPO; everyone else lands in INBOX_REPO
// for a person to review. Reporters get a random receipt they can poll for a
// plain-words status; no repo names, labels, URLs, logins or comments are returned.

const GH_API = 'https://api.github.com';
const UA = 'wizardos-feedback-relay';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_SHOT_BYTES = 2 * 1024 * 1024;
const MAX_SHOTS = 3;
const TEXT_MIN = 8;
const TEXT_MAX = 8000;
const TITLE_MAX = 90;
const STATUS_MAX_RECEIPTS = 50;
const SEARCH_BATCH = 5; // GitHub search allows at most 5 boolean operators per query
const MEDIA_REPO = 'wizard-issue-media';
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const RECEIPT_RE = /^[0-9a-f]{32}$/;
const MARKER_RE = /<!-- feedback-receipt: ([0-9a-f]{32}) -->/;

// ---------------------------------------------------------------- status mapping

export const STATUS_LINES = {
  waiting_review: 'Waiting for a person to review',
  not_planned: 'Not planned',
  done: 'Done',
  received: 'Received — sorting it',
  ready: 'Ready for the team to try',
  checking: 'Being checked',
  building: 'Being built',
  queued: 'In line to be built',
  not_found: 'Not found yet — new reports can take a minute to show up',
};

/** Pure: GitHub issue {state, state_reason, labels} -> {status_key, line}. */
export function statusFor(issue) {
  const labels = new Set((issue.labels || []).map((l) => String(typeof l === 'string' ? l : l.name).toLowerCase()));
  let key;
  if (issue.state === 'closed') {
    key = issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate' ? 'not_planned' : 'done';
  } else if (labels.has('needs-review')) key = 'waiting_review';
  else if (labels.has('ready-to-test')) key = 'ready';
  else if (labels.has('ai-review')) key = 'checking';
  else if (labels.has('building')) key = 'building';
  else if (labels.has('triage')) key = 'received';
  else key = 'queued';
  return { status_key: key, line: STATUS_LINES[key] };
}

// ---------------------------------------------------------------- text helpers

/** Strip control characters (keeps \n and \t), normalise newlines. */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
}

/** Single-line cleaned field, capped. */
export function cleanLine(s, max) {
  return cleanText(s).replace(/\s+/g, ' ').slice(0, max).trim();
}

/** Title from the first sentence/line, ≤ 90 chars. */
export function makeTitle(text, max = TITLE_MAX) {
  const t = cleanText(text);
  const firstLine = t.split('\n').find((l) => l.trim()) || t;
  const m = firstLine.match(/^.*?[.!?](?=\s|$)/);
  let title = (m ? m[0] : firstLine).replace(/\s+/g, ' ').trim();
  if (title.length > max) {
    const cut = title.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    title = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
  }
  return title || 'Feedback';
}

/** Make untrusted text inert in an issue body: no hidden markers, no pings, no cross-links. */
export function neutralize(text) {
  return text
    .replace(/<!--/g, '&lt;!--')
    .replace(/feedback-receipt:/gi, 'feedback receipt:')
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@\u200b')
    .replace(/(^|[^\w&`])#(?=\d)/g, '$1#\u200b')
    .replace(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(?=\d)/g, '$1#\u200b');
}

// ---------------------------------------------------------------- receipts

export function newReceipt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** "a,b,c" -> unique valid receipts, or throws a client error. */
export function parseReceipts(raw) {
  if (!raw) throw clientError(400, 'bad_request', 'Pass ?receipt=<id>[,<id>…]');
  const list = [...new Set(String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) throw clientError(400, 'bad_request', 'No receipts given');
  if (list.length > STATUS_MAX_RECEIPTS) throw clientError(400, 'too_many', `At most ${STATUS_MAX_RECEIPTS} receipts per request`);
  const bad = list.find((r) => !RECEIPT_RE.test(r));
  if (bad) throw clientError(400, 'bad_receipt', 'A receipt is not valid');
  return list;
}

export function receiptFromBody(body) {
  const m = String(body || '').match(MARKER_RE);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- validation

function clientError(status, error, message) {
  const e = new Error(message);
  e.status = status;
  e.code = error;
  return e;
}

export function base64Bytes(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Validates the POST /v1/report body. Returns a normalised report or throws. */
export function validateReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw clientError(400, 'bad_request', 'Body must be a JSON object');
  const kind = input.kind;
  if (kind !== 'bug' && kind !== 'feature') throw clientError(400, 'bad_kind', "kind must be 'bug' or 'feature'");
  if (typeof input.text !== 'string') throw clientError(400, 'bad_text', 'text is required');
  const text = cleanText(input.text);
  if (text.length < TEXT_MIN) throw clientError(400, 'text_too_short', `Please write at least ${TEXT_MIN} characters`);
  if (text.length > TEXT_MAX) throw clientError(400, 'text_too_long', `Please keep it under ${TEXT_MAX} characters`);
  const opt = (v, max, name) => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'string') throw clientError(400, 'bad_request', `${name} must be a string`);
    return cleanLine(v, max);
  };
  const wizard_version = opt(input.wizard_version, 64, 'wizard_version');
  const device = opt(input.device, 160, 'device');
  let gh_token = '';
  if (input.gh_token !== undefined && input.gh_token !== null && input.gh_token !== '') {
    if (typeof input.gh_token !== 'string' || input.gh_token.length > 512 || /\s/.test(input.gh_token)) throw clientError(400, 'bad_token', 'gh_token is not valid');
    gh_token = input.gh_token;
  }
  const screenshots = [];
  if (input.screenshots !== undefined && input.screenshots !== null) {
    if (!Array.isArray(input.screenshots)) throw clientError(400, 'bad_screenshots', 'screenshots must be a list');
    if (input.screenshots.length > MAX_SHOTS) throw clientError(400, 'too_many_screenshots', `At most ${MAX_SHOTS} screenshots`);
    for (const s of input.screenshots) {
      if (!s || typeof s !== 'object') throw clientError(400, 'bad_screenshots', 'Each screenshot needs type and data');
      const type = String(s.type || '').toLowerCase();
      const ext = IMAGE_TYPES[type];
      if (!ext) throw clientError(400, 'bad_screenshot_type', 'Screenshots must be PNG, JPEG, WebP or GIF');
      let data = typeof s.data === 'string' ? s.data.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '') : '';
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw clientError(400, 'bad_screenshot_data', 'Screenshot data must be base64');
      if (base64Bytes(data) > MAX_SHOT_BYTES) throw clientError(413, 'screenshot_too_large', 'Each screenshot must be under 2 MB');
      screenshots.push({ type, ext, data });
    }
  }
  return { kind, text, wizard_version, device, gh_token, screenshots };
}

// ---------------------------------------------------------------- issue body

export function buildIssueBody({ report, receipt, trusted, login, shots = [], failedShots = 0 }) {
  const parts = [trusted ? report.text : neutralize(report.text)];
  if (shots.length || failedShots) {
    parts.push('', '**Screenshots**', '');
    shots.forEach((u, i) => parts.push(`![Screenshot ${i + 1}](${u})`));
    if (failedShots) parts.push(`_${failedShots} screenshot${failedShots > 1 ? 's' : ''} could not be attached._`);
  }
  const meta = [];
  if (report.wizard_version) meta.push(`Wizard version: ${neutralize(report.wizard_version)}`);
  if (report.device) meta.push(`Device: ${neutralize(report.device)}`);
  parts.push('', '---');
  if (meta.length) parts.push(meta.join(' · '), '');
  if (trusted) parts.push(`Filed with Feedback by @${login} (via relay)`);
  else parts.push(`Filed with Feedback via relay. Submitter: ${login ? `@${login}, not on the trusted list` : 'anonymous'}`);
  parts.push('', `<!-- feedback-receipt: ${receipt} -->`, `<!-- feedback-kind: ${report.kind} -->`);
  return parts.join('\n');
}

// ---------------------------------------------------------------- crypto: PEM, PKCS#1 -> PKCS#8, JWT

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(n) {
  if (n < 0x80) return [n];
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>>= 8; }
  return [0x80 | b.length, ...b];
}

function derWrap(tag, content) {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** Wrap a PKCS#1 RSAPrivateKey DER in a PKCS#8 PrivateKeyInfo DER. */
export function pkcs1ToPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algId = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return derWrap(0x30, concat(version, algId, derWrap(0x04, pkcs1)));
}

/** PEM (PKCS#1 or PKCS#8; literal "\n" tolerated) -> PKCS#8 DER bytes. */
export function pemToPkcs8Der(pem) {
  const text = String(pem || '').replace(/\\n/g, '\n').trim();
  const m = text.match(/-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error('GH_APP_PRIVATE_KEY is not a PEM private key');
  const der = b64ToBytes(m[2].replace(/[^A-Za-z0-9+/=]/g, ''));
  return m[1] === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(der) : der;
}

export async function importAppKey(pem) {
  return crypto.subtle.importKey('pkcs8', pemToPkcs8Der(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** RS256 GitHub App JWT (iat backdated 60 s, 9 min lifetime). */
export async function signAppJwt(appId, pemOrKey, nowSec = Math.floor(Date.now() / 1000)) {
  const key = typeof pemOrKey === 'string' ? await importAppKey(pemOrKey) : pemOrKey;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- rate limiting (per isolate)

export function makeLimiter() {
  const hits = new Map();
  return function allow(bucket, ip, limit, windowMs, now = Date.now()) {
    const k = `${bucket}:${ip}`;
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { hits.set(k, arr); return false; }
    arr.push(now);
    hits.set(k, arr);
    if (hits.size > 5000) for (const [kk, v] of hits) if (!v.length || now - v[v.length - 1] > 600000) hits.delete(kk);
    return true;
  };
}

// ---------------------------------------------------------------- the app

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
}

function errorResponse(status, error, message) {
  return json({ error, message }, status);
}

/** Build a handler. `fetchImpl` is injectable for tests. */
export function createApp({ fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const allow = makeLimiter();
  const tokenCache = { token: '', exp: 0, key: null, keyFor: '' };
  const statusCache = new Map();

  async function gh(path, { method = 'GET', token, body, auth = 'Bearer' } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA };
    if (token) headers.Authorization = `${auth} ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(GH_API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    let data = null;
    if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
    return { status: res.status, data };
  }

  function config(env) {
    const missing = ['GH_APP_ID', 'GH_APP_PRIVATE_KEY'].filter((k) => !env[k]);
    if (missing.length) throw clientError(503, 'not_configured', 'The relay is not set up yet');
    return {
      appId: String(env.GH_APP_ID),
      pem: env.GH_APP_PRIVATE_KEY,
      org: env.GH_ORG || 'humanitylabs-org',
      inbox: env.INBOX_REPO || 'wizardos-feedback-inbox',
      triage: env.TRIAGE_REPO || 'wizard-os',
      trusted: new Set(String(env.TRUSTED_LOGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    };
  }

  async function installationToken(cfg) {
    if (tokenCache.token && now() < tokenCache.exp - 5 * 60 * 1000) return tokenCache.token;
    if (!tokenCache.key || tokenCache.keyFor !== cfg.appId) {
      tokenCache.key = await importAppKey(cfg.pem);
      tokenCache.keyFor = cfg.appId;
    }
    const jwt = await signAppJwt(cfg.appId, tokenCache.key, Math.floor(now() / 1000));
    const inst = await gh(`/orgs/${cfg.org}/installation`, { token: jwt });
    if (inst.status !== 200 || !inst.data?.id) throw clientError(502, 'upstream', 'The relay could not reach GitHub');
    const tok = await gh(`/app/installations/${inst.data.id}/access_tokens`, { method: 'POST', token: jwt, body: {} });
    if (tok.status !== 201 || !tok.data?.token) throw clientError(502, 'upstream', 'The relay could not reach GitHub');
    tokenCache.token = tok.data.token;
    tokenCache.exp = Date.parse(tok.data.expires_at) || now() + 55 * 60 * 1000;
    return tokenCache.token;
  }

  /** Returns {login, trusted}. Bad or missing gh_token = anonymous. */
  async function whoIs(cfg, ghToken, instToken) {
    if (!ghToken) return { login: '', trusted: false };
    const u = await gh('/user', { token: ghToken });
    const login = u.status === 200 && typeof u.data?.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(u.data.login) ? u.data.login : '';
    if (!login) return { login: '', trusted: false };
    if (cfg.trusted.has(login.toLowerCase())) return { login, trusted: true };
    const mem = await gh(`/orgs/${cfg.org}/members/${encodeURIComponent(login)}`, { token: instToken });
    return { login, trusted: mem.status === 204 };
  }

  async function uploadShots(cfg, token, receipt, shots) {
    const year = new Date(now()).getUTCFullYear();
    const urls = [];
    let failed = 0;
    for (let i = 0; i < shots.length; i++) {
      const path = `feedback/${year}/${receipt}-${i + 1}.${shots[i].ext}`;
      try {
        const r = await gh(`/repos/${cfg.org}/${MEDIA_REPO}/contents/${path}`, { method: 'PUT', token, body: { message: `feedback screenshot ${receipt}-${i + 1}`, content: shots[i].data } });
        const html = r.data?.content?.html_url;
        if ((r.status === 201 || r.status === 200) && html) urls.push(`${html}?raw=true`);
        else failed++;
      } catch { failed++; }
    }
    return { urls, failed };
  }

  async function handleReport(request, env) {
    const cl = Number(request.headers.get('content-length') || 0);
    if (cl > MAX_BODY_BYTES) throw clientError(413, 'too_large', 'Request is too large');
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) throw clientError(413, 'too_large', 'Request is too large');
    let input;
    try { input = JSON.parse(new TextDecoder().decode(buf)); } catch { throw clientError(400, 'bad_json', 'Body must be JSON'); }
    const report = validateReport(input);
    const cfg = config(env);
    const token = await installationToken(cfg);
    const who = await whoIs(cfg, report.gh_token, token);
    const receipt = newReceipt();
    const shots = report.screenshots.length ? await uploadShots(cfg, token, receipt, report.screenshots) : { urls: [], failed: 0 };
    const repo = who.trusted ? cfg.triage : cfg.inbox;
    const labels = [who.trusted ? 'triage' : 'needs-review', report.kind];
    const body = buildIssueBody({ report, receipt, trusted: who.trusted, login: who.login, shots: shots.urls, failedShots: shots.failed });
    const r = await gh(`/repos/${cfg.org}/${repo}/issues`, { method: 'POST', token, body: { title: makeTitle(report.text), body, labels } });
    if (r.status !== 201) throw clientError(502, 'upstream', 'Could not file the report right now, please try again');
    const st = statusFor({ state: 'open', labels });
    return json({ receipt, ...st }, 201);
  }

  async function handleStatus(url, env) {
    const receipts = parseReceipts(url.searchParams.get('receipt'));
    const cfg = config(env);
    const results = {};
    const todo = [];
    for (const r of receipts) {
      const c = statusCache.get(r);
      if (c && now() - c.at < 30000) results[r] = c.value;
      else todo.push(r);
    }
    if (todo.length) {
      const token = await installationToken(cfg);
      for (let i = 0; i < todo.length; i += SEARCH_BATCH) {
        const batch = todo.slice(i, i + SEARCH_BATCH);
        const q = `org:${cfg.org} is:issue in:body ${batch.map((x) => `"feedback-receipt: ${x}"`).join(' OR ')}`;
        const s = await gh(`/search/issues?per_page=100&q=${encodeURIComponent(q)}`, { token });
        if (s.status !== 200) throw clientError(502, 'upstream', 'Could not check status right now');
        const found = {};
        for (const it of s.data?.items || []) {
          const rc = receiptFromBody(it.body);
          if (!rc || !batch.includes(rc)) continue;
          if (found[rc] && Date.parse(found[rc].updated_at) >= Date.parse(it.updated_at)) continue;
          found[rc] = it;
        }
        for (const rc of batch) {
          const it = found[rc];
          let value;
          if (!it) value = { status_key: 'not_found', line: STATUS_LINES.not_found, title: null, kind: null, updated: null, done_at: null };
          else {
            const st = statusFor(it);
            const km = String(it.body || '').match(/<!-- feedback-kind: (bug|feature) -->/);
            const names = (it.labels || []).map((l) => l.name);
            const kind = km ? km[1] : names.includes('feature') ? 'feature' : names.includes('bug') ? 'bug' : null;
            value = { ...st, title: String(it.title || ''), kind, updated: it.updated_at || null, done_at: st.status_key === 'done' || st.status_key === 'not_planned' ? it.closed_at || null : null };
          }
          if (value.status_key !== 'not_found') statusCache.set(rc, { at: now(), value });
          results[rc] = value;
        }
      }
      if (statusCache.size > 5000) statusCache.clear();
    }
    return json({ results });
  }

  return async function fetchHandler(request, env = {}) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response('WizardOS Feedback relay: ok\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
      }
      if (url.pathname === '/v1/report') {
        if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'Use POST');
        if (!allow('report', ip, 5, 10 * 60 * 1000, now())) return errorResponse(429, 'rate_limited', 'Too many reports, please wait a few minutes');
        return await handleReport(request, env);
      }
      if (url.pathname === '/v1/status') {
        if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'Use GET');
        if (!allow('status', ip, 60, 60 * 1000, now())) return errorResponse(429, 'rate_limited', 'Too many status checks, please slow down');
        return await handleStatus(url, env);
      }
      return errorResponse(404, 'not_found', 'Unknown path');
    } catch (e) {
      if (e && e.status) return errorResponse(e.status, e.code, e.message);
      return errorResponse(500, 'internal', 'Something went wrong');
    }
  };
}

const handler = createApp();
export default { fetch: (request, env, ctx) => handler(request, env, ctx) };
