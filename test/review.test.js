// node --test: review endpoints (/v1/pending, /v1/review) against a fake GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, parseInboxBody, buildTwinBody, buildIssueBody, receiptFromBody, newReceipt, userTokenFrom } from '../worker.js';

const SCRATCH = process.env.FEEDBACK_TEST_TMP || '/home/oscar/.hermes/cache/scratch';
const dir = mkdtempSync(join(SCRATCH, 'feedback-relay-review-'));
const pemPath = join(dir, 'k.pem');
execFileSync('openssl', ['genrsa', '-traditional', '-out', pemPath, '2048'], { stdio: 'ignore' });
const PEM = readFileSync(pemPath, 'utf8');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ORG = 'humanitylabs-org';
const ENV = { GH_APP_ID: '999', GH_APP_PRIVATE_KEY: PEM, GH_ORG: ORG, INBOX_REPO: 'wizardos-feedback-inbox', TRIAGE_REPO: 'wizard-os', TRUSTED_LOGINS: 'jan' };

function fakeGitHub({ members = ['rev'], users = { 'Bearer t-rev': 'rev', 'Bearer t-out': 'stranger', 'Bearer t-jan': 'jan' }, failTwin = false } = {}) {
  const calls = [];
  const repos = { 'wizardos-feedback-inbox': [], 'wizard-os': [] };
  const comments = {};
  const labels = { 'wizardos-feedback-inbox': new Set(['needs-review', 'bug', 'feature']), 'wizard-os': new Set(['triage', 'bug', 'feature']) };
  let ts = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 11, 0, 0, ts++)).toISOString();
  const add = (repo, { title, body, labels: ls, state = 'open', state_reason = null }) => {
    const issue = { number: repos[repo].length + 1, title, body, labels: ls.map((name) => ({ name })), state, state_reason, created_at: stamp(), updated_at: stamp(), closed_at: null, repository_url: `https://api.github.com/repos/${ORG}/${repo}` };
    repos[repo].push(issue);
    return issue;
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = init.headers?.Authorization || '';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, auth, body, search: u.search });
    const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
    const p = u.pathname;
    if (p === `/orgs/${ORG}/installation`) return res(200, { id: 77 });
    if (p === '/app/installations/77/access_tokens') return res(201, { token: 'inst-token', expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (p === '/user') return users[auth] ? res(200, { login: users[auth] }) : res(401, { message: 'Bad credentials' });
    if (auth !== 'Bearer inst-token') return res(401, { message: 'bot calls must use the installation token' });
    let m;
    if ((m = p.match(new RegExp(`^/orgs/${ORG}/members/(.+)$`)))) return res(members.includes(m[1]) ? 204 : 404);
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/labels/([^/]+)$`))) && method === 'GET') return labels[m[1]]?.has(decodeURIComponent(m[2])) ? res(200, { name: m[2] }) : res(404, {});
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/labels$`))) && method === 'POST') { labels[m[1]].add(body.name); return res(201, body); }
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/issues$`)))) {
      if (method === 'POST') {
        if (failTwin && m[1] === 'wizard-os') return res(500, {});
        for (const l of body.labels) labels[m[1]].add(l);
        const it = add(m[1], body);
        return res(201, { number: it.number });
      }
      const want = u.searchParams.get('labels');
      const st = u.searchParams.get('state');
      return res(200, repos[m[1]].filter((i) => (st === 'all' || i.state === st) && (!want || i.labels.some((l) => l.name === want))));
    }
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/issues/(\\d+)$`)))) {
      const it = repos[m[1]]?.[Number(m[2]) - 1];
      if (!it) return res(404, {});
      if (method === 'PATCH') { Object.assign(it, body); it.updated_at = stamp(); if (body.state === 'closed') it.closed_at = it.updated_at; }
      return res(200, it);
    }
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/issues/(\\d+)/comments$`)))) {
      const k = `${m[1]}#${m[2]}`;
      comments[k] ||= [];
      if (method === 'POST') { comments[k].push({ body: body.body }); return res(201, {}); }
      return res(200, comments[k]);
    }
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/issues/(\\d+)/labels$`))) && method === 'POST') {
      const it = repos[m[1]][Number(m[2]) - 1];
      for (const l of body.labels) if (!it.labels.some((x) => x.name === l)) it.labels.push({ name: l });
      return res(200, it.labels);
    }
    if ((m = p.match(new RegExp(`^/repos/${ORG}/([^/]+)/issues/(\\d+)/labels/([^/]+)$`))) && method === 'DELETE') {
      const it = repos[m[1]][Number(m[2]) - 1];
      it.labels = it.labels.filter((x) => x.name !== decodeURIComponent(m[3]));
      return res(200, it.labels);
    }
    if (p === '/search/issues') {
      const q = u.searchParams.get('q');
      const rm = q.match(/repo:[^/]+\/(\S+)/);
      const all = rm ? repos[rm[1]] || [] : [...repos['wizardos-feedback-inbox'], ...repos['wizard-os']];
      const items = all.filter((i) => { const r = receiptFromBody(i.body); return r && q.includes(r); });
      return res(200, { total_count: items.length, items });
    }
    return res(404, { message: 'Not Found' });
  };
  return { fetchImpl, calls, repos, comments, labels, add };
}

function seedInbox(gh, { kind = 'bug', text = 'The Mail app is blank. Please fix @jdefleur #12', login = '', shots = [] } = {}) {
  const receipt = newReceipt();
  const body = buildIssueBody({ report: { kind, text, wizard_version: '0.3.174', device: 'Mac · Chrome' }, receipt, trusted: false, login, shots });
  const it = gh.add('wizardos-feedback-inbox', { title: text.split('.')[0] + '.', body, labels: ['needs-review', kind] });
  return { it, receipt };
}

const call = (app, path, { method = 'GET', token, body, ip = '9.9.9.9' } = {}) => {
  const headers = { 'cf-connecting-ip': ip, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return app(new Request(`https://relay.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ENV);
};
const review = (app, token, issue, action, ip) => call(app, '/v1/review', { method: 'POST', token, body: { issue, action }, ip });

