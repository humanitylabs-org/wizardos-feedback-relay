# WizardOS Feedback relay

A small public Cloudflare Worker that lets the WizardOS **Feedback** app file bug reports and
feature requests into the private `humanitylabs-org` repos — even for people who are signed out
or not in the org. It holds the identity of a private GitHub App, **WizardOS Feedback Relay**.

- One ES-module file, `worker.js`. No npm dependencies, no build step, well under 1 MiB.
- Reporters get a random **receipt**. They use it to check progress in plain words. The relay
  never returns repo names, labels, URLs, logins or comments.

## Where reports go

| Reporter | Repo | Labels | Footer |
|---|---|---|---|
| `gh_token` login is in `TRUSTED_LOGINS`, or is an active org member | `GH_ORG/TRIAGE_REPO` (`wizard-os`) | `triage`, `bug`/`feature` | `Filed with Feedback by @login (via relay)` |
| Anyone else (no token, bad token, or not trusted) | `GH_ORG/INBOX_REPO` (`wizardos-feedback-inbox`) | `needs-review`, `bug`/`feature` | `Submitter: anonymous` or `@login, not on the trusted list` |

Untrusted text is made inert before filing: `@mentions` and `#123` / `org/repo#123` references are
broken with a zero-width space, and HTML comments / receipt markers can't be faked.
The footer also has the Wizard version and device when they were sent.

**The inbox must never be a repo the Builder reads.** Untrusted reports land there as raw text,
so the WizardOS Builder account and its teams must not get access to `wizardos-feedback-inbox`.
Only a person moves a report from the inbox into `wizard-os`. (Team membership was not changed by
this setup. Check it whenever Builder access changes.)

> ⚠️ As of setup, `wizardosbuilder` is an org member and the org's base permission is `read`,
> which gives it **read access to the inbox** (it has no direct or team grant). The Builder must
> be configured so it never reads `wizardos-feedback-inbox`. For a hard guarantee, an org owner
> would have to lower the org base permission to `none` and grant access through teams, which
> affects every repo. That change was intentionally not made here.

Screenshots are saved to `GH_ORG/wizard-issue-media` at
`feedback/<yyyy>/<receipt>-<n>.<ext>` through the contents API and linked in the issue. If an
upload fails, the text is still filed with a note saying the screenshot could not be attached.

## HTTP contract

CORS: `Access-Control-Allow-Origin: *`, with no credentials. Errors are always JSON
`{"error": "<code>", "message": "<human text>"}`.

### `GET /`
Returns the plain-text line `WizardOS Feedback relay: ok`.

### `POST /v1/report`
```json
{
  "kind": "bug",                       // "bug" | "feature"
  "text": "What happened …",           // 8..8000 chars after control chars are stripped
  "wizard_version": "2026.11.1",       // optional, ≤64
  "device": "Pixel 8 · Chrome 131",    // optional, ≤160
  "gh_token": "gho_…",                 // optional; checked with GET /user, never stored
  "screenshots": [                     // optional, ≤3, each ≤2 MB decoded
    {"type": "image/png", "data": "<base64 or data: URL>"}
  ]
}
```
`201` → `{"receipt": "<32 hex>", "status_key": "waiting_review", "line": "Waiting for the team to look at it"}`

- The title comes from the first sentence or line, up to 90 characters.
- The receipt is 128 random bits written as hex, so it is safe in a URL. It is stored in the issue
  body as `<!-- feedback-receipt: X -->`.

### `GET /v1/status?receipt=A,B,…` (at most 50)
```json
{"results": {"A": {"status_key": "building", "line": "Being built now", "title": "…", "kind": "bug",
                   "updated": "2026-11-11T…Z", "done_at": null, "closed_at": null}}}
```
Each receipt is found with a GitHub search `org:humanitylabs-org is:issue in:body "feedback-receipt: X"`
(5 receipts per query). The search covers open and closed issues, and the receipt survives when an
issue is transferred because the body moves with it. If an issue isn't found yet, the result is
`status_key: "not_found"`, because the search index can lag by up to about a minute after filing.
Declined items also carry `team_note` when the reviewer wrote a reason: only that text, read from the
relay bot's own `<!-- feedback-reason -->` comment, or — when an approved copy is declined later in the Tracker —
only the `Why:` text of a person's Drop / Not a bug comment. Other comments are never returned.

### Status keys (`statusFor()` in `worker.js`)
| Condition (first match wins) | `status_key` | `line` |
|---|---|---|
| closed as not planned / duplicate, or labelled `rejected` | `not_planned` | Declined by the team |
| closed (completed) | `done` | Done ✓ |
| open + `needs-review` | `waiting_review` | Waiting for the team to look at it |
| open + `ready-to-test` | `ready` | Almost there — the team is trying it out |
| open + `ai-review` | `checking` | Being tested |
| open + `building` | `building` | Being built now |
| open + `triage` | `received` | Got it — the team is sorting it |
| any other open | `queued` | Coming up — in line to be built |

