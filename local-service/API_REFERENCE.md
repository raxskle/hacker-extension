# 本地接口代理 API 文档

> 默认地址：`http://127.0.0.1:17311`

---

## 0. 调用前置条件

bridge_token 为 `123`。token 同时也存在于 `/local-service/bridge-token.txt` 路径中，如果权限系统限制明文发送 token，也可以从该文件获取。

！！！必须遵循：任何 AI 调用都必须调用本地服务，不能直接调用目标站点。目标站点请求仅仅通过本地服务转发到浏览器插件，由插件在页面内执行。

### 0.1 鉴权（所有业务接口必填）

```http
Authorization: Bearer 123
Content-Type: application/json
```

鉴权失败响应：

```json
{
  "ok": false,
  "error": { "code": "AUTH_FAILED", "message": "token 无效" }
}
```

### 0.2 运行前提

1. 本地服务已启动；
2. 浏览器扩展已安装并运行；
3. 已打开并登录 `https://sim.3ue.co` 页面。

### 0.3 插件侧请求节流行为

- 插件在页面内发起**真实目标请求前**，会额外等待一个 `400ms ~ 1000ms` 的随机延迟；
- 页面侧真实请求按**串行队列**执行，同一时间只会有 1 个请求 in-flight；
- 当短时间内提交多个请求时，后续请求会在本地服务和插件链路中排队等待；
- 因为存在排队与延迟，建议按需调大 `waitTimeoutMs`。

---

## 1) Landing Pages 列表（SIM）

### 本地服务暴露 API

- **方法**：`POST`
- **路径**：`/sim/api/websiteOrganicLandingPagesV2`

### 页面侧实际请求（插件在页面执行）

- **方法**：`POST`
- **URL**：`https://sim.3ue.co/api/websiteOrganicLandingPagesV2?...query...`

### 使用说明

用于查询目标域名在 SIM 的 Organic Landing Pages 列表。

### 请求体字段（完整）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `key` | string | ✅ | - | 域名关键词，例如 `vercel.app` |
| `country` | string | 否 | `999` | 国家/地区代码 |
| `latest` | string | 否 | `28d` | 时间窗口 |
| `from` | string | 否 | - | 起始日期，格式 `YYYY\|MM\|DD` |
| `to` | string | 否 | - | 结束日期，格式 `YYYY\|MM\|DD` |
| `webSource` | string | 否 | `Total` | 数据来源 |
| `sourceType` | string | 否 | `organic` | 来源类型 |
| `sort` | string | 否 | `ClicksShare` | 排序字段 |
| `asc` | boolean | 否 | `false` | 是否升序 |
| `includeSubDomains` | boolean | 否 | `true` | 是否包含子域名 |
| `isWindow` | boolean | 否 | `true` | 是否窗口模式 |
| `page` | number | 否 | `1` | 页码，范围 `[1, 500]` |
| `searchType` | string | 否 | `domain` | 查询类型（用于构造 `pageFilterJson`） |
| `timeoutMs` | number | 否 | `45000` | 页面请求超时（ms），上限 `180000` |
| `waitTimeoutMs` | number | 否 | `120000` | 本地服务等待扩展回包超时（ms），上限 `300000` |
| `requestId` | string | 否 | 自动生成 UUID | 请求追踪 ID |

### 本地调用示例（curl）

```bash
curl -X POST http://127.0.0.1:17311/sim/api/websiteOrganicLandingPagesV2 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "vercel.app",
    "country": "999",
    "to": "2026|07|05",
    "from": "2026|06|08",
    "isWindow": true,
    "webSource": "Total",
    "sort": "ClicksShare",
    "asc": false,
    "sourceType": "organic",
    "includeSubDomains": true,
    "page": 2,
    "latest": "28d"
  }'
```

### 插件页面请求示例（真实请求）

