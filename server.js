#!/usr/bin/env node
/**
 * X-Media-Downloader 本地服务
 *
 * 作用：
 *   1. 静态托管 index.html / lib / sw.js 等前端文件
 *   2. 反向代理 X 的 GraphQL（/xapi → api.x.com）
 *   3. 反向代理媒体（/m → pbs.twimg.com，/v → video.twimg.com）
 *
 * 为什么需要它：
 *   - api.x.com 不返回 CORS 头，浏览器从任意站点跨域调用会被拦截
 *   - 浏览器禁止 JS 设置 Cookie 请求头，前端"粘贴 Cookie 直接请求 X"走不通
 *   由本服务同源转发，并在服务端把 x-twitter-cookie 还原成 Cookie，同时按 ct0 派生 x-csrf-token。
 *
 * 环境变量（全部可选）：
 *   PORT            监听端口，默认 8123
 *   XMD_PROXY_HOST  上游 HTTP 代理地址（如 127.0.0.1），留空表示直连
 *   XMD_PROXY_PORT  上游 HTTP 代理端口，默认 7890
 *   XMD_DUMP_DIR    设置后把最近 5 次 UserMedia 响应写到该目录，便于排查结构变化
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8123);
const PROXY_HOST = process.env.XMD_PROXY_HOST || '';
const PROXY_PORT = Number(process.env.XMD_PROXY_PORT || 7890);
const DUMP_DIR = process.env.XMD_DUMP_DIR || '';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const SKIP_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'origin', 'referer', 'cookie',
  'accept-encoding', 'te', 'upgrade',
]);

// 用新接口的 core / avatar / relationship_counts 合成旧的 legacy 结构，
// 让上游代码里依然读 legacy.* 的地方不会因为字段消失而报错。
function shimLegacy(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 60) return;
  if (Array.isArray(node)) { for (const it of node) shimLegacy(it, (depth || 0) + 1); return; }
  const core = node.core, rid = node.rest_id;
  if (core && rid && (core.name !== undefined || core.screen_name !== undefined)) {
    node.legacy = node.legacy || {};
    const L = node.legacy;
    if (L.name === undefined) L.name = core.name;
    if (L.screen_name === undefined) L.screen_name = core.screen_name;
    if (L.id_str === undefined) L.id_str = String(rid);
    if (L.created_at === undefined) L.created_at = core.created_at;
    if (node.avatar && L.profile_image_url_https === undefined) L.profile_image_url_https = node.avatar.image_url;
    if (node.relationship_counts) {
      if (L.followers_count === undefined) L.followers_count = node.relationship_counts.followers;
      if (L.friends_count === undefined) L.friends_count = node.relationship_counts.following;
    }
    if (node.tweet_counts) {
      if (L.statuses_count === undefined) L.statuses_count = node.tweet_counts.tweets;
      if (L.media_count === undefined) L.media_count = node.tweet_counts.media_tweets;
    }
    if (node.profile_bio && L.description === undefined) L.description = node.profile_bio.description;
    if (node.verification && L.verified === undefined) L.verified = node.verification.verified;
    if (node.privacy && L.protected === undefined) L.protected = node.privacy.protected;
  }
  for (const k of Object.keys(node)) { if (k !== 'legacy') shimLegacy(node[k], (depth || 0) + 1); }
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i, 'latin1');
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString('latin1').trim(), 16);
    if (!size || Number.isNaN(size)) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

function parseStatus(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  const head = buf.subarray(0, idx).toString('latin1');
  const lines = head.split('\r\n');
  const m = lines[0].match(/^HTTP\/[\d.]+ (\d{3})/);
  const status = m ? Number(m[1]) : 502;
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, headers, headEnd: idx + 4 };
}

function decodeBody(buf, headers) {
  const enc = (headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
  } catch (e) { return buf; }
  return buf;
}

// 统一出口：有代理走 CONNECT 隧道，没代理直连
function forward(host, method, pathAndQuery, headers, body, cb) {
  const speak = (socket) => {
    const t = tls.connect({ socket, servername: host, host: socket ? undefined : host, port: socket ? undefined : 443 }, () => {
      const lines = [method + ' ' + pathAndQuery + ' HTTP/1.1', 'Host: ' + host];
      for (const k of Object.keys(headers)) lines.push(k + ': ' + headers[k]);
      lines.push('Connection: close');
      if (body && body.length) lines.push('Content-Length: ' + body.length);
      t.write(lines.join('\r\n') + '\r\n\r\n');
      if (body && body.length) t.write(body);
      const chunks = [];
      t.on('data', d => chunks.push(d));
      t.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    t.setTimeout(60000, () => t.destroy(new Error('upstream timeout')));
    t.on('error', cb);
  };

  if (!PROXY_HOST) { speak(null); return; }

  const conn = http.request({ host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: host + ':443' });
  conn.setTimeout(60000, () => conn.destroy(new Error('proxy timeout')));
  conn.on('connect', (res, socket) => {
    if (res.statusCode !== 200) { cb(new Error('CONNECT ' + res.statusCode)); socket.destroy(); return; }
    speak(socket);
  });
  conn.on('error', cb);
  conn.end();
}

// 媒体专用：边收边发，支持 Range/断点，视频可以边下边播
function forwardStream(host, method, pathAndQuery, headers, clientRes, onHeaders) {
  const pump = (socket) => {
    const t = tls.connect({ socket, servername: host, host: socket ? undefined : host, port: socket ? undefined : 443 }, () => {
      const lines = [method + ' ' + pathAndQuery + ' HTTP/1.1', 'Host: ' + host];
      for (const k of Object.keys(headers)) lines.push(k + ': ' + headers[k]);
      lines.push('Connection: close');
      t.write(lines.join('\r\n') + '\r\n\r\n');

      let buf = Buffer.alloc(0);
      let started = false;
      let chunked = false;

      t.on('data', (c) => {
        if (started) {
          if (chunked) buf = Buffer.concat([buf, c]);
          else clientRes.write(c);
          return;
        }
        buf = Buffer.concat([buf, c]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const meta = parseStatus(buf.subarray(0, idx + 4));
        chunked = (meta.headers['transfer-encoding'] || '').includes('chunked');
        const out = {
          'content-type': meta.headers['content-type'] || 'application/octet-stream',
          'accept-ranges': meta.headers['accept-ranges'] || 'bytes',
          'cache-control': 'public, max-age=86400',
          'access-control-allow-origin': '*',
        };
        if (meta.headers['content-length']) out['content-length'] = meta.headers['content-length'];
        if (meta.headers['content-range']) out['content-range'] = meta.headers['content-range'];
        clientRes.writeHead(meta.status, out);
        started = true;
        const rest = buf.subarray(idx + 4);
        buf = Buffer.alloc(0);
        if (chunked) buf = rest; else if (rest.length) clientRes.write(rest);
        if (onHeaders) onHeaders(meta.status);
      });
      t.on('end', () => {
        try {
          if (chunked && started) clientRes.write(dechunk(buf));
          clientRes.end();
        } catch (e) { /* 客户端已断开忽略 */ }
      });
      t.on('error', () => { try { clientRes.end(); } catch (e) {} });
    });
    t.on('error', () => { try { clientRes.writeHead(502); clientRes.end('bad gateway'); } catch (e) {} });
  };

  if (!PROXY_HOST) { pump(null); return; }
  const conn = http.request({ host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: host + ':443' });
  conn.on('connect', (r, socket) => {
    if (r.statusCode !== 200) { socket.destroy(); clientRes.writeHead(502); clientRes.end('bad gateway'); return; }
    pump(socket);
  });
  conn.on('error', () => { try { clientRes.writeHead(502); clientRes.end('bad gateway'); } catch (e) {} });
  conn.end();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  const p = u.pathname;
  const started = Date.now();

  // 1) GraphQL 反代
  if (p.startsWith('/xapi/')) {
    const upstreamPath = '/graphql' + p.slice('/xapi/graphql'.length) + (u.search || '');
    const op = (upstreamPath.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)/) || [])[1] || '?';
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const h = {};
      let hasCookie = false;
      let hasCt0 = false;
      for (const [k, v] of Object.entries(req.headers)) {
        if (SKIP_REQ_HEADERS.has(k)) continue;
        if (k === 'x-twitter-cookie') {
          h['Cookie'] = v;
          hasCookie = true;
          const cm = /(?:^|;\s*)ct0=([^;]+)/.exec(v);
          if (cm) { h['x-csrf-token'] = cm[1].trim(); hasCt0 = true; }
          continue;
        }
        h[k] = v;
      }
      forward('api.x.com', req.method, upstreamPath, h, Buffer.concat(chunks), (err, buf) => {
        const ms = Date.now() - started;
        if (err) {
          log('XAPI', op, 'ERR', String(err));
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
          return;
        }
        const meta = parseStatus(buf);
        let body = buf.subarray(meta.headEnd);
        if ((meta.headers['transfer-encoding'] || '').includes('chunked')) body = dechunk(body);
        body = decodeBody(body, meta.headers);

        let text = body.toString('utf8');
        try {
          const j = JSON.parse(text);
          shimLegacy(j, 0);
          text = JSON.stringify(j);
        } catch (e) { /* 非 JSON，保持原样 */ }

        // 媒体域名改写成同源路径，浏览器无需直连 twimg
        text = text
          .split('https://pbs.twimg.com').join('/m')
          .split('http://pbs.twimg.com').join('/m')
          .split('https://video.twimg.com').join('/v')
          .split('http://video.twimg.com').join('/v');

        if (DUMP_DIR && op === 'UserMedia' && meta.status === 200) {
          try {
            const seq = (global.__umSeq = (global.__umSeq || 0) % 5 + 1);
            fs.writeFileSync(path.join(DUMP_DIR, 'usermedia-' + seq + '.json'), text);
          } catch (e) { /* ignore */ }
        }

        log('XAPI', op, meta.status, ms + 'ms', 'cookie=' + (hasCookie ? 'yes' : 'no'), 'ct0=' + (hasCt0 ? 'yes' : 'no'), 'len=' + text.length);
        res.writeHead(meta.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
      });
    });
    return;
  }

  // 2) 媒体反代
  if (p.startsWith('/m/') || p.startsWith('/v/')) {
    const host = p.startsWith('/m/') ? 'pbs.twimg.com' : 'video.twimg.com';
    const upstreamPath = p.slice(2) + (u.search || '');
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (SKIP_REQ_HEADERS.has(k)) continue;
      h[k] = v;
    }
    forwardStream(host, 'GET', upstreamPath, h, res, (status) => {
      log('MEDIA', host, status, (Date.now() - started) + 'ms (stream)');
    });
    return;
  }

  // 3) 静态文件
  let sp = decodeURIComponent(p);
  if (!sp || sp === '/') sp = '/index.html';
  const file = path.join(ROOT, path.normalize(sp));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache, must-revalidate' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || file.endsWith('sw.js');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': noCache ? 'no-cache, must-revalidate' : 'public, max-age=3600',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('xmd listening on http://127.0.0.1:' + PORT + (PROXY_HOST ? ' via proxy ' + PROXY_HOST + ':' + PROXY_PORT : ' (direct)'));
});
