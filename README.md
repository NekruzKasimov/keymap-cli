# keymap

A values-free map of every secret you run, where it lives, and one command to rotate it everywhere.

**It is a map, not a vault.** keymap never stores a secret value. The manifest and its state hold names, locations, timestamps and 8-character hash prefixes. Values move only between your existing CLIs (`gh`, `railway`, …) and the host, over stdin, never through a shell string.

Built for solo and vibe-coded deployments after the OpenCode (Oct 16, 2026) and Railway (Oct 21, 2026) key thefts, when "rotate every variable" met "I don't remember where half of these are used".

## Status

Day 1. `init`, `audit`, `mark` work for `local` (.env files), `github` (Actions secrets) and `railway`. `rotate`, `incident`, `remind` and the Vercel / Fly / Cloudflare / Supabase adapters are next.

## Quick start

```sh
npm i -g keymap-cli            # or: npx keymap-cli
cd your-project
keymap init -s local:.env github:owner/repo railway:api/production
# edit keymap.yaml: issuers, rotate_every, ignore list
keymap audit                   # exit 1 on missing / drift / overdue / unmapped
keymap mark OPENAI_API_KEY     # you rotated it by hand today
```

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

GitHub Actions secrets are write-only, so they show as `(wo)`: presence is checked, drift is not.

## License

MIT
