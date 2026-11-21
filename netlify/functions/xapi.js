/**
 * Netlify Function：把 /xapi/* 代理到 api.x.com
 *
 * 静态托管没有反代，而浏览器既拿不到 api.x.com 的 CORS 头、
 * 也不允许 JS 设置 Cookie 请求头，所以必须由服务端转发。
 * 这里做三件事：
 *   1. 还原 Cookie（前端用 x-twitter-cookie 传到这一层）
 *   2. 从 ct0 派生 x-csrf-token
 *   3. 把响应里的媒体域名改写成 /m、/v（由 netlify.toml 的 redirect 代理）
 */

const API_HOST = 'api.x.com';

// 用新接口的 core / avatar / relationship_counts 合成旧的 legacy 结构
function shimLegacy(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 60) return;
  if (Array.isArray(node)) {
    for (const it of node) shimLegacy(it, (depth || 0) + 1);
    return;
  }
  const core = node.core;
  const rid = node.rest_id;
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
  for (const k of Object.keys(node)) {
    if (k !== 'legacy') shimLegacy(node[k], (depth || 0) + 1);
  }
}

const DROP = new Set([
  'host', 'connection', 'content-length', 'cookie', 'origin', 'referer',
  'accept-encoding', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-nf-client-connection-ip', 'x-nf-request-id', 'x-nf-account-id',
]);

exports.handler = async (event) => {
  const qs0 = event.queryStringParameters || {};

  // 反代路径有两条来源：redirect 注入的 __p，或原始 URL 里的 /xapi/ 之后部分
  let rel = qs0.__p || '';
  if (!rel && event.rawUrl) {
    const m = /\/xapi\/([^?#]*)/.exec(event.rawUrl);
    if (m) rel = m[1];
  }
  if (!rel && event.path && event.path.startsWith('/xapi/')) {
    rel = event.path.slice('/xapi/'.length);
  }
  const upstreamPath = '/' + rel;

  const params = new URLSearchParams(qs0);
  params.delete('__p');
  const qs = params.toString();
  const url = 'https://' + API_HOST + upstreamPath + (qs ? '?' + qs : '');

  const headers = {};
  const incoming = event.headers || {};
  let hasCookie = false;
  let hasCt0 = false;

  for (const k of Object.keys(incoming)) {
    const lk = k.toLowerCase();
    if (DROP.has(lk)) continue;
    if (lk === 'x-twitter-cookie') {
      headers.cookie = incoming[k];
      hasCookie = true;
      const m = /(?:^|;\s*)ct0=([^;]+)/.exec(incoming[k]);
      if (m) {
        headers['x-csrf-token'] = m[1].trim();
        hasCt0 = true;
      }
      continue;
    }
    headers[lk] = incoming[k];
  }

  try {
    const res = await fetch(url, {
      method: event.httpMethod || 'GET',
      headers,
      body: event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined,
    });
    let text = await res.text();

    try {
      const j = JSON.parse(text);
      shimLegacy(j, 0);
      text = JSON.stringify(j);
    } catch (e) { /* 非 JSON 原样返回 */ }

    text = text
      .split('https://pbs.twimg.com').join('/m')
      .split('http://pbs.twimg.com').join('/m')
      .split('https://video.twimg.com').join('/v')
      .split('http://video.twimg.com').join('/v');

    console.log('xapi', event.httpMethod, upstreamPath, res.status, 'cookie=' + hasCookie, 'ct0=' + hasCt0, 'len=' + text.length);

    return {
      statusCode: res.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
      body: text,
    };
  } catch (e) {
    console.log('xapi error', String(e));
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: String(e) }),
    };
  }
};
