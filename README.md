# Claude Code Proxy

This is a local proxy that sends Anthropic-compatible requests through a Claude Code subscription.

## What it does

- accepts requests on `http://127.0.0.1:8082`
- forwards them to `https://api.anthropic.com`
- adds the Claude Code beta header
- injects the Claude Code system prompt
- can use `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_API_KEYS`

## Start

```bash
cp .env.example .env
node index.js
```

Port is configured in [config.json](/Users/fat/Documents/claude-code-proxy/config.json:1).

## .env

Main variable:

```dotenv
ANTHROPIC_AUTH_TOKEN=your_access_token
```

Optional variables:

```dotenv
ANTHROPIC_API_KEY=
ANTHROPIC_API_KEYS=
HTTPS_PROXY=
HTTP_PROXY=
NO_PROXY=
PROXY_REQUIRED=false
PROXY_CONNECT_TIMEOUT_MS=5000
KEY_REQUIRED=false
```

## How to get the token on macOS

1. Log in to Claude CLI.
2. Run:

```bash
security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null
```

3. In the returned data, find the `accessToken` value.
4. Put that value into `ANTHROPIC_AUTH_TOKEN`.

The `accessToken` variable is the one you need.

## Example request

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Endpoints

- `POST /v1/messages`
- `GET /health`
- `GET /status`

## Requirements

- Node.js 18+
