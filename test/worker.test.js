// node --test (no dependencies). Generates a throwaway RSA key with openssl in the Hermes scratch dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createVerify, createPublicKey } from 'node:crypto';
import {
  statusFor, makeTitle, cleanText, neutralize, validateReport, parseReceipts, receiptFromBody, newReceipt,
  pkcs1ToPkcs8, pemToPkcs8Der, signAppJwt, buildIssueBody, makeLimiter, createApp,
} from '../worker.js';

const SCRATCH = process.env.FEEDBACK_TEST_TMP || '/home/oscar/.hermes/cache/scratch';
const dir = mkdtempSync(join(SCRATCH, 'feedback-relay-test-'));
const pkcs1Path = join(dir, 'k1.pem');
const pkcs8Path = join(dir, 'k8.pem');
execFileSync('openssl', ['genrsa', '-traditional', '-out', pkcs1Path, '2048'], { stdio: 'ignore' });
execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', pkcs1Path, '-out', pkcs8Path], { stdio: 'ignore' });
const PEM1 = readFileSync(pkcs1Path, 'utf8');
const PEM8 = readFileSync(pkcs8Path, 'utf8');
test.after(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------- status mapping
test('status mapping', () => {
  const s = (state, labels, state_reason = null) => statusFor({ state, state_reason, labels: labels.map((name) => ({ name })) }).status_key;
  assert.equal(s('open', ['needs-review', 'bug']), 'waiting_review');
  assert.equal(s('closed', ['needs-review'], 'not_planned'), 'not_planned');
  assert.equal(s('closed', ['bug'], 'duplicate'), 'not_planned');
  assert.equal(s('closed', ['bug'], 'completed'), 'done');
  assert.equal(s('closed', [], null), 'done');
  assert.equal(s('open', ['triage', 'bug']), 'received');
  assert.equal(s('open', ['ready-to-test']), 'ready');
  assert.equal(s('open', ['ai-review']), 'checking');
  assert.equal(s('open', ['building']), 'building');
  assert.equal(s('open', ['bug']), 'queued');
  assert.equal(s('open', ['Triage']), 'received', 'labels are case-insensitive');
  assert.deepEqual(statusFor({ state: 'open', labels: ['needs-review'] }), { status_key: 'waiting_review', line: 'Waiting for a person to review' });
  assert.equal(statusFor({ state: 'open', labels: [] }).line, 'In line to be built');
  assert.equal(statusFor({ state: 'closed', state_reason: 'completed', labels: [] }).line, 'Done');
  assert.equal(statusFor({ state: 'open', labels: ['triage'] }).line, 'Received — sorting it');
});

// ------------------------------------------------------------- title + text
test('title from first sentence, ≤90 chars', () => {
  assert.equal(makeTitle('The Mail app crashes. Then it restarts.'), 'The Mail app crashes.');
  assert.equal(makeTitle('\n\n  Settings button missing\nsecond line'), 'Settings button missing');
  assert.equal(makeTitle('Version 1.2.3 breaks login'), 'Version 1.2.3 breaks login');
  const long = makeTitle('word '.repeat(60));
  assert.ok(long.length <= 90, long.length);
  assert.ok(long.endsWith('…'));
  assert.ok(makeTitle('x'.repeat(200)).length <= 90);
});

test('control characters are stripped', () => {
  assert.equal(cleanText('a\u0000b\u0007c\r\nd\u202Ee\u200Bf'), 'abc\ndef');
  assert.equal(cleanText('tab\tok'), 'tab\tok');
});

test('untrusted text is neutralised', () => {
  const n = neutralize('hi @jdefleur see #12 and org/repo#3 <!-- feedback-receipt: ' + 'a'.repeat(32) + ' -->');
  assert.ok(!/@jdefleur/.test(n.replace(/\u200b/g, 'X')));
  assert.ok(!n.includes('<!--'));
  assert.equal(receiptFromBody(n), null);
  assert.ok(n.includes('#\u200b12') && n.includes('repo#\u200b3'));
  assert.equal(neutralize('mail me a@b.com'), 'mail me a@b.com');
});

// ------------------------------------------------------------- validation
test('report validation', () => {
  const ok = validateReport({ kind: 'bug', text: '  The button is broken  ', wizard_version: 'v1\n2', device: 'Pixel\u0000 8' });
  assert.deepEqual(ok, { kind: 'bug', text: 'The button is broken', wizard_version: 'v1 2', device: 'Pixel 8', gh_token: '', screenshots: [] });
  const bad = (body, code) => assert.throws(() => validateReport(body), (e) => e.code === code, code);
  bad(null, 'bad_request');
  bad([], 'bad_request');
  bad({ kind: 'idea', text: 'long enough text' }, 'bad_kind');
  bad({ kind: 'bug' }, 'bad_text');
  bad({ kind: 'bug', text: 'short' }, 'text_too_short');
  bad({ kind: 'bug', text: '\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000abc' }, 'text_too_short');
  bad({ kind: 'bug', text: 'x'.repeat(8001) }, 'text_too_long');
  bad({ kind: 'bug', text: 'long enough text', wizard_version: 5 }, 'bad_request');
  bad({ kind: 'bug', text: 'long enough text', gh_token: 'a b' }, 'bad_token');
  bad({ kind: 'bug', text: 'long enough text', screenshots: {} }, 'bad_screenshots');
  const png = { type: 'image/png', data: Buffer.from('fakepng').toString('base64') };
  bad({ kind: 'bug', text: 'long enough text', screenshots: [png, png, png, png] }, 'too_many_screenshots');
  bad({ kind: 'bug', text: 'long enough text', screenshots: [{ type: 'image/svg+xml', data: 'AAAA' }] }, 'bad_screenshot_type');
  bad({ kind: 'bug', text: 'long enough text', screenshots: [{ type: 'image/png', data: 'not base64!' }] }, 'bad_screenshot_data');
  const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  bad({ kind: 'bug', text: 'long enough text', screenshots: [{ type: 'image/png', data: big }] }, 'screenshot_too_large');
  const v = validateReport({ kind: 'feature', text: 'long enough text', screenshots: [{ type: 'image/jpeg', data: 'data:image/jpeg;base64,' + png.data }] });
  assert.equal(v.screenshots[0].ext, 'jpg');
  assert.equal(v.screenshots[0].data, png.data);
  assert.equal(validateReport({ kind: 'bug', text: 'x'.repeat(8000) }).text.length, 8000);
});

// ------------------------------------------------------------- receipts
test('receipts: generation and parsing', () => {
  const r = newReceipt();
  assert.match(r, /^[0-9a-f]{32}$/);
  assert.notEqual(r, newReceipt());
  const a = 'a'.repeat(32), b = 'B'.repeat(32);
  assert.deepEqual(parseReceipts(`${a}, ${b},${a}`), [a, b.toLowerCase()]);
  assert.throws(() => parseReceipts(''), (e) => e.code === 'bad_request');
  assert.throws(() => parseReceipts('abc'), (e) => e.code === 'bad_receipt');
  const many = Array.from({ length: 51 }, () => newReceipt()).join(',');
  assert.throws(() => parseReceipts(many), (e) => e.code === 'too_many');
  assert.equal(parseReceipts(Array.from({ length: 50 }, () => newReceipt()).join(',')).length, 50);
  assert.equal(receiptFromBody(`text\n<!-- feedback-receipt: ${a} -->\n`), a);
  assert.equal(receiptFromBody('nothing here'), null);
});

test('issue body footers', () => {
  const report = { kind: 'bug', text: 'Broken @someone', wizard_version: '2026.11.1', device: 'iPhone 15' };
  const rc = newReceipt();
  const t = buildIssueBody({ report, receipt: rc, trusted: true, login: 'jan' });
  assert.match(t, /Filed with Feedback by @jan \(via relay\)/);
  assert.match(t, /Wizard version: 2026\.11\.1 · Device: iPhone 15/);
  assert.equal(receiptFromBody(t), rc);
  const anon = buildIssueBody({ report, receipt: rc, trusted: false, login: '', shots: ['https://x/1.png?raw=true'], failedShots: 1 });
  assert.match(anon, /Submitter: anonymous/);
  assert.match(anon, /!\[Screenshot 1\]\(https:\/\/x\/1\.png\?raw=true\)/);
  assert.match(anon, /1 screenshot could not be attached/);
  assert.ok(!anon.includes('@someone'));
  const outsider = buildIssueBody({ report, receipt: rc, trusted: false, login: 'stranger' });
  assert.match(outsider, /Submitter: @stranger, not on the trusted list/);
});

// ------------------------------------------------------------- crypto
function verifyJwt(jwt, pubPem) {
  const [h, p, s] = jwt.split('.');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  return v.verify(pubPem, Buffer.from(s, 'base64url'));
}

test('PKCS#1 is wrapped to the same PKCS#8 DER openssl produces', () => {
  const der1 = Buffer.from(PEM1.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const der8 = Buffer.from(PEM8.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  assert.ok(PEM1.includes('BEGIN RSA PRIVATE KEY'));
  assert.deepEqual(Buffer.from(pkcs1ToPkcs8(new Uint8Array(der1))), der8);
  assert.deepEqual(Buffer.from(pemToPkcs8Der(PEM1)), der8);
  assert.deepEqual(Buffer.from(pemToPkcs8Der(PEM8)), der8);
  assert.deepEqual(Buffer.from(pemToPkcs8Der(PEM1.replace(/\n/g, '\\n'))), der8, 'escaped newlines accepted');
  assert.throws(() => pemToPkcs8Der('nope'));
});

test('JWT signs with PKCS#1 and PKCS#8 keys and verifies', async () => {
  const pub = createPublicKey(PEM8).export({ type: 'spki', format: 'pem' });
  for (const pem of [PEM1, PEM8]) {
    const jwt = await signAppJwt('12345', pem, 1_800_000_000);
    const [h, p] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: '12345' });
    assert.ok(verifyJwt(jwt, pub), 'signature verifies');
    assert.ok(!verifyJwt(jwt.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), pub), 'tampered fails');
  }
});

