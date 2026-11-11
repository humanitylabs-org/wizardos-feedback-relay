import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

test('manifest.html embeds exactly github-app-manifest.json and posts to the org app page', () => {
  const m = JSON.parse(readFileSync(join(root, 'github-app-manifest.json'), 'utf8'));
  const html = readFileSync(join(root, 'manifest.html'), 'utf8');
  const embedded = JSON.parse(html.match(/<script id="manifest-json" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded, m);
  assert.equal(m.name, 'WizardOS Feedback');
  assert.equal(m.public, false);
  assert.deepEqual(m.default_permissions, { issues: 'write', contents: 'write', members: 'read', metadata: 'read' });
  assert.ok(html.includes("https://github.com/organizations/humanitylabs-org/settings/apps/new?state="));
});

test('worker.js is under 1 MiB', () => {
  assert.ok(statSync(join(root, 'worker.js')).size < 1024 * 1024);
});

test('deploy.py --dry-run sends nothing and never prints secrets', () => {
  const dir = mkdtempSync(join(process.env.FEEDBACK_TEST_TMP || '/home/oscar/.hermes/cache/scratch', 'relay-deploy-'));
  const pem = join(dir, 'k.pem');
  execFileSync('openssl', ['genrsa', '-traditional', '-out', pem, '2048'], { stdio: 'ignore' });
  const envf = join(dir, 'env');
  writeFileSync(envf, 'AIWIZARDS_CLOUDFLARE_API_TOKEN=SECRET-TOKEN-VALUE-123\nAIWIZARDS_CLOUDFLARE_ACCOUNT_ID=acct\n');
  const out = execFileSync('python3', [join(root, 'deploy.py'), '--app-id', '42', '--pem', pem, '--env-file', envf, '--trusted-logins', 'a, b', '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  rmSync(dir, { recursive: true, force: true });
  assert.match(out, /dry run/);
  assert.match(out, /"TRUSTED_LOGINS": "a,b"/);
  assert.ok(!out.includes('SECRET-TOKEN-VALUE-123'));
  assert.ok(!out.includes('PRIVATE KEY'));
});
