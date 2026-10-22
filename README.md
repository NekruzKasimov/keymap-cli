# keymap

A values-free map of every secret you run, where it lives, and one command to rotate it everywhere.

![keymap incident railway, then a dry-run rotate](docs/keymap-demo.svg)

**It is a map, not a vault.** keymap never stores a secret value. The manifest and its state hold names, locations, timestamps and short salted hashes. Values move only between your existing CLIs (`gh`, `railway`, …) and the host, over stdin or a mode-600 temp file, never through a shell string or on a command line.

Built after the OpenCode (Oct 16, 2026) and Railway (Oct 21, 2026) key thefts, when "rotate every variable" met "I don't remember where half of these are used".

Commands: `init`, `audit`, `mark`, `rotate`, `incident`, `remind`, `doctor`. Hosts: `local` (.env files), `github` (Actions secrets), `railway`, `vercel`, `fly`, `cloudflare` (Workers), `supabase` (Edge Function secrets). OpenRouter keys can be minted by API.

## Quick start

```sh
npm i -g keymap-cli            # or: npx keymap-cli
cd your-project
keymap init -s local:.env github:owner/repo railway:api/production
# edit keymap.yaml: issuers, rotate_every, ignore list
# (init skips config-looking names such as APP_URL, UPLOAD_DIR, MERCHANT_ID; pass --all to include them)
keymap audit                   # exit 1 on missing / drift / overdue / unmapped
keymap mark OPENAI_API_KEY     # you rotated it by hand today
pbpaste | keymap rotate OPENAI_API_KEY   # push a new key everywhere, hosts first, laptop last
keymap rotate OPENAI_API_KEY             # same, but prompts for the value without echo
keymap rotate SESSION_SECRET --generate  # mint a random value for a secret you own
keymap rotate OPENROUTER_API_KEY --mint --limit 20 --limit-reset monthly  # create at OpenRouter with a cap, push
keymap revoke OPENROUTER_API_KEY         # after every host redeployed: delete the key it replaced
keymap incident railway         # a host was breached: what lives there, most dangerous first
keymap incident railway --walk  # ...and rotate each one in turn
keymap doctor                   # which host CLIs are installed and logged in
KEYMAP_WEBHOOK=https://hooks.slack.com/... keymap remind   # post the audit summary (names only)
```

## Run it every day

Copy `templates/keymap-audit.yml` to `.github/workflows/` and add the host tokens it lists as repository secrets. It runs `keymap audit` each morning and, if `KEYMAP_WEBHOOK` is set, posts a one-message summary. Findings never contain values, so the summary is safe for a shared channel. Every package and action in the template is pinned to an exact version or commit: that job holds your host tokens, so do not loosen the pins.

`rotate` stops at the first failing sink, tells you which sinks still hold the old value, and never records a rotation it did not finish. The value comes from stdin, a file, or a no-echo prompt, so it stays out of shell history and `ps`. The old key is never revoked automatically: hosts keep running the old value until they redeploy, so revocation is a separate step (`keymap revoke`, or the printed checklist for issuers without an API).

## When a host is breached

```
$ keymap incident railway
INCIDENT railway: 4 secrets to rotate, most dangerous first

[0] AI provider keys (a stolen key is a credit card for compute)
    OPENAI_API_KEY      openai   exposed at railway:api; also lives at local:.env
[1] Cloud, payments and infrastructure tokens
    STRIPE_SECRET_KEY   stripe   exposed at railway:api; also lives at vercel:web/production+preview
[2] Database and storage credentials
    DATABASE_URL        custom   exposed at railway:api; also lives at local:.env
[4] Package registry credentials
    NPM_TOKEN           custom   exposed at railway:worker; lives nowhere else
```

The order follows Railway's own disclosure guidance: AI keys, cloud and payments, databases, source control, package registries. `--walk` asks for each new value, pushes it everywhere, and ends with the list of anything still exposed.

## keymap.yaml

```yaml
version: 1
project: flashlight-finder
ignore: [FEATURE_FLAG_*]
secrets:
  OPENAI_API_KEY:
    issuer: openai
    rotate_every: 30d
    sinks:
      - railway: {service: api, environment: production}
      - github: {repo: nek/flashlight-finder}
      - local: {file: .env}
```

Commit this file, and review changes to it like code: a sink added here receives the next rotated value. Local sinks may only point at `.env`-style files inside the project, and `rotate` refuses to write one that git would commit.

State (`~/.keymap/<project>-<hash>.state.json`, mode 600) stays on your machine and is keyed by the checkout's path: move the folder and keymap starts a fresh state (run `keymap revoke --hash` by hand for any key it was tracking). It records timestamps, salted hash prefixes, and for minted keys the issuer's key id, never a value.

## What audit checks

| Finding | Meaning |
|---|---|
| MISSING | mapped secret absent at a sink |
| DRIFT | value differs between sinks that can be read back (shown as `≠`) |
| OVERDUE | older than `rotate_every` |
| UNKNOWN AGE | never rotated or marked through keymap |
| UNMAPPED | a sink has a name that is not in the manifest or `ignore` |
| ERROR | a host CLI failed (not logged in, etc.) |

GitHub Actions and Cloudflare secrets are write-only, so they show as `(wo)`: presence is checked, drift is not. Fly and Supabase expose only their own digests, which cannot be compared with other sinks, so drift is not checked there either.

## Sinks

| Sink | Shorthand for `init -s` | List | Set |
|---|---|---|---|
| local | `local:.env` | parse file | rewrite one line |
| github | `github:owner/repo[/env]` | `gh secret list` | `gh secret set` (stdin) |
| railway | `railway:service[/environment]` | `railway variable list --json` | `railway variable set --stdin --skip-deploys` |
| vercel | `vercel:project[/production+preview]` | `vercel env list --json` | `vercel env add --force` (stdin) |
| fly | `fly:app` | `flyctl secrets list --json` | `flyctl secrets import --stage` (stdin) |
| cloudflare | `cloudflare:worker[/env]` | `wrangler secret list` | `wrangler secret put` (stdin) |
| supabase | `supabase:projectref` | `supabase secrets list -o json` | `supabase secrets set --env-file` (mode-600 temp file) |

Every adapter shells out to the official CLI you are already logged into, with a 2-minute timeout, seeing only its own host's token and none of keymap's own environment variables. Nothing is proxied, no value touches a shell string or argv, and CLI error text is redacted and never includes a listing's stdout.

## Security notes

- Reviewed 2026-10-22 against a written threat model (value leakage, injection, file safety, supply chain, rotation logic). Findings and fixes are in the commit history.
- `--mint` records the new key's id before pushing and leaves the previous key live until you run `revoke`. If a rotation fails part-way the minted key stays live too (some sinks already hold it); a later successful `--mint` moves it to the same revoke-after-redeploy set, and `keymap revoke` deletes all of them. A second `--mint` is refused until the previous key has been revoked.
- Each host CLI runs with only its own credential variable; every other host token and all `KEYMAP_*` variables are stripped from its environment.
- Hash prefixes are HMAC-SHA256 with a per-machine salt (`~/.keymap/.salt`), so they cannot be checked offline against a wordlist.
- Report issues privately to the maintainer before opening a public issue.

## License

MIT