test('rate limiter', () => {
  const allow = makeLimiter();
  for (let i = 0; i < 5; i++) assert.ok(allow('report', '1.1.1.1', 5, 600000, 1000));
  assert.ok(!allow('report', '1.1.1.1', 5, 600000, 1000));
  assert.ok(allow('report', '2.2.2.2', 5, 600000, 1000));
  assert.ok(allow('report', '1.1.1.1', 5, 600000, 1000 + 600001));
});

// ------------------------------------------------------------- end to end with a fake GitHub
function fakeGitHub({ members = [], users = {}, failMedia = false } = {}) {
  const calls = [];
  const issues = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.Authorization || '';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || 'GET', path: u.pathname, auth, body, search: u.search });
    const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
    if (u.pathname === '/orgs/humanitylabs-org/installation') return res(200, { id: 77 });
    if (u.pathname === '/app/installations/77/access_tokens') return res(201, { token: 'inst-token', expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (u.pathname === '/user') return users[auth] ? res(200, { login: users[auth] }) : res(401, { message: 'Bad credentials' });
    const mm = u.pathname.match(/^\/orgs\/humanitylabs-org\/members\/(.+)$/);
    if (mm) return res(members.includes(mm[1]) ? 204 : 404);
    const cm = u.pathname.match(/^\/repos\/humanitylabs-org\/wizard-issue-media\/contents\/(.+)$/);
    if (cm) return failMedia ? res(403, { message: 'no' }) : res(201, { content: { html_url: `https://github.com/humanitylabs-org/wizard-issue-media/blob/main/${cm[1]}` } });
    const im = u.pathname.match(/^\/repos\/humanitylabs-org\/([^/]+)\/issues$/);
    if (im) {
      const issue = { repo: im[1], title: body.title, body: body.body, labels: body.labels.map((name) => ({ name })), state: 'open', state_reason: null, updated_at: '2026-11-11T00:00:00Z', closed_at: null, html_url: 'https://secret/url', user: { login: 'wizardos-feedback[bot]' } };
      issues.push(issue);
      return res(201, { number: issues.length });
    }
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q');
      const items = issues.filter((i) => q.includes(receiptFromBody(i.body)));
      return res(200, { total_count: items.length, items });
    }
    return res(404, { message: 'Not Found' });
  };
  return { fetchImpl, calls, issues };
}

