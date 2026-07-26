#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line || /^\s*#/.test(line)) continue;
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1);
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    }
  } catch (e) {
    console.warn(`Warning: failed to load .env: ${e.message}`);
  }
})();

const PROXY_ENV = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const PROXY_REQUIRED = String(process.env.PROXY_REQUIRED || '').toLowerCase() === 'true';
const PROXY_CONNECT_TIMEOUT_MS = Number(process.env.PROXY_CONNECT_TIMEOUT_MS || 5000);
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const KEY_REQUIRED = String(process.env.KEY_REQUIRED || '').toLowerCase() === 'true';

function shouldBypassProxy(hostname) {
  return NO_PROXY.some(entry => {
    if (!entry) return false;
    if (entry === '*') return true;
    if (entry.startsWith('.')) return hostname.endsWith(entry);
    return hostname === entry;
  });
}

class HttpsOverHttpProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: true });
    this.proxy = new URL(proxyUrl);
    if (this.proxy.protocol !== 'http:') {
      throw new Error('HttpsOverHttpProxyAgent expects an http:// proxy URL');
    }
  }
  createConnection(options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const proxyHost = this.proxy.hostname;
    const proxyPort = Number(this.proxy.port) || 80;
    const proxyAuth = this.proxy.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password || '')}`).toString('base64')
      : null;

    const socket = net.connect({ host: proxyHost, port: proxyPort });
    const t = setTimeout(() => {
      socket.destroy(new Error('PROXY CONNECT timeout'));
    }, PROXY_CONNECT_TIMEOUT_MS);
    socket.once('error', err => {
      clearTimeout(t);
      callback(err);
    });
      socket.once('connect', () => {
      clearTimeout(t);
      const connectHeaders = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Connection: keep-alive',
      ];
      if (proxyAuth) connectHeaders.push(`Proxy-Authorization: ${proxyAuth}`);
      connectHeaders.push('', '');
      socket.write(connectHeaders.join('\r\n'));

      let buffered = '';
      const t2 = setTimeout(() => {
        socket.removeListener('data', onData);
        socket.destroy(new Error('PROXY CONNECT response timeout'));
        callback(new Error('PROXY CONNECT response timeout'));
      }, PROXY_CONNECT_TIMEOUT_MS);
      const onData = (chunk) => {
        buffered += chunk.toString('latin1');
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        clearTimeout(t2);
        socket.removeListener('data', onData);
        const headerText = buffered.slice(0, headerEnd);
        if (!/^HTTP\/1\.[01] 200\b/.test(headerText)) {
          const err = new Error(`Proxy CONNECT failed: ${headerText.split('\r\n')[0]}`);
          socket.destroy(err);
          return callback(err);
        }
        const tlsSocket = tls.connect({
          socket,
          servername: targetHost,
        }, () => callback(null, tlsSocket));
        tlsSocket.once('error', err => callback(err));
      };
      socket.on('data', onData);
    });
  }
}

function getUpstreamAgentFor(hostname) {
  if (!PROXY_ENV) return null;
  if (shouldBypassProxy(hostname)) return null;
  if (PROXY_ENV.startsWith('http://')) {
    return new HttpsOverHttpProxyAgent(PROXY_ENV);
  }
  if (PROXY_ENV.startsWith('https://')) {
    class HttpsOverHttpsProxyAgent extends https.Agent {
      constructor(proxyUrl) {
        super({ keepAlive: true });
        this.proxy = new URL(proxyUrl);
      }
      createConnection(options, callback) {
        const targetHost = options.host || options.hostname;
        const targetPort = options.port || 443;
        const proxyHost = this.proxy.hostname;
        const proxyPort = Number(this.proxy.port) || 443;
        const proxyAuth = this.proxy.username
          ? 'Basic ' + Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password || '')}`).toString('base64')
          : null;
        const proxyTls = tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost });
        const t = setTimeout(() => {
          proxyTls.destroy(new Error('PROXY CONNECT timeout'));
        }, PROXY_CONNECT_TIMEOUT_MS);
        proxyTls.once('error', err => {
          clearTimeout(t);
          callback(err);
        });
        proxyTls.once('secureConnect', () => {
          clearTimeout(t);
          const lines = [
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
            `Host: ${targetHost}:${targetPort}`,
            'Connection: keep-alive',
          ];
          if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
          lines.push('', '');
          proxyTls.write(lines.join('\r\n'));
          let buffered = '';
          const t2 = setTimeout(() => {
            proxyTls.removeListener('data', onData);
            proxyTls.destroy(new Error('PROXY CONNECT response timeout'));
            callback(new Error('PROXY CONNECT response timeout'));
          }, PROXY_CONNECT_TIMEOUT_MS);
          const onData = (chunk) => {
            buffered += chunk.toString('latin1');
            const headerEnd = buffered.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            clearTimeout(t2);
            proxyTls.removeListener('data', onData);
            const headerText = buffered.slice(0, headerEnd);
            if (!/^HTTP\/1\.[01] 200\b/.test(headerText)) {
              const err = new Error(`Proxy CONNECT failed: ${headerText.split('\r\n')[0]}`);
              proxyTls.destroy(err);
              return callback(err);
            }
            const tlsSocket = tls.connect({ socket: proxyTls, servername: targetHost }, () => callback(null, tlsSocket));
            tlsSocket.once('error', err => callback(err));
          };
          proxyTls.on('data', onData);
        });
      }
    }
    return new HttpsOverHttpsProxyAgent(PROXY_ENV);
  }
  return null;
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`Failed to read config.json: ${e.message}`);
  process.exit(1);
}