test('parseInboxBody and buildTwinBody round-trip', () => {
  const rc = newReceipt();
  const body = buildIssueBody({ report: { kind: 'feature', text: 'Add a dark mode\nsecond line', wizard_version: '1.0', device: 'Pixel' }, receipt: rc, trusted: false, login: 'stranger', shots: ['https://github.com/o/m/blob/main/a.png?raw=true'], failedShots: 1 });
  const p = parseInboxBody(body);
  assert.equal(p.text, 'Add a dark mode\nsecond line');
  assert.deepEqual(p.screenshots, ['https://github.com/o/m/blob/main/a.png?raw=true']);
  assert.equal(p.submitter, '@stranger');
  assert.equal(p.kind, 'feature');
  assert.equal(p.meta, 'Wizard version: 1.0 · Device: Pixel');
  const twin = buildTwinBody({ parsed: p, receipt: rc, kind: 'feature', reviewer: 'rev', inboxNumber: 4 });
  assert.equal(twin.split('\n')[0], '**From Feedback app** · sent by @stranger · approved by @rev');
  assert.equal(receiptFromBody(twin), rc);
  assert.match(twin, /!\[Screenshot 1\]\(https:\/\/github\.com\/o\/m\/blob\/main\/a\.png\?raw=true\)/);
  assert.match(twin, /1 screenshot could not be attached/);
  assert.equal(parseInboxBody(buildIssueBody({ report: { kind: 'bug', text: 'plain text here' }, receipt: rc, trusted: false, login: '' })).submitter, 'anonymous');
});

test('userTokenFrom prefers the Authorization header', () => {
  const r = (h) => new Request('https://x/', { headers: h });
  assert.equal(userTokenFrom(r({ authorization: 'Bearer abc' }), 'q'), 'abc');
  assert.equal(userTokenFrom(r({ authorization: 'token abc' })), 'abc');
  assert.equal(userTokenFrom(r({}), 'qtok'), 'qtok');
  assert.equal(userTokenFrom(r({}), ''), '');
  assert.equal(userTokenFrom(r({}), 'a b'), '');
});

