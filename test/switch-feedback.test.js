// node --test: Try new features counts (POST /v1/switch-feedback, GET /v1/switch-counts) against a fake GitHub.
// wizard-app-manager#701: boxes send {box, switches: [{id, issues, tried, vote}]}; the Tracker reads the counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, validateSwitchFeedback, mergeSwitchFeedback, switchCounts, SWITCH_FEEDBACK_PATH } from '../worker.js';

const SCRATCH = process.env.FEEDBACK_TEST_TMP || tmpdir();
const dir = mkdtempSync(join(SCRATCH, 'feedback-relay-sf-'));
const pemPath = join(dir, 'k.pem');
execFileSync('openssl', ['genrsa', '-traditional', '-out', pemPath, '2048'], { stdio: 'ignore' });
const PEM = readFileSync(pemPath, 'utf8');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ORG = 'humanitylabs-org';
const ENV = { GH_APP_ID: '999', GH_APP_PRIVATE_KEY: PEM, GH_ORG: ORG };
const BOX_A = 'a'.repeat(32);
const BOX_B = 'b'.repeat(32);
const FILE = `/repos/${ORG}/wizard-issue-media/contents/${SWITCH_FEEDBACK_PATH}`;

function fakeGitHub({ conflictOnce = false } = {}) {
  const file = { content: null, sha: null, n: 0 };
  const calls = [];
  let conflicts = conflictOnce ? 1 : 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = init.headers?.Authorization || '';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
    const p = u.pathname;
    if (p === `/orgs/${ORG}/installation`) return res(200, { id: 77 });
    if (p === '/app/installations/77/access_tokens') return res(201, { token: 'inst-token', expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (p === '/user') return auth === 'Bearer t-rev' ? res(200, { login: 'rev' }) : auth === 'Bearer t-out' ? res(200, { login: 'stranger' }) : res(401, {});
    if (auth !== 'Bearer inst-token') return res(401, { message: 'bot calls must use the installation token' });
    if (p === `/orgs/${ORG}/members/rev`) return res(204);
    if (p.startsWith(`/orgs/${ORG}/members/`)) return res(404);
    if (p === FILE && method === 'GET') return file.content === null ? res(404, {}) : res(200, { content: file.content, sha: file.sha });
    if (p === FILE && method === 'PUT') {
      if (conflicts > 0) { // another box wrote first
        conflicts--; file.n++; file.sha = `sha${file.n}`;
        file.content = Buffer.from(JSON.stringify({ contract: 'wizard.switch-feedback/1', boxes: { [BOX_B]: { at: new Date().toISOString(), switches: [ROW] } } })).toString('base64');
        return res(409, {});
      }
      if ((body.sha || null) !== file.sha) return res(409, {});
      file.content = body.content; file.n++; file.sha = `sha${file.n}`;
      return res(file.n === 1 ? 201 : 200, { content: { sha: file.sha } });
    }
    return res(404, { message: `unexpected ${method} ${p}` });
  };
  const stored = () => (file.content === null ? null : JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')));
  return { fetchImpl, calls, stored, file };
}

const post = (app, body, ip = '1.2.3.4') => app(new Request('https://relay.test/v1/switch-feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), ENV);
const counts = (app, token) => app(new Request('https://relay.test/v1/switch-counts', { headers: token ? { authorization: `Bearer ${token}` } : {} }), ENV);
const fb = (box, switches) => ({ contract: 'wizard.switch-feedback/1', box, switches });
const ROW = { id: 'try-demo:compact-header', issues: ['humanitylabs-org/try-demo#20'], tried: true, vote: 'up' };

test('a thumbs up from one box is stored and shows up as an anonymous count', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const r = await post(app, fb(BOX_A, [ROW]));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, stored: true, switches: 1 });
  const s = gh.stored();
  assert.deepEqual(Object.keys(s.boxes), [BOX_A]);
  assert.deepEqual(s.boxes[BOX_A].switches, [ROW]);
  const c = await counts(app, 't-rev');
  assert.equal(c.status, 200);
  assert.deepEqual(await c.json(), { contract: 'wizard.switch-counts/1', boxes: 1, counts: { 'try-demo:compact-header': { tried: 1, up: 1, down: 0, issues: ['humanitylabs-org/try-demo#20'] } } });
});

test('a box sending again replaces its own row instead of counting twice; two boxes add up', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  await post(app, fb(BOX_A, [ROW]));
  await post(app, fb(BOX_A, [{ ...ROW, vote: 'down' }]));
  await post(app, fb(BOX_B, [{ ...ROW, vote: null }]));
  const c = await (await counts(app, 't-rev')).json();
  assert.equal(c.boxes, 2);
  assert.deepEqual(c.counts['try-demo:compact-header'], { tried: 2, up: 0, down: 1, issues: ['humanitylabs-org/try-demo#20'] });
});

