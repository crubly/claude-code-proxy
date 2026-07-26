# Claude Code Proxy

Local proxy for Anthropic-compatible clients that routes requests through a Claude Code subscription.

## Overview

The server listens on `http://127.0.0.1:8082`, forwards requests to `https://api.anthropic.com`, adds the Claude Code beta header, and injects the Claude Code system prompt.

Auth is always required. The proxy will not start unless one of these variables is set:

- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_API_KEYS`

## Quick start

```bash
cp .env.example .env
node index.js
```

## Environment

Recommended:

```dotenv
PORT=8082
ANTHROPIC_AUTH_TOKEN=your_access_token
```

Optional:

```dotenv
ANTHROPIC_API_KEY=
ANTHROPIC_API_KEYS=
HTTPS_PROXY=
HTTP_PROXY=
NO_PROXY=
PROXY_REQUIRED=false
PROXY_CONNECT_TIMEOUT_MS=5000
```

See [.env.example](/Users/fat/Documents/claude-code-proxy/.env.example:1) for the full template.

If `PORT` is not set, the default is `8082`.

## Getting the token on macOS

First log in to Claude CLI, then run:

```bash
security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null
```

Find the `accessToken` value in the output and put it into `ANTHROPIC_AUTH_TOKEN`.

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

- Node.js 18 or newer