test('pending: 401 without token, 403 for non-members, list for members', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const shot = 'https://github.com/humanitylabs-org/wizard-issue-media/blob/main/feedback/2026/x-1.png?raw=true';
  const a = seedInbox(gh, { shots: [shot] });
  const b = seedInbox(gh, { kind: 'feature', text: 'Please add a dark mode toggle', login: 'stranger' });
  gh.add('wizardos-feedback-inbox', { title: 'done one', body: 'x', labels: ['bug'], state: 'closed' });
  assert.equal((await call(app, '/v1/pending')).status, 401);
  assert.equal((await (await call(app, '/v1/pending')).json()).error, 'unauthorized');
  assert.equal((await call(app, '/v1/pending', { token: 't-bad' })).status, 401);
  assert.equal((await call(app, '/v1/pending', { token: 't-out' })).status, 403);
  assert.equal((await call(app, '/v1/pending', { token: 't-jan' })).status, 403, 'TRUSTED_LOGINS is not enough: must be an org member');
  const r = await call(app, '/v1/pending', { token: 't-rev' });
  assert.equal(r.status, 200);
  const { items } = await r.json();
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { number: a.it.number, kind: 'bug', title: a.it.title, text: 'The Mail app is blank. Please fix @jdefleur #12', submitter: 'anonymous', created: a.it.created_at, screenshots: [shot] });
  assert.equal(items[1].submitter, '@stranger');
  assert.equal(items[1].kind, 'feature');
  assert.ok(!JSON.stringify(items).includes('feedback-receipt'), 'no receipt leaks into pending text');
  // query-string token also works
  assert.equal((await call(app, '/v1/pending?gh_token=t-rev')).status, 200);
  // user token is only sent to /user
  assert.ok(gh.calls.filter((c) => c.auth === 'Bearer t-rev').every((c) => c.path === '/user'));
});

test('approve creates a wizard-os twin, closes the inbox item, and is idempotent', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const shot = 'https://github.com/humanitylabs-org/wizard-issue-media/blob/main/feedback/2026/y-1.png?raw=true';
  const { it, receipt } = seedInbox(gh, { login: 'stranger', shots: [shot] });
  assert.equal((await review(app, undefined, it.number, 'approve')).status, 401);
  assert.equal((await review(app, 't-out', it.number, 'approve')).status, 403);
  assert.equal(gh.repos['wizard-os'].length, 0);
  assert.equal((await review(app, 't-rev', it.number, 'maybe')).status, 400);
  assert.equal((await review(app, 't-rev', 999, 'approve')).status, 404);

  const r = await review(app, 't-rev', it.number, 'approve');
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.result, 'approved');
  assert.equal(out.already, false);
  assert.deepEqual(out.twin, { repo: 'wizard-os', number: 1, url: `https://github.com/${ORG}/wizard-os/issues/1` });
  const twin = gh.repos['wizard-os'][0];
  assert.equal(twin.title, it.title);
  assert.deepEqual(twin.labels.map((l) => l.name), ['triage', 'bug', 'from-feedback']);
  assert.ok(gh.labels['wizard-os'].has('from-feedback'));
  const created = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/wizard-os/labels'));
  assert.deepEqual(created.body, { name: 'from-feedback', color: '8e44ad', description: 'Sent from the Feedback app' });
  assert.equal(twin.body.split('\n')[0], '**From Feedback app** · sent by @stranger · approved by @rev');
  assert.equal(receiptFromBody(twin.body), receipt);
  assert.ok(twin.body.includes(shot));
  assert.ok(twin.body.includes('@\u200bjdefleur'), 'untrusted mentions stay neutralised');
  assert.equal(it.state, 'closed');
  assert.equal(it.state_reason, 'completed');
  assert.deepEqual(it.labels.map((l) => l.name).sort(), ['approved', 'bug']);
  assert.match(gh.comments[`wizardos-feedback-inbox#${it.number}`][0].body, /humanitylabs-org\/wizard-os#1/);

  // pending no longer lists it
  assert.equal((await (await call(app, '/v1/pending', { token: 't-rev' })).json()).items.length, 0);

  // idempotent: approve again or reject after approve -> same result, no new twin
  for (const action of ['approve', 'reject']) {
    const again = await (await review(app, 't-rev', it.number, action)).json();
    assert.equal(again.result, 'approved');
    assert.equal(again.already, true);
    assert.equal(again.twin.number, 1);
  }
  assert.equal(gh.repos['wizard-os'].length, 1);
});