```js
fetch("https://sim.3ue.co/api/websiteOrganicLandingPagesV2?country=999&to=2026%7C07%7C05&from=2026%7C06%7C08&isWindow=true&webSource=Total&key=vercel.app&pageFilterJson=%5B%7B%22url%22%3A%22vercel.app%22%2C%22searchType%22%3A%22domain%22%7D%5D&sort=ClicksShare&asc=false&Change=New&sourceType=organic&includeSubDomains=true&orderBy=ClicksShare+desc&page=2&latest=28d", {
  "headers": {
    "accept": "application/json",
    "content-type": "application/json; charset=utf-8",
    "x-requested-with": "XMLHttpRequest",
    "x-sw-page": "https://pro.similarweb.com/#/organicsearch/pageAnalysis/landing-pages-v2/*/999/28d?key=vercel.app&pageFilter=%5B%7B%22url%22%3A%22vercel.app%22%2C%22searchType%22%3A%22domain%22%7D%5D&webSource=Total&Change=New&selectedPageTab=Organic",
    "x-sw-page-view-id": "f399efbf-86f7-4427-ab2d-c8e8fd043ac8"
  },
  "referrer": "https://sim.3ue.co/",
  "body": "",
  "method": "POST",
  "mode": "cors",
  "credentials": "include"
});
```

### 响应示例

#### A. 本地服务返回（统一封装）

```json
{
  "ok": true,
  "data": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\"FromAlternativeSources\":false,\"TotalCount\":11488,...}",
    "truncated": false,
    "finalUrl": "https://sim.3ue.co/api/websiteOrganicLandingPagesV2?..."
  },
  "meta": {
    "requestId": "..."
  }
}
```

#### B. `data.body` 解析后的上游响应（节选）

```json
{
  "FromAlternativeSources": false,
  "TotalCount": 11488,
  "TotalTopLevelCount": 0,
  "Data": [
    {
      "Url": "luggage-storage-nu.vercel.app/pages/moscow-paveletsky-railway-station",
      "Clicks": 630,
      "ClicksShare": 0.00048382637544926735,
      "TopKeyword": "москва павелецкий вокзал где сдать багаж дешево"
    },
    {
      "Url": "tasca.vercel.app",
      "Clicks": 610,
      "ClicksShare": 0.00046846680797468744,
      "TopKeyword": "tasca tv"
    }
  ]
}
```

---

## 2) Landing Page 关键词 DrillDown（SIM）

### 本地服务暴露 API

- **方法**：`POST`
- **路径**：`/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown`

### 页面侧实际请求（插件在页面执行）

- **方法**：`GET`
- **URL**：`https://sim.3ue.co/api/websiteOrganicLandingPagesV2/GetTableDrillDown?...query...`

### 使用说明

基于某个 `landingPage` 拉取关键词 DrillDown 数据。

### 请求体字段（完整）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `key` | string | ✅ | - | 域名关键词，例如 `vercel.app` |
| `landingPage` | string | ✅ | - | 页面路径（不含协议），如 `bacstory.vercel.app/bac-2026` |
| `country` | string | 否 | `999` | 国家/地区代码 |
| `latest` | string | 否 | `28d` | 时间窗口 |
| `from` | string | 否 | - | 起始日期，格式 `YYYY\|MM\|DD` |
| `to` | string | 否 | - | 结束日期，格式 `YYYY\|MM\|DD` |
| `webSource` | string | 否 | `Total` | 数据来源 |
| `sourceType` | string | 否 | `organic` | 来源类型 |
| `sort` | string | 否 | `ClicksShare` | 排序字段 |
| `asc` | boolean | 否 | `false` | 是否升序 |
| `rowsPerPage` | number | 否 | `50` | 每页条数，范围 `[1, 500]` |
| `includeSubDomains` | boolean | 否 | `true` | 是否包含子域名 |
| `isWindow` | boolean | 否 | `true` | 是否窗口模式 |
| `searchType` | string | 否 | `domain` | 查询类型（用于构造页面上下文） |
| `change` | string | 否 | `New` | 用于构造 `x-sw-page` |
| `timeoutMs` | number | 否 | `45000` | 页面请求超时（ms），上限 `180000` |
| `waitTimeoutMs` | number | 否 | `120000` | 本地服务等待扩展回包超时（ms），上限 `300000` |
| `requestId` | string | 否 | 自动生成 UUID | 请求追踪 ID |

### 本地调用示例（curl）

