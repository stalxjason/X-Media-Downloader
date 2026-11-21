# X Media Downloader · Fork

> 上游项目：[**Geek0ne/X-Media-Downloader**](https://github.com/Geek0ne/X-Media-Downloader)
> 功能说明、截图、部署到 Netlify / Cloudflare Pages 等文档请直接看上游 README，本仓库不再重复。
> **Fork 版本：v3.4.0**（上游 v3.3 + 接口适配修复）

本 fork 只做两件事：把 X 在 2025-11 更换的新接口适配好，让工具重新可用；补一个可选的本地反向代理，解决浏览器与网络层面的限制。

---

## 一、为什么 fork

X 更换前端与 GraphQL 返回结构后，上游 v3.3 直接使用会依次遇到这些问题：

| 现象 | 原因 |
|---|---|
| `{"message":"Query not found"}` | 内置 query hash 已失效 |
| `403 code 353 requires a matching csrf cookie and header` | 缺少 `x-csrf-token` 请求头 |
| `Cannot read properties of undefined (reading 'name')` | 用户对象由 `legacy.name` 改为 `core.name` |
| 抓到 0 条推文 | 时间线路径 `timeline_v2` → `timeline`，媒体首屏改为 `TimelineTimelineModule` |
| 只抓到第一页 | 翻页改为 `TimelineAddToModule`，往同一个网格模块里追加 |
| 打包时个别文件 `Failed to fetch` | 大文件/长连接偶发中断，原实现无重试 |

## 二、修改内容

### 接口适配

1. **query hash 更新**：`UserByScreenName` / `UserMedia` / `TweetDetail` 换成当前可用值，统一收敛到 `DEFAULT_QUERIES`
2. **时间线路径兼容**：同时支持 `data.user.result.timeline.timeline` 与旧的 `timeline_v2.timeline`
3. **新增两种指令解析**：`TimelineTimelineModule`（首屏 18 格网格）、`TimelineAddToModule`（翻页追加的 15 格）
4. **解包 `TweetWithVisibilityResults`**：受限推文的真实数据在 `.tweet` 下，不解包会被增量模式误判为旧推文并提前停止
5. **用户字段回退**：`legacy.*` 缺失时回退到 `core.*`（name / screen_name / id）
6. **评论接口路径容错**：兼容 `tweet_result.tweetResult` 与 `tweet_result.result`

### 抓取与下载

7. **严格按「最大推文数」截断**：原实现按整页累加，设 20 会实际抓到 33 条
8. **打包下载重试**：单个文件失败自动重试 3 次（1.5s / 3s 退避）

### 新增 `server.js`（可选，纯 Node 无依赖）

一个进程同时提供：

| 路径 | 作用 |
|---|---|
| `/` | 静态托管前端文件 |
| `/xapi/graphql` | 转发到 `api.x.com`；服务端还原 `Cookie`、按 `ct0` 派生 `x-csrf-token`、把 `core/avatar/relationship_counts` 补成 `legacy` |
| `/m` | 转发到 `pbs.twimg.com` |
| `/v` | 转发到 `video.twimg.com` |

响应里的媒体域名会被改写成同源路径（`/m`、`/v`），因此**浏览器端不需要另外挂代理**也能看图、下视频。

使用前提：`index.html` 的 `API_BASE` 指向 `/xapi/graphql`、请求头 `cookie` 改名为 `x-twitter-cookie` —— 本 fork 的 `index.html` 已经改好。

> 这一段是为了绕开两个浏览器硬限制：`api.x.com` 不返回 CORS 头；浏览器禁止 JS 设置 `Cookie` 请求头（实测即使 `--disable-web-security` 也会被剥离）。

## 三、快速开始

> ⚠️ 本 fork 的 `index.html` 把 `API_BASE` 指向了同源路径 `/xapi/graphql`，**必须有一个反代**（本地 `server.js` 或 Netlify Function）才能工作。
> 纯静态托管（没配反代）会把 `/xapi/*` 回落到 index.html，前端拿到的是 HTML，表现为「拿不到用户 / Cookie 无效 / 已无更多书签」这类误报。

### 方式 A：本地反代（推荐，国内网络）

```bash
# 直连
node server.js

# 走 HTTP 代理
XMD_PROXY_HOST=127.0.0.1 XMD_PROXY_PORT=7890 node server.js

# 打开 http://127.0.0.1:8123
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8123` | 监听端口 |
| `XMD_PROXY_HOST` | 空（直连） | 上游 HTTP 代理地址 |
| `XMD_PROXY_PORT` | `7890` | 上游 HTTP 代理端口 |
| `XMD_DUMP_DIR` | 空 | 设置后保存最近 5 次媒体时间线响应，便于排查接口变化 |

### 方式 B：Netlify（自带 Serverless 反代）

仓库已包含 `netlify/functions/xapi.js` 与 `netlify.toml` 的三条反代规则：

| 路径 | 处理 |
|---|---|
| `/xapi/*` | Netlify Function 转发到 `api.x.com`，注入 Cookie、按 ct0 派生 `x-csrf-token` |
| `/m/*` | Netlify 边缘代理到 `pbs.twimg.com` |
| `/v/*` | Netlify 边缘代理到 `video.twimg.com` |

把仓库连到 Netlify 直接部署即可，无需额外配置。

注意：Function 默认 10 秒超时、响应不宜过大；媒体走边缘代理不经过 Function，不受影响。

### 方式 C：其它静态平台

Vercel / Cloudflare Pages 需要自行实现等价的 `/xapi` 反代与 `/m`、`/v` 代理，否则同样会失败（仓库里的 `vercel.json` 目前没有对应规则）。

## 四、使用

1. 打开页面
2. 填 Cookie：`auth_token=…; ct0=…`（从已登录的 X 网页复制，**必须包含 ct0**，它是 csrf token 的来源）
3. 填用户名 → 抓取

## 五、GraphQL hash 失效时

X 会不定期轮换 hash，表现为 `{"message":"Query not found"}`。

- 页面「高级设置」可热改 4 个 hash（UserByScreenName / UserMedia / Bookmarks / Following）
- `TweetDetail` 的默认值在代码 `DEFAULT_QUERIES` 里

获取方法：登录 x.com → F12 → Network → 过滤 `graphql` → 找到对应请求，URL 里 `/graphql/<这一段的>/操作名`，中间那段就是新 hash。

## 六、已知限制

- 评论抓取（TweetDetail）与关注列表只做了路径容错，未跑完整流程验证
- 打包超大文件仍受浏览器内存限制，建议分批下载
- 仅供个人备份使用，请遵守 X 的服务条款与内容版权

## License

MIT，与上游一致。
