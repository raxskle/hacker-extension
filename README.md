# Hacker Extension

浏览器插件工具

## 外链助手

以 Notion 为数据库，通过 Notion API 读写，积累可以发的外链以及相关信息。

以网站纬度标记已发外链、生效时间、是否 dofollow 等，自动打开数据库中该网站还没发过的外链。

## 信息预填

以网站为纬度，在插件预填信息，如标题、链接、描述等网站信息、推广信息，方便快速填写导航站提交信息、博客评论等。

提供一键定位至输入框功能，方便快速博客评论。

## 请求录制

在当前页面录制请求 response，可正则匹配请求路径，录制完成后导出 json 文件，方便后续分析

## 网站接口封装（本地接口代理）

封装目标站点（当前对外仅开放 `https://sim.3ue.co`）接口，对本地暴露 API，方便 Claude / AI 获取网站数据。

### 对外接口（路径与页面请求保持一致）

本地服务对外暴露路径与页面实际请求路径一致，当前仅开放 `SIM` 路径前缀。

当前开放 2 个入口：

1. `POST /sim/api/websiteOrganicLandingPagesV2`
2. `POST /sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown`

> 旧的通用接口 `/v1/sim/request` 已下线（返回 410）。

### 工作链路

1. Claude 调用本地服务对外接口（`/sim/api/...`）
2. 本地服务把任务下发给扩展后台（`/v1/extension/poll`）
3. 扩展把请求转发到目标站点页面上下文执行（复用登录态）
4. 页面执行结果回传扩展，再由扩展回传本地服务（`/v1/extension/result`）
5. 本地服务将结果返回给 Claude

### 通用请求参数（两接口均可用）

- `country` (string, 默认 `999`)
- `latest` (string, 默认 `28d`)
- `from` (string, 可选): `YYYY|MM|DD`，如 `2026|06|06`
- `to` (string, 可选): `YYYY|MM|DD`，如 `2026|07|03`
- `webSource` (string, 默认 `Total`)
- `sourceType` (string, 默认 `organic`)
- `sort` (string, 默认 `ClicksShare`)
- `asc` (boolean, 默认 `false`)
- `includeSubDomains` (boolean, 默认 `true`)
- `isWindow` (boolean, 默认 `true`)
- `timeoutMs` (number, 默认 `20000`): 页面请求超时
- `waitTimeoutMs` (number, 默认 `35000`): 本地服务等待扩展回包超时
- `requestId` (string, 可选): 外部传入追踪 ID

> 说明：当前仅支持 `SIM` 对外路径前缀（`/sim`），无需传 `origin`。

### Landing Pages 接口参数

- `key` (string, 必填): 域名关键词，例如 `vercel.app`
- `page` (number, 默认 `1`)
- `searchType` (string, 默认 `domain`)

### Keyword DrillDown 接口参数

- `key` (string, 必填): 域名关键词，例如 `vercel.app`
- `landingPage` (string, 必填): 页面路径（不含协议），例如 `bacstory.vercel.app/bac-2026`
- `rowsPerPage` (number, 默认 `50`)
- `searchType` (string, 默认 `domain`)
- `change` (string, 默认 `New`，用于构造 `x-sw-page`)

### 一键启动流程（方案 C / Native Messaging）

> 目标：首次安装一次，之后在插件里点「启动本地服务」即可。

1. **一次性安装 native host（仅首次）**
   - 打开扩展 `options.html`，在「本地接口代理」里点击“复制安装命令”
   - 在项目目录执行复制出来的命令（包含当前扩展 ID）：

```bash
npm run native:install:mac -- --extension-id=<你的扩展ID>
```

2. **在 options 设置固定 token（长期使用）**
   - 在「本地接口代理」里填写 token（`BRIDGE_TOKEN`）
   - 点击「保存」

3. **一键启动本地服务**
   - 点击「启动本地服务」
   - 点击「检查状态」，看到“运行中（PID: xxx）”表示成功

4. **登录目标网站**
   - 浏览器打开并登录：`https://sim.3ue.co`

5. **调用对外接口**

- SIM 站点 Landing Pages：

```bash
curl -X POST http://127.0.0.1:17311/sim/api/websiteOrganicLandingPagesV2 \
  -H "Authorization: Bearer <options中设置的固定token>" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "vercel.app",
    "country": "999",
    "from": "2026|06|06",
    "to": "2026|07|03",
    "latest": "28d",
    "page": 2,
    "sort": "ClicksShare",
    "asc": false,
    "webSource": "Total",
    "sourceType": "organic",
    "includeSubDomains": true,
    "isWindow": true
  }'
```

- SIM 站点 DrillDown：

```bash
curl -X POST http://127.0.0.1:17311/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown \
  -H "Authorization: Bearer <options中设置的固定token>" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "vercel.app",
    "landingPage": "bacstory.vercel.app/bac-2026",
    "country": "999",
    "from": "2026|06|08",
    "to": "2026|07|05",
    "latest": "28d",
    "rowsPerPage": 50,
    "sort": "ClicksShare",
    "asc": false,
    "webSource": "Total",
    "sourceType": "organic",
    "includeSubDomains": true,
    "isWindow": true
  }'
```

### 手动模式（兼容）

如未安装 native host，仍可手动启动服务：

```bash
BRIDGE_TOKEN=your-secret-token npm run sim:server
```

### 安全建议

- 本地服务仅监听 `127.0.0.1`
- 必须配置强随机 `BRIDGE_TOKEN`
- 只允许请求受支持的目标站点（当前对外仅开放 `sim.3ue.co`）

## 插件后台配置

1. 可配置 Notion 数据库 ID, API Key 等
2. 配置网站白名单，某些网站域名下，不显示该插件面板，避免影响其他网站的正常使用