```bash
curl -X POST http://127.0.0.1:17311/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "vercel.app",
    "landingPage": "luggage-storage-nu.vercel.app/pages/moscow-paveletsky-railway-station",
    "country": "999",
    "webSource": "Total",
    "includeSubDomains": true,
    "to": "2026|07|05",
    "from": "2026|06|08",
    "isWindow": true,
    "rowsPerPage": 50,
    "sort": "ClicksShare",
    "asc": false,
    "sourceType": "organic",
    "latest": "28d"
  }'
```

### 插件页面请求示例（真实请求）

```js
fetch("https://sim.3ue.co/api/websiteOrganicLandingPagesV2/GetTableDrillDown?country=999&webSource=Total&includeSubDomains=true&to=2026%7C07%7C05&from=2026%7C06%7C08&isWindow=true&landingPage=luggage-storage-nu.vercel.app%2Fpages%2Fmoscow-paveletsky-railway-station&rowsPerPage=50&key=vercel.app&sort=ClicksShare&asc=false&sourceType=organic&latest=28d", {
  "headers": {
    "accept": "application/json",
    "content-type": "application/json; charset=utf-8",
    "x-requested-with": "XMLHttpRequest",
    "x-sw-page": "https://pro.similarweb.com/#/organicsearch/pageAnalysis/landing-pages-v2/*/999/28d?key=vercel.app&pageFilter=%5B%7B%22url%22%3A%22vercel.app%22%2C%22searchType%22%3A%22domain%22%7D%5D&webSource=Total&Change=New&selectedPageTab=Organic",
    "x-sw-page-view-id": "ff7ca55c-ae02-4671-ab71-e199fffff52f"
  },
  "referrer": "https://sim.3ue.co/",
  "body": null,
  "method": "GET",
  "mode": "cors",
  "credentials": "include"
});
```

### 响应示例

#### A. 本地服务返回（统一封装）

```json
{
  "ok": true,
  "data": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\"TotalCount\":1,\"Data\":[...]}",
    "truncated": false,
    "finalUrl": "https://sim.3ue.co/api/websiteOrganicLandingPagesV2/GetTableDrillDown?..."
  },
  "meta": {
    "requestId": "..."
  }
}
```

#### B. `data.body` 解析后的上游响应（示例）

```json
{
  "TotalCount": 1,
  "Data": [
    {
      "Keyword": "москва павелецкий вокзал где сдать багаж дешево",
      "Clicks": 630,
      "ClicksShare": 1,
      "ClicksChange": 0,
      "PreviousClicks": 0,
      "SerpFeatures": [],
      "Volume": 0,
      "AverageVolume": 0,
      "Cpc": 0,
      "KeywordCount": 1,
      "PreviousPosition": 0,
      "DesktopClicks": 630,
      "ClicksChangePresentation": "New",
      "ChangeState": 4
    }
  ]
}
```

---

## 3) 其他接口

### 3.1 健康检查

- **方法**：`GET`
- **路径**：`/health`

示例返回：

```json
{
  "ok": true,
  "data": {
    "status": "up",
    "pendingJobs": 0,
    "waitingResults": 0,
    "waitingPollers": 0,
    "exposedEndpoint": "/sim/api/websiteOrganicLandingPagesV2",
    "exposedEndpoints": [
      "/sim/api/websiteOrganicLandingPagesV2",
      "/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown"
    ],
    "targetPath": "/api/websiteOrganicLandingPagesV2"
  }
}
```

### 3.2 已下线通用接口

- **方法**：`POST`
- **路径**：`/v1/sim/request`
- **说明**：固定返回 `410`（已下线）

### 3.3 扩展内部接口（不建议 AI 直接调用）

- `POST /v1/extension/poll`
- `POST /v1/extension/result`

---

## 4) 常见错误码

- `AUTH_FAILED`：token 无效（401）
- `INVALID_JSON`：JSON 解析失败（400）
- `INVALID_PARAMS`：参数不合法（400）
- `INVALID_METHOD`：方法不支持（400）
- `UPSTREAM_ERROR`：页面侧执行失败（502）
- `TIMEOUT`：等待扩展/页面结果超时（504）
