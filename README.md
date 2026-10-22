# keymap

A values-free map of every secret you run, where it lives, and one command to rotate it everywhere.

**It is a map, not a vault.** keymap never stores a secret value. The manifest and its state hold names, locations, timestamps and 8-character hash prefixes. Values move only between your existing CLIs (`gh`, `railway`, …) and the host, over stdin, never through a shell string.

Built for solo and vibe-coded deployments after the OpenCode (Oct 16, 2026) and Railway (Oct 21, 2026) key thefts, when "rotate every variable" met "I don't remember where half of these are used".

## Status

Day 3. `init`, `audit`, `mark`, `rotate` and `incident` work for `local` (.env files), `github` (Actions secrets), `railway`, `vercel`, `fly`, `cloudflare` (Workers) and `supabase` (Edge Function secrets). OpenRouter keys can be minted by API. `remind` is next.

## Quick start

```sh
npm i -g keymap-cli            # or: npx keymap-cli
cd your-project
keymap init -s local:.env github:owner/repo railway:api/production
# edit keymap.yaml: issuers, rotate_every, ignore list
keymap audit                   # exit 1 on missing / drift / overdue / unmapped
keymap mark OPENAI_API_KEY     # you rotated it by hand today
pbpaste | keymap rotate OPENAI_API_KEY   # push a new key everywhere, hosts first, laptop last
keymap rotate SESSION_SECRET --generate  # mint a random value for a secret you own
keymap rotate OPENROUTER_API_KEY --mint --limit 20 --limit-reset monthly  # create at OpenRouter, push, delete old
keymap incident railway         # a host was breached: what lives there, most dangerous first
keymap incident railway --walk  # ...and rotate each one in turn
```

`rotate` stops at the first failing sink, tells you which sinks still hold the old value, and never records a rotation it did not finish. The value is read from stdin so it stays out of shell history.

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
    NPM_TOKEN           custom   exposed at railway:worker; also lives at nowhere else
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

Commit this file. State (`~/.keymap/<project>.state.json`, mode 600) stays on your machine.

## What audit checks

| Finding | Meaning |
|---|---|
| MISSING | mapped secret absent at a sink |
| DRIFT | hash prefix differs between sinks that can be read back |
| OVERDUE | older than `rotate_every` |
| UNKNOWN AGE | never rotated or marked through keymap |
| UNMAPPED | a sink has a name that is not in the manifest or `ignore` |
| ERROR | a host CLI failed (not logged in, etc.) |

GitHub Actions and Cloudflare secrets are write-only, so they show as `(wo)`: presence is checked, drift is not. Fly and Supabase expose their own digests, which keymap shows but cannot compare with other sinks.

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

Every adapter shells out to the official CLI you are already logged into. Nothing is proxied and no value touches a shell string or argv.

## License

MIT