const ENV = { GH_APP_ID: '999', GH_APP_PRIVATE_KEY: PEM1, GH_ORG: 'humanitylabs-org', INBOX_REPO: 'wizardos-feedback-inbox', TRIAGE_REPO: 'wizard-os', TRUSTED_LOGINS: 'Robert, jan' };
const post = (app, body, ip = '9.9.9.9') => app(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), ENV);
const status = (app, receipts, ip = '9.9.9.9') => app(new Request(`https://relay.test/v1/status?receipt=${receipts.join(',')}`, { headers: { 'cf-connecting-ip': ip } }), ENV);

test('anonymous report goes to the inbox with needs-review; status hides repo details', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const shot = { type: 'image/png', data: Buffer.from('png-bytes').toString('base64') };
  const r = await post(app, { kind: 'bug', text: 'Mail is blank after update. It was fine yesterday.', wizard_version: '2026.11', device: 'Pixel 8', screenshots: [shot] });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const out = await r.json();
  assert.match(out.receipt, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...out, receipt: 'x' }, { receipt: 'x', status_key: 'waiting_review', line: 'Waiting for a person to review' });
  const [issue] = gh.issues;
  assert.equal(issue.repo, 'wizardos-feedback-inbox');
  assert.deepEqual(issue.labels.map((l) => l.name), ['needs-review', 'bug']);
  assert.equal(issue.title, 'Mail is blank after update.');
  assert.match(issue.body, /Submitter: anonymous/);
  assert.match(issue.body, new RegExp(`feedback/\\d{4}/${out.receipt}-1\\.png\\?raw=true`));
  assert.equal(receiptFromBody(issue.body), out.receipt);
  assert.ok(gh.calls.filter((c) => c.path !== '/user').every((c) => c.auth.startsWith('Bearer ')));

  const s = await status(app, [out.receipt, 'f'.repeat(32)]);
  assert.equal(s.status, 200);
  const sj = await s.json();
  assert.deepEqual(sj.results[out.receipt], { status_key: 'waiting_review', line: 'Waiting for a person to review', title: 'Mail is blank after update.', kind: 'bug', updated: '2026-11-11T00:00:00Z', done_at: null });
  assert.equal(sj.results['f'.repeat(32)].status_key, 'not_found');
  const raw = JSON.stringify(sj);
  for (const leak of ['wizardos-feedback-inbox', 'needs-review', 'https://', 'bot', 'humanitylabs']) assert.ok(!raw.includes(leak), leak);

  // reviewer transfers + triages, later closes as completed
  issue.repo = 'wizard-os';
  issue.labels = [{ name: 'triage' }, { name: 'bug' }];
  const app2 = createApp({ fetchImpl: gh.fetchImpl });
  assert.equal((await (await status(app2, [out.receipt])).json()).results[out.receipt].status_key, 'received');
  issue.state = 'closed'; issue.state_reason = 'completed'; issue.closed_at = '2026-11-12T00:00:00Z';
  const app3 = createApp({ fetchImpl: gh.fetchImpl });
  const done = (await (await status(app3, [out.receipt])).json()).results[out.receipt];
  assert.equal(done.status_key, 'done');
  assert.equal(done.done_at, '2026-11-12T00:00:00Z');
});