const PORT = config.port || 8082;
let KEYS = config.keys || [];

const ENV_KEYS = (process.env.ANTHROPIC_API_KEYS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map((key, i) => ({ name: `env${i+1}`, key }));
const SINGLE_ENV_KEY = process.env.ANTHROPIC_API_KEY ? [{ name: 'env', key: process.env.ANTHROPIC_API_KEY }] : [];
if (ENV_KEYS.length) {
  KEYS = ENV_KEYS;
} else if (SINGLE_ENV_KEY.length) {
  KEYS = SINGLE_ENV_KEY;
}

const CLAUDE_CODE_BETA = 'claude-code-20250219';
const SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

const AUTH_METHODS = [];

const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';
if (AUTH_TOKEN) {
  AUTH_METHODS.push({ type: 'bearer', name: 'token', token: AUTH_TOKEN });
}

if (ENV_KEYS.length) {
  ENV_KEYS.forEach(k => AUTH_METHODS.push({ type: 'apikey', name: k.name, key: k.key }));
} else if (SINGLE_ENV_KEY.length) {
  AUTH_METHODS.push({ type: 'apikey', name: SINGLE_ENV_KEY[0].name, key: SINGLE_ENV_KEY[0].key });
}

for (const k of KEYS) {
  if (!AUTH_METHODS.some(m => m.type === 'apikey' && m.key === k.key)) {
    AUTH_METHODS.push({ type: 'apikey', name: k.name, key: k.key });
  }
}

const clientAuthCache = new Map();

function applyAuthHeaders(headers, method, selectedKey) {
  if (method.type === 'bearer') {
    headers['Authorization'] = `Bearer ${method.token}`;
    delete headers['x-api-key'];
  } else {
    headers['x-api-key'] = method.key;
    delete headers['Authorization'];
  }
}

let keyIndex = 0;

function getNextKey() {
  const entry = KEYS[keyIndex % KEYS.length];
  keyIndex++;
  return entry;
}

function getKeyByName(name) {
  return KEYS.find(k => k.name === name);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', methods: AUTH_METHODS.length, strategy: config.strategy }));
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      port: PORT,
      methods: AUTH_METHODS.map(m => m.type === 'apikey'
        ? { type: m.type, name: m.name, key: m.key.slice(0, 20) + '...' }
        : { type: m.type, name: m.name }),
      strategy: config.strategy,
      requestsServed: keyIndex
    }));
    return;
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only POST /v1/messages is proxied' }));
    return;
  }

  const clientKey = req.headers['x-api-key'] || '';
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  let selectedMethod;
  let keySource;

  if (clientKey) {
    selectedMethod = { type: 'passthrough', name: 'client', key: clientKey };
    keySource = 'passthrough';
  } else if (AUTH_METHODS.length) {
    const cached = clientAuthCache.get(clientIp);
    if (cached) {
      selectedMethod = AUTH_METHODS.find(m => m.name === cached.name && m.type === cached.type);
    }
    if (!selectedMethod) {
      selectedMethod = AUTH_METHODS[keyIndex % AUTH_METHODS.length];
      keyIndex++;
    }
    keySource = selectedMethod.type === 'bearer' ? 'token' : 'apikey';
  } else {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No API key provided' }));
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const ccSystemBlock = { type: 'text', text: SYSTEM_PROMPT };

    if (!body.system) {
      body.system = [ccSystemBlock];
    } else if (typeof body.system === 'string') {
      body.system = [ccSystemBlock, { type: 'text', text: body.system }];
    } else if (Array.isArray(body.system)) {
      body.system.unshift(ccSystemBlock);
    }

    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    };
    applyAuthHeaders(upstreamHeaders, selectedMethod, selectedMethod);

    const clientBeta = req.headers['anthropic-beta'] || '';
    const betaParts = clientBeta ? clientBeta.split(',').map(s => s.trim()) : [];
    if (!betaParts.includes(CLAUDE_CODE_BETA)) {
      betaParts.unshift(CLAUDE_CODE_BETA);
    }
    upstreamHeaders['anthropic-beta'] = betaParts.join(',');

    if (req.headers['accept']) upstreamHeaders['accept'] = req.headers['accept'];

    const payload = JSON.stringify(body);
    upstreamHeaders['content-length'] = Buffer.byteLength(payload);

    const startTime = Date.now();
    const requestOptions = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: req.url,
      method: 'POST',
      headers: upstreamHeaders,
    };
    const agent = getUpstreamAgentFor('api.anthropic.com');
    if (agent) requestOptions.agent = agent;
    const upstreamReq = https.request(requestOptions, (upstreamRes) => {
      const elapsed = Date.now() - startTime;
      const model = body.model || '?';
      const isStream = body.stream === true;

      console.log(`[${new Date().toISOString()}] [${keySource}] ${selectedMethod.name} → ${model} ${isStream ? '(stream)' : ''} → ${upstreamRes.statusCode} (${elapsed}ms)`);

      if (upstreamRes.statusCode < 400 && selectedMethod.type !== 'passthrough') {
        clientAuthCache.set(clientIp, { type: selectedMethod.type, name: selectedMethod.name });
      }

      if ([401, 403, 529].includes(upstreamRes.statusCode) && !clientKey && AUTH_METHODS.length > 1) {
        const otherMethod = AUTH_METHODS.find(m =>
          !(m.type === selectedMethod.type && m.name === selectedMethod.name)
        );
        if (otherMethod) {
          clientAuthCache.delete(clientIp);
          console.log(`  -> Auth fail on ${selectedMethod.name}, retrying with ${otherMethod.name}`);
          applyAuthHeaders(upstreamHeaders, otherMethod, otherMethod);
          const retryOptions = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: req.url,
            method: 'POST',
            headers: upstreamHeaders,
          };
          const retryAgent = getUpstreamAgentFor('api.anthropic.com');
          if (retryAgent) retryOptions.agent = retryAgent;
          const retryReq = https.request(retryOptions, (retryRes) => {
            const retryElapsed = Date.now() - startTime;
            console.log(`  -> Retry ${retryRes.statusCode} (${retryElapsed}ms)`);
            if (retryRes.statusCode < 400 && otherMethod.type !== 'passthrough') {
              clientAuthCache.set(clientIp, { type: otherMethod.type, name: otherMethod.name });
            }
            res.writeHead(retryRes.statusCode, retryRes.headers);
            retryRes.pipe(res);
          });
          retryReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Retry upstream error: ${e.message}` }));
          });
          retryReq.write(payload);
          retryReq.end();
          upstreamRes.resume();
          return;
        }
      }

      if (upstreamRes.statusCode === 429 && selectedMethod.type === 'apikey' && AUTH_METHODS.length > 1) {
        const nextMethod = AUTH_METHODS[(AUTH_METHODS.indexOf(selectedMethod) + 1) % AUTH_METHODS.length];
        if (nextMethod.type === 'apikey' && nextMethod.key !== selectedMethod.key) {
          console.log(`  -> 429 on ${selectedMethod.name}, retrying with ${nextMethod.name}`);
          applyAuthHeaders(upstreamHeaders, nextMethod, nextMethod);
          const retryOptions = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: req.url,
            method: 'POST',
            headers: upstreamHeaders,
          };
          const retryAgent = getUpstreamAgentFor('api.anthropic.com');
          if (retryAgent) retryOptions.agent = retryAgent;
          const retryReq = https.request(retryOptions, (retryRes) => {
            console.log(`  -> Retry ${retryRes.statusCode}`);
            res.writeHead(retryRes.statusCode, retryRes.headers);
            retryRes.pipe(res);
          });
          retryReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Retry upstream error: ${e.message}` }));
          });
          retryReq.write(payload);
          retryReq.end();
          upstreamRes.resume();
          return;
        }
      }

      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (e) => {
      console.error(`Upstream error: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream error: ${e.message}` }));
    });

    upstreamReq.write(payload);
    upstreamReq.end();
  });
});