test('approve resumes after a partial failure without a duplicate twin', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const { it, receipt } = seedInbox(gh);
  // twin exists (created earlier) but inbox wasn't closed
  gh.add('wizard-os', { title: it.title, body: `x\n<!-- feedback-receipt: ${receipt} -->`, labels: ['triage', 'bug', 'from-feedback'] });
  const out = await (await review(app, 't-rev', it.number, 'approve')).json();
  assert.equal(out.twin.number, 1);
  assert.equal(gh.repos['wizard-os'].length, 1);
  assert.equal(it.state, 'closed');
});

test('approve fails cleanly when the twin cannot be created', async () => {
  const gh = fakeGitHub({ failTwin: true });
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const { it } = seedInbox(gh);
  const r = await review(app, 't-rev', it.number, 'approve');
  assert.equal(r.status, 502);
  assert.equal(it.state, 'open');
  assert.ok(it.labels.some((l) => l.name === 'needs-review'));
});

test('reject closes as not planned and is idempotent', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const { it } = seedInbox(gh);
  const out = await (await review(app, 't-rev', it.number, 'reject')).json();
  assert.deepEqual(out, { ok: true, already: false, result: 'rejected', issue: it.number });
  assert.equal(it.state, 'closed');
  assert.equal(it.state_reason, 'not_planned');
  assert.deepEqual(it.labels.map((l) => l.name).sort(), ['bug', 'rejected']);
  assert.equal(gh.repos['wizard-os'].length, 0);
  const again = await (await review(app, 't-rev', it.number, 'approve')).json();
  assert.equal(again.result, 'rejected');
  assert.equal(again.already, true);
  assert.equal(gh.repos['wizard-os'].length, 0);
});

test('status prefers the wizard-os twin; approved inbox without a twin reads as received', async () => {
  const gh = fakeGitHub();
  const st = async (rc) => (await (await createApp({ fetchImpl: gh.fetchImpl })(new Request(`https://relay.test/v1/status?receipt=${rc}`), ENV)).json()).results[rc];
  const { it, receipt } = seedInbox(gh);
  assert.equal((await st(receipt)).status_key, 'waiting_review');
  // approved + closed, twin not searchable yet
  it.state = 'closed'; it.state_reason = 'completed'; it.labels = [{ name: 'approved' }, { name: 'bug' }];
  assert.equal((await st(receipt)).status_key, 'received');
  // twin appears with an older updated_at than the inbox: still wins
  const twin = gh.add('wizard-os', { title: it.title, body: `t\n<!-- feedback-receipt: ${receipt} -->\n<!-- feedback-kind: bug -->`, labels: ['building', 'bug', 'from-feedback'] });
  twin.updated_at = '2000-01-01T00:00:00Z';
  const s = await st(receipt);
  assert.equal(s.status_key, 'building');
  assert.equal(s.kind, 'bug');
  // rejected inbox item stays not_planned
  const r2 = seedInbox(gh);
  r2.it.state = 'closed'; r2.it.state_reason = 'not_planned'; r2.it.labels = [{ name: 'rejected' }];
  assert.equal((await st(r2.receipt)).status_key, 'not_planned');
});

test('review HTTP surface: methods, CORS header allows Authorization, bad JSON', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  assert.equal((await call(app, '/v1/review')).status, 405);
  assert.equal((await call(app, '/v1/pending', { method: 'POST', body: {} })).status, 405);
  const o = await app(new Request('https://relay.test/v1/review', { method: 'OPTIONS' }), ENV);
  assert.match(o.headers.get('access-control-allow-headers'), /Authorization/);
  const bj = await app(new Request('https://relay.test/v1/review', { method: 'POST', headers: { authorization: 'Bearer t-rev' }, body: '{nope' }), ENV);
  assert.equal(bj.status, 400);
  const bodyTok = await app(new Request('https://relay.test/v1/review', { method: 'POST', body: JSON.stringify({ gh_token: 't-out', issue: 1, action: 'approve' }) }), ENV);
  assert.equal(bodyTok.status, 403, 'gh_token in the body is accepted as a fallback');
});