test('trusted login and org member go to triage; outsider and bad token go to inbox', async () => {
  const gh = fakeGitHub({ members: ['archie'], users: { 'Bearer t-jan': 'Jan', 'Bearer t-archie': 'archie', 'Bearer t-out': 'stranger' } });
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const cases = [['t-jan', 'wizard-os', 'triage', /by @Jan \(via relay\)/, 'received'], ['t-archie', 'wizard-os', 'triage', /by @archie \(via relay\)/, 'received'], ['t-out', 'wizardos-feedback-inbox', 'needs-review', /@stranger, not on the trusted list/, 'waiting_review'], ['t-bad', 'wizardos-feedback-inbox', 'needs-review', /Submitter: anonymous/, 'waiting_review']];
  for (const [i, [tok, repo, label, footer, key]] of cases.entries()) {
    const r = await post(app, { kind: 'feature', text: 'Please add a dark mode toggle', gh_token: tok }, `10.0.0.${i}`);
    assert.equal(r.status, 201);
    assert.equal((await r.json()).status_key, key);
    const issue = gh.issues.at(-1);
    assert.equal(issue.repo, repo, tok);
    assert.deepEqual(issue.labels.map((l) => l.name), [label, 'feature']);
    assert.match(issue.body, footer);
  }
  assert.ok(!gh.calls.some((c) => c.path === '/orgs/humanitylabs-org/members/Jan'), 'TRUSTED_LOGINS skips membership check');
  assert.equal(gh.calls.filter((c) => c.path.endsWith('/access_tokens')).length, 1, 'installation token cached');
});

