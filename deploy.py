#!/usr/bin/env python3
"""Deploy the WizardOS Feedback relay to Cloudflare Workers (stdlib only).

Steps (Cloudflare API, account token AIWIZARDS_CLOUDFLARE_API_TOKEN from ~/.hermes/.env):
  1. PUT  /accounts/{A}/workers/scripts/{name}            multipart: metadata + worker.js
         metadata = {main_module, compatibility_date, bindings: plain_text vars,
                     keep_bindings: ["secret_text"]}
  2. PUT  /accounts/{A}/workers/scripts/{name}/secrets    GH_APP_ID, GH_APP_PRIVATE_KEY
  3. POST /accounts/{A}/workers/scripts/{name}/subdomain  {enabled: true}
  4. GET  https://{name}.{account-subdomain}.workers.dev/  health line

Usage:
  python3 deploy.py --app-id 123456 --pem ~/path/wizardos-feedback.private-key.pem \
      [--trusted-logins jdefleur,oscarhenrycollins] [--name wizardos-feedback-relay] [--dry-run]

Never prints the API token, the private key or any secret value.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://api.cloudflare.com/client/v4'
COMPAT_DATE = '2026-11-01'
MAX_SCRIPT = 1024 * 1024


def load_env(path):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                env[k.strip().removeprefix('export ').strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env


class Redactor:
    def __init__(self, *secrets):
        self.secrets = [s for s in secrets if s and len(s) >= 6]

    def __call__(self, text):
        text = str(text)
        for s in self.secrets:
            text = text.replace(s, '[redacted]')
        return re.sub(r'-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----', '[redacted key]', text)


def multipart(parts):
    boundary = '----feedback-relay-' + uuid.uuid4().hex
    out = b''
    for name, filename, ctype, data in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else '')
        out += f'--{boundary}\r\nContent-Disposition: {disp}\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + b'\r\n'
    out += f'--{boundary}--\r\n'.encode()
    return out, f'multipart/form-data; boundary={boundary}'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--app-id', required=True, help='GitHub App ID (numeric)')
    ap.add_argument('--pem', required=True, help='path to the GitHub App private key PEM (PKCS#1 or PKCS#8)')
    ap.add_argument('--trusted-logins', default='', help='comma list of GitHub logins filed straight to triage')
    ap.add_argument('--name', default='wizardos-feedback-relay', help='Worker script name')
    ap.add_argument('--org', default='humanitylabs-org')
    ap.add_argument('--inbox-repo', default='wizardos-feedback-inbox')
    ap.add_argument('--triage-repo', default='wizard-os')
    ap.add_argument('--env-file', default=os.path.expanduser('~/.hermes/.env'))
    ap.add_argument('--dry-run', action='store_true', help='build and check everything, send nothing')
    a = ap.parse_args()

    if not re.fullmatch(r'\d{1,12}', a.app_id):
        sys.exit('--app-id must be the numeric GitHub App ID')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', a.name):
        sys.exit('--name must be lowercase letters, digits and dashes')
    if a.triage_repo == a.inbox_repo:
        sys.exit('inbox and triage repos must differ')
    with open(os.path.expanduser(a.pem)) as f:
        pem = f.read().strip()
    if not re.search(r'-----BEGIN (RSA )?PRIVATE KEY-----', pem):
        sys.exit('--pem is not an RSA private key PEM (expected BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)')
    with open(os.path.join(HERE, 'worker.js'), 'rb') as f:
        script = f.read()
    if len(script) > MAX_SCRIPT:
        sys.exit(f'worker.js is {len(script)} bytes, over the 1 MiB limit')

    env = load_env(a.env_file)
    token = os.environ.get('AIWIZARDS_CLOUDFLARE_API_TOKEN') or env.get('AIWIZARDS_CLOUDFLARE_API_TOKEN', '')
    account = os.environ.get('AIWIZARDS_CLOUDFLARE_ACCOUNT_ID') or env.get('AIWIZARDS_CLOUDFLARE_ACCOUNT_ID', '')
    red = Redactor(token, pem)

    trusted = ','.join(s.strip() for s in a.trusted_logins.split(',') if s.strip())
    vars_ = {'GH_ORG': a.org, 'INBOX_REPO': a.inbox_repo, 'TRIAGE_REPO': a.triage_repo, 'TRUSTED_LOGINS': trusted}
    metadata = {
        'main_module': 'worker.js',
        'compatibility_date': COMPAT_DATE,
        'bindings': [{'type': 'plain_text', 'name': k, 'text': v} for k, v in vars_.items()],
        'keep_bindings': ['secret_text'],
    }
    body, ctype = multipart([
        ('metadata', None, 'application/json', json.dumps(metadata).encode()),
        ('worker.js', 'worker.js', 'application/javascript+module', script),
    ])
    secrets = {'GH_APP_ID': a.app_id, 'GH_APP_PRIVATE_KEY': pem}

    print(f'script: {a.name} ({len(script)} bytes), compatibility_date {COMPAT_DATE}')
    print('vars:', json.dumps(vars_))
    print('secrets:', ', '.join(f'{k} ({len(v)} chars)' for k, v in secrets.items()))
    if a.dry_run:
        print(f'dry run: multipart body {len(body)} bytes built; nothing sent.')
        print('token present:', bool(token), '| account id present:', bool(account))
        return
    if not token or not account:
        sys.exit('AIWIZARDS_CLOUDFLARE_API_TOKEN / AIWIZARDS_CLOUDFLARE_ACCOUNT_ID missing')

    def cf(method, path, data=None, content_type='application/json'):
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data).encode()
        req = urllib.request.Request(API + path, data=data, method=method, headers={'Authorization': f'Bearer {token}', 'Content-Type': content_type, 'User-Agent': 'wizardos-feedback-relay-deploy'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.load(e)
            except Exception:
                return e.code, {}

    def check(step, status, j):
        errs = '; '.join(f"{e.get('code')}: {e.get('message')}" for e in (j.get('errors') or []))
        print(red(f'{step}: HTTP {status}' + (f' ({errs})' if errs else '')))
        if status >= 300 or not j.get('success', False):
            sys.exit(red(f'{step} failed; stopping.'))

    base = f'/accounts/{account}/workers/scripts/{a.name}'
    check('upload script', *cf('PUT', base, body, ctype))
    for k, v in secrets.items():
        check(f'secret {k}', *cf('PUT', base + '/secrets', {'name': k, 'text': v, 'type': 'secret_text'}))
    check('enable workers.dev', *cf('POST', base + '/subdomain', {'enabled': True, 'previews_enabled': False}))
    st, j = cf('GET', f'/accounts/{account}/workers/subdomain')
    sub = (j.get('result') or {}).get('subdomain')
    if not sub:
        sys.exit('could not read the account workers.dev subdomain')
    url = f'https://{a.name}.{sub}.workers.dev'
    print('relay url:', url)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url + '/', headers={'User-Agent': 'wizardos-feedback-relay-deploy'}), timeout=20) as r:
                print('health:', r.status, r.read(200).decode(errors='replace').strip())
                return
        except Exception as e:  # new workers.dev routes can take a few seconds
            last = e
            time.sleep(5)
    print(red(f'health check did not answer yet: {last}'))


if __name__ == '__main__':
    main()
