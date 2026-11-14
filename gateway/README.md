# Moondog model gateway

This folder holds the service behind the model named **Moondog** in the app and the terminal.
It is a Cloudflare Worker at `https://moondog-api.audiofool.ai`.

A listener with an invite code can use the Moondog model without a key of their own.
The invite code is the key.
The gateway holds the upstream provider's key, picks the upstream model, and counts each code's tokens.

## What it does

- `POST /v1/chat/completions` takes an OpenAI Chat Completions request, with the invite code as the bearer key.
  It sends the request to the upstream model and names the model `moondog` in every reply.
- `GET /v1/models` lists the one model.
- `GET /v1/invite` returns the code's name, its daily allowance and today's use.
- `/admin/invites` makes, lists, stops and restores codes, with the owner's key.

It refuses a request with an OpenAI-style error and one of these codes:

| Code | Status | Meaning |
| --- | --- | --- |
| `invite_invalid` | 401 | The code is not known. |
| `invite_revoked` | 401 | The owner stopped the code. |
| `beta_ended` | 403 | The test period, or this code's period, is over. |
| `daily_allowance_used` | 429 | The code used its tokens for today. |
| `beta_capacity_reached` | 429 | All testers together used today's tokens. |
| `rate_limited` | 429 | More than 20 requests in a minute. |
| `upstream_error` | 429 or 5xx | The upstream model failed; the upstream's own words are not passed on. |

The allowance day turns at midnight, Beijing time.

## What it keeps

The gateway keeps the SHA-256 of each invite code, the name the owner gave it, and token and request counts for each code and day.
It does not keep or log any message, reply, or tool call.
A request passes through to the upstream provider, which has its own retention terms.

## Settings

`wrangler.toml` holds the settings that are not secret.

| Name | Kind | Meaning |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | secret | The upstream's OpenAI-compatible base address, without `/chat/completions`. |
| `UPSTREAM_MODEL` | secret | The upstream model ID. |
| `UPSTREAM_EXTRA_BODY` | var, optional | A JSON object merged into each upstream request. |
| `DAILY_TOKEN_LIMIT` | var | Tokens for one code in one day; 3,000,000 by default. |
| `GLOBAL_DAILY_TOKEN_LIMIT` | var | Tokens for all codes in one day; 40,000,000 by default. |
| `PER_MINUTE_LIMIT` | var | Requests for one code in one clock minute; 20 by default. |
| `BETA_ENDS_AT` | var, optional | An ISO date and time after which every code is refused. |
| `UPSTREAM_API_KEY` | secret | The upstream provider's key. |
| `ADMIN_TOKEN` | secret | The owner's key for `/admin/invites`. |

The upstream's address and model are secrets because this repository is public and the app never names the upstream.
To change the upstream model, run `wrangler secret put UPSTREAM_MODEL`.
The app needs no release.

The gateway counts the per-minute limit itself, in D1.
Cloudflare's rate limit binding let 37 requests through in 20 seconds against a limit of 20 when it was tried on 2026-11-14.

## Deploy

```sh
cd gateway
npx wrangler d1 create moondog-model          # put the database_id in wrangler.toml
npx wrangler d1 execute moondog-model --remote --file schema.sql
npx wrangler secret put UPSTREAM_BASE_URL
npx wrangler secret put UPSTREAM_MODEL
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

The route in `wrangler.toml` is the custom domain `moondog-api.audiofool.ai`.
`moondog.audiofool.ai` is the project page on GitHub Pages; the gateway does not use it.

Check a deployment before any code goes to a tester:

- `GET /` answers `{"service":"moondog-model","model":"moondog"}`.
- `GET /v1/invite` with a made-up code answers 401 with the code `invite_invalid`.
- A test code from `invite.mjs create` gets a streamed reply whose events name the model `moondog`, and `invite.mjs list` then shows its tokens for today.
- After `invite.mjs revoke`, the test code answers 401 with the code `invite_revoked`.
- From mainland China, the address answers in a usable time.

## Invite codes

```sh
export MOONDOG_GATEWAY_ADMIN_TOKEN=...        # the ADMIN_TOKEN secret
node gateway/scripts/invite.mjs create "Name one" "Name two"
node gateway/scripts/invite.mjs list
node gateway/scripts/invite.mjs revoke 12
```

`create` prints each code once, with its invite link.
The gateway cannot show a code again.

## Tests

```sh
node --test gateway/tests/*.test.mjs
```
