# voice-mcp — private OAuth hardening branch

This fork turns the original public voice Worker into a private MCP resource server. C1 is an offline implementation milestone: it has no real OAuth tenant, TTS key, or deployment attached yet.

## Security model

- `/mcp` requires a verified OAuth JWT with issuer, audience, expiry, `voice:generate` scope, and an allow-listed `sub`.
- `/.well-known/oauth-protected-resource` is public for OAuth discovery.
- `/healthz` is public and intentionally minimal.
- Legacy `/speak`, `/panel`, `/events/latest`, `/history`, `/status`, and landing-page routes return `404`.
- Generated audio and text are returned only in the MCP tool result. The Worker does not cache or persist either.
- A Durable Object applies per-subject daily and per-minute quotas atomically.
- TTS requests have an explicit timeout and no automatic retry. Logs contain only request metadata, character count, duration, provider, and a one-way subject hash.
- The inline card plays audio, toggles the transcript, and downloads the current result as an MP3 blob.

## Defaults

| Limit | Default |
| --- | ---: |
| Visible input | 500 Unicode characters |
| Audio result | 4 MiB |
| Calls per minute | 3 |
| Calls per UTC day | 30 |
| Characters per UTC day | 10,000 |
| TTS timeout | 20 seconds |

All defaults can be changed with the corresponding `MAX_*` or `TTS_TIMEOUT_MS` Worker variable.

## Required production bindings

These remain placeholders until the authorized account-configuration phase.

| Variable/secret | Purpose |
| --- | --- |
| `OAUTH_ISSUER` | Exact OAuth issuer URL |
| `OAUTH_AUDIENCE` | Expected JWT audience |
| `OAUTH_RESOURCE` | Canonical public MCP URL |
| `OAUTH_JWKS_URI` | HTTPS JWKS endpoint |
| `ALLOWED_SUBS` | Comma-separated owner subject IDs |
| `TTS_PROVIDER` | `dashscope` or `elevenlabs` |
| Provider API key and voice ID | Private TTS credentials |
| `BOT_NAME` | Safe display name in the voice card |

Never commit real values. Configure them as Worker secrets/variables only during the deployment phase.

## Offline verification

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm audit --omit=dev
```

`npm run build` is a Wrangler dry-run. It does not publish the Worker.