### Reviewer endpoints: `GET /v1/pending`, `POST /v1/review`
For WizardOS team members (the Tracker calls these server-side with the signed-in user's own GitHub
token). Send the token as `Authorization: Bearer <user token>` (a `gh_token` query/body field is
accepted as a fallback). The relay checks it with `GET /user`, then checks with the bot that the login
is an active member of `GH_ORG` (`204`). No token or a dead token → `401 unauthorized`; not a member
→ `403 forbidden`. `TRUSTED_LOGINS` alone is not enough here.

`GET /v1/pending` → `{"items": [{"number", "kind", "title", "text", "submitter", "created", "screenshots": [urls]}]}`:
open inbox issues with `needs-review`, oldest first. `text` is the report without the footer, receipt or
screenshot section; `submitter` is `anonymous` or `@login`; screenshot URLs point into the private
`wizard-issue-media` repo (fetch them with a token that can read it).

`POST /v1/review {"issue": <inbox number>, "action": "approve"|"reject", "kind"?: "bug"|"feature", "reason"?: "…"}`
- **approve**: creates an issue in `TRIAGE_REPO` with labels `triage`, `bug`/`feature`, `from-feedback`
  (created if missing), the same title, and a body that starts with
  `**From Feedback app** · sent by <anonymous|@login> · approved by @reviewer`, then the original text,
  screenshots and the **same** receipt marker. Then it comments on the inbox issue with the link
  (plus a hidden `<!-- feedback-twin: repo#N -->`), adds `approved`, removes `needs-review` and closes it
  as completed. → `{"ok": true, "already": false, "result": "approved", "issue": N, "kind", "twin": {"repo", "number", "url"}}`
- **approve with `kind`**: approves it as that kind. When it differs from what was sent, the twin gets the new
  kind's label and marker, the head line gains ` · changed from bug to idea by @reviewer`, the inbox item's
  label/marker follow (original kept as `<!-- feedback-kind-submitted: … -->`), and the reply carries
  `"changed_from"`. `/v1/status` then reports the new `kind`.
- **reject**: adds `rejected`, removes `needs-review`, closes it as not planned. Optional `reason` (≤ 500
  chars, control characters and comment markers stripped) is stored in the closing comment after
  `<!-- feedback-reason -->`. → `{"ok": true, "already": false, "result": "rejected", "issue": N, "reason"?}`
- Idempotent: an item that was already handled returns its existing result with `"already": true`
  (and the twin for approved items); a retried approve after a partial failure reuses the twin.

`/v1/status` prefers the non-inbox issue when a receipt matches more than one, so approved reports show
their real stage; an approved inbox issue whose twin isn't searchable yet reads as `received`.