(function startupPreflight() {
  if (PROXY_REQUIRED && !PROXY_ENV) {
    console.error('Startup error: PROXY_REQUIRED=true but no HTTPS_PROXY/HTTP_PROXY is set');
    process.exit(1);
  }
  if (KEY_REQUIRED) {
    if (!AUTH_METHODS.length && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEYS) {
      console.error('Startup error: KEY_REQUIRED=true but no ANTHROPIC_API_KEY/ANTHROPIC_API_KEYS/ANTHROPIC_AUTH_TOKEN env or config.keys provided');
      process.exit(1);
    }
  }
  if (PROXY_ENV) {
    const masked = (() => {
      try {
        const u = new URL(PROXY_ENV);
        if (u.password) u.password = '*****';
        return u.toString();
      } catch { return PROXY_ENV; }
    })();
    console.log(`Using upstream proxy: ${masked}`);
    const agent = getUpstreamAgentFor('api.anthropic.com');
    if (!agent && PROXY_REQUIRED) {
      console.error('Startup error: Proxy configured but bypassed by NO_PROXY or unsupported scheme');
      process.exit(1);
    }
    if (agent) {
      const testReq = https.request({
        host: 'api.anthropic.com',
        port: 443,
        method: 'HEAD',
        path: '/',
        agent,
        timeout: PROXY_CONNECT_TIMEOUT_MS,
      }, (r) => {
        r.resume();
      });
      testReq.on('timeout', () => {
        testReq.destroy(new Error('PROXY CONNECT timeout'));
      });
      testReq.on('error', (e) => {
        console.error(`Startup error: Proxy self-check failed: ${e.message}`);
        if (PROXY_REQUIRED) process.exit(1);
      });
      testReq.end();
    }
  }
})();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nClaude Code Proxy running on http://127.0.0.1:${PORT}`);
  console.log(`   Auth methods: ${AUTH_METHODS.map(m => m.type + '(' + m.name + ')').join(', ') || 'none'}`);
  console.log(`   Strategy: ${config.strategy}`);
  console.log(`   Endpoints:`);
  console.log(`     POST /v1/messages  -> proxied to Anthropic`);
  console.log(`     GET  /health       -> health check`);
  console.log(`     GET  /status       -> key status\n`);
});