test('the same rows again within a day are not written again', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  await post(app, fb(BOX_A, [ROW]));
  const r = await post(app, fb(BOX_A, [ROW]));
  assert.deepEqual(await r.json(), { ok: true, stored: false, switches: 1 });
  assert.equal(gh.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('only id, issues, tried and vote are kept; anything else a box sends is dropped', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  await post(app, { ...fb(BOX_A, [{ ...ROW, name: 'Compact header', owner: 'miguel' }]), hostname: 'box.tail.ts.net', version: '2026.11' });
  const text = Buffer.from(gh.file.content, 'base64').toString('utf8');
  for (const leak of ['Compact header', 'miguel', 'box.tail.ts.net', '2026.11']) assert.ok(!text.includes(leak), leak);
});

test('a write conflict is retried', async () => {
  const gh = fakeGitHub({ conflictOnce: true });
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const r = await post(app, fb(BOX_A, [ROW]));
  assert.equal(r.status, 200);
  assert.deepEqual(gh.stored().boxes[BOX_A].switches, [ROW]);
  assert.deepEqual(gh.stored().boxes[BOX_B].switches, [ROW], 'the other box survives the retry');
});

test('bad bodies are refused with 400 and nothing is written', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  const bad = [
    { ...fb(BOX_A, [ROW]), contract: 'nope' },
    fb('not-hex', [ROW]),
    fb(BOX_A, 'x'),
    fb(BOX_A, [{ ...ROW, vote: 'maybe' }]),
    fb(BOX_A, [{ ...ROW, tried: 'yes' }]),
    fb(BOX_A, [{ ...ROW, id: 'no colon' }]),
    fb(BOX_A, [{ ...ROW, issues: ['@someone'] }]),
    fb(BOX_A, Array.from({ length: 201 }, (_, i) => ({ ...ROW, id: `a:s${i}` }))),
  ];
  for (const [i, b] of bad.entries()) {
    const r = await post(app, b, `9.9.9.${i}`);
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
  }
  assert.equal(gh.calls.filter((c) => c.method === 'PUT').length, 0);
  const r = await app(new Request('https://relay.test/v1/switch-feedback', { method: 'GET' }), ENV);
  assert.equal(r.status, 405);
});

test('counts are for WizardOS team members only', async () => {
  const gh = fakeGitHub();
  const app = createApp({ fetchImpl: gh.fetchImpl });
  assert.equal((await counts(app, '')).status, 401);
  assert.equal((await counts(app, 't-bad')).status, 401);
  assert.equal((await counts(app, 't-out')).status, 403);
  const ok = await counts(app, 't-rev');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { contract: 'wizard.switch-counts/1', boxes: 0, counts: {} });
});

test('pure helpers: stale boxes drop out, an empty list removes the box, duplicates collapse', () => {
  const day = 24 * 3600e3;
  const t0 = Date.UTC(2026, 10, 1);
  let { store } = mergeSwitchFeedback(null, BOX_A, [ROW], t0);
  ({ store } = mergeSwitchFeedback(store, BOX_B, [ROW], t0 + 80 * day));
  assert.equal(switchCounts(store, t0 + 91 * day).boxes, 1);
  const r = mergeSwitchFeedback(store, BOX_B, [], t0 + 91 * day);
  assert.ok(r.changed);
  assert.deepEqual(Object.keys(r.store.boxes), []);
  assert.equal(mergeSwitchFeedback({ boxes: {} }, BOX_A, [], t0).changed, false);
  const v = validateSwitchFeedback(fb(BOX_A, [ROW, { ...ROW, vote: 'down' }, { id: 'a:b' }]));
  assert.deepEqual(v.switches, [{ id: 'a:b', issues: [], tried: false, vote: null }, ROW]);
});