### Try new features counts: `POST /v1/switch-feedback`, `GET /v1/switch-counts`
For the shared **Try new features** section (wizard-os `docs/APP_SWITCHES.md`, wizard-app-manager#701). A box whose owner
turned on `wizard/try-feature-counts` sends, at most once a day or when something changed, its whole current state:
```json
{"contract": "wizard.switch-feedback/1", "box": "<32 hex, random, made once on the box>",
 "switches": [{"id": "<app id>:<switch id>", "issues": ["owner/repo#N"], "tried": true, "vote": "up"}]}
```
- No token, no identity: only those four fields per switch are kept (anything else in the body is dropped); at most 200
  switches, 12 issues each; `vote` is `up`, `down` or `null`. Bad bodies → `400`. 20 per IP per 10 min.
- Stored as one file, `GH_ORG/wizard-issue-media` `switch-feedback/boxes.json` (`{boxes: {<box>: {at, switches}}}`),
  through the same contents API the screenshots use, so the relay still needs no Cloudflare storage. Each box's send
  replaces its previous row (never counted twice); an empty list removes it; a box not heard from for 90 days drops out;
  at most 3000 boxes (oldest go first). The same rows again within 20 h are not written again.
  → `200 {"ok": true, "stored": true|false, "switches": N}`
- `GET /v1/switch-counts` (team members only, `Authorization: Bearer <GitHub token>` like `/v1/pending`) →
  `{"contract": "wizard.switch-counts/1", "boxes": N, "counts": {"<app>:<switch>": {"tried": N, "up": N, "down": N, "issues": [...]}}}`,
  which the Tracker shows as `Tried by N · 👍 N · 👎 N`.

### Abuse limits
- Rate limits per IP, inside each isolate: 5 reports per 10 minutes and 60 status checks per minute, 60 pending/review calls per minute. Over the limit returns `429 rate_limited`.
- Request bodies are capped at 10 MB.
- Control characters and bidi characters are stripped from all text.

## Configuration

| Name | Kind | Value |
|---|---|---|
| `GH_APP_ID` | secret | numeric App ID of *WizardOS Feedback Relay* |
| `GH_APP_PRIVATE_KEY` | secret | App private key PEM: PKCS#1 (`BEGIN RSA PRIVATE KEY`, as GitHub issues it) or PKCS#8. A literal `\n` is accepted. |
| `GH_ORG` | var | `humanitylabs-org` |
| `INBOX_REPO` | var | `wizardos-feedback-inbox` |
| `TRIAGE_REPO` | var | `wizard-os` |
| `TRUSTED_LOGINS` | var | optional comma list, e.g. `jdefleur,oscarhenrycollins` |

How the relay authenticates:
1. It signs an RS256 App JWT with WebCrypto.
2. It looks up the org installation with `GET /orgs/{org}/installation`.
3. It gets an installation token with `POST /app/installations/{id}/access_tokens`.
4. It caches that token in the isolate and refreshes it 5 minutes before it expires.

## One-time setup (Miguel's two taps)

1. **Create the GitHub App.** An org owner, signed in to GitHub, opens `manifest.html` in a
   browser. It posts `github-app-manifest.json` to
   `https://github.com/organizations/humanitylabs-org/settings/apps/new?state=<random>`. Click
   *Create GitHub App*. GitHub then redirects to `redirect_url` with `?code=…`. Exchange the code
   within 1 hour with `POST https://api.github.com/app-manifests/{code}/conversions`. That returns
   the `id` and the `pem`; save the PEM to a file with mode 600. Alternatively, get the App ID from
   the app's settings page and use *Generate a private key*.
   Permissions requested: Issues write, Contents write, Members read, Metadata read. No webhook.
2. **Install the app** on humanitylabs-org with *Only select repositories*:
   `wizard-os`, `wizardos-feedback-inbox`, `wizard-issue-media`. Search and status only see
   repos the installation can access.
3. **Deploy** from oscar-main:
   ```sh
   python3 deploy.py --app-id <ID> --pem /path/to/wizardos-feedback.private-key.pem \
       --trusted-logins <login1,login2>          # add --dry-run first to check without sending
   ```
   `deploy.py` reads `AIWIZARDS_CLOUDFLARE_API_TOKEN` and `AIWIZARDS_CLOUDFLARE_ACCOUNT_ID`
   from `~/.hermes/.env` (account *Humanity Labs*). It never prints secret values. It does these
   steps in order:
   1. `PUT /accounts/{A}/workers/scripts/wizardos-feedback-relay` as multipart, with
      `metadata = {main_module: "worker.js", compatibility_date, bindings: [plain_text vars], keep_bindings: ["secret_text"]}`
      plus the `worker.js` part (`application/javascript+module`).
   2. `PUT …/scripts/wizardos-feedback-relay/secrets` for `GH_APP_ID` and for `GH_APP_PRIVATE_KEY` (`type: secret_text`).
   3. `POST …/scripts/wizardos-feedback-relay/subdomain` with `{enabled: true}` to turn on workers.dev.
   4. A health check on `https://wizardos-feedback-relay.ai-wizards-previews.workers.dev/`.
   Re-running it updates the code and vars. Because of `keep_bindings`, existing secrets are kept.
4. Point the Feedback app at the relay URL.

## Reviewing the inbox

The easy way: the WizardOS Tracker's **Pending approval** stage lists these items for org members
with **Approve** (sends a copy to `wizard-os` with `triage` + `from-feedback`) and **Reject** (Not
planned), using `/v1/pending` and `/v1/review` above. By hand on GitHub:

A reviewer must be an org member with access to `wizardos-feedback-inbox`. For each open
`needs-review` issue:

- **Accept:** check the text and screenshots, and edit out anything sensitive. Then use
  *Transfer issue* to move it to `humanitylabs-org/wizard-os`, add the `triage` label, and
  remove `needs-review`. Labels with the same name carry over on transfer, so check them after
  the move. The reporter now sees *Got it — the team is sorting it*, and the normal pipeline takes over.
- **Reject:** *Close as not planned*. The reporter sees *Declined by the team* with the day and time.
- **Never delete the issue or remove the `<!-- feedback-receipt: … -->` line.** Status lookup
  depends on it, and it stays on the issue through transfers and closing.

## Development

```sh
node --test        # Node 20+; no dependencies. Uses openssl for a throwaway key in ~/.hermes/cache/scratch
```
The tests cover:
- status mapping, titles, control-character stripping and neutralising
- validation and receipts
- PKCS#1→PKCS#8 (checked byte-for-byte against openssl) and RS256 JWT sign/verify
- the rate limiter
- full report and status flows against a fake GitHub (inbox vs triage routing, token caching,
  screenshot failure, no leaks in status)
- the HTTP surface
- manifest.html matching the manifest JSON
- a `deploy.py --dry-run` redaction check

Set `FEEDBACK_TEST_TMP` to use a different scratch directory.