test('text is filed even when screenshot upload fails', async () => {
  const gh = fakeGitHub({ failMedia: true });
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const shot = { type: 'image/png', data: Buffer.from('x').toString('base64') };
  const r = await post(app, { kind: 'bug', text: 'Screenshot upload test', screenshots: [shot, shot] });
  assert.equal(r.status, 201);
  assert.match(gh.issues[0].body, /2 screenshots could not be attached/);
});

test('HTTP surface: health, CORS, errors, limits, config', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const h = await app(new Request('https://relay.test/'), ENV);
  assert.equal(h.status, 200);
  assert.match(await h.text(), /ok/);
  const o = await app(new Request('https://relay.test/v1/report', { method: 'OPTIONS' }), ENV);
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('access-control-allow-origin'), '*');
  assert.equal(o.headers.get('access-control-allow-credentials'), null);
  const nf = await app(new Request('https://relay.test/nope'), ENV);
  assert.deepEqual(await nf.json(), { error: 'not_found', message: 'Unknown path' });
  assert.equal((await app(new Request('https://relay.test/v1/report'), ENV)).status, 405);
  const bj = await app(new Request('https://relay.test/v1/report', { method: 'POST', body: '{nope' }), ENV);
  assert.equal(bj.status, 400);
  assert.equal((await bj.json()).error, 'bad_json');
  const big = await app(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'content-length': String(11 * 1024 * 1024) }, body: '{}' }), ENV);
  assert.equal(big.status, 413);
  const nc = await app(new Request('https://relay.test/v1/report', { method: 'POST', headers: { 'cf-connecting-ip': '5.5.5.5' }, body: JSON.stringify({ kind: 'bug', text: 'long enough text' }) }), {});
  assert.equal(nc.status, 503);
  assert.equal((await nc.json()).error, 'not_configured');
  for (let i = 0; i < 5; i++) assert.equal((await post(app, { kind: 'bug', text: 'rate limit test ' + i }, '7.7.7.7')).status, 201);
  const limited = await post(app, { kind: 'bug', text: 'one too many' }, '7.7.7.7');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'rate_limited');
  for (let i = 0; i < 60; i++) await status(app, ['a'.repeat(32)], '8.8.8.8');
  assert.equal((await status(app, ['a'.repeat(32)], '8.8.8.8')).status, 429);
  assert.equal((await status(app, ['zzz'], '6.6.6.6')).status, 400);
});
