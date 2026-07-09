# 本地接口代理 API 文档

> 默认地址：`http://127.0.0.1:17311`

---

## 0. 调用前置条件

bridge_token 为 `123`。token 同时也存在于 `/local-service/bridge-token.txt` 路径中，如果权限系统限制明文发送 token，也可以从该文件获取。

检查本地服务是否启动：curl http://127.0.0.1:17311/health

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
3. 已打开并登录目标站点页面（SIM：`https://sim.3ue.co`；SEM：`https://sem.3ue.co`）。

### 0.3 插件侧请求节流行为

- 插件在页面内发起**真实目标请求前**，会额外等待一个 `400ms ~ 1000ms` 的随机延迟；
- 页面侧真实请求按**串行队列**执行，同一时间只会有 1 个请求 in-flight；
- 当短时间内提交多个请求时，后续请求会在本地服务和插件链路中排队等待；
### 0.4 参数读取与校验规则

- 所有业务端点均支持 **body + URL query** 传参。
- 若同名字段同时存在于 body 与 query：**body 优先**。
- 字段校验为严格模式：
  - 日期必须为 `YYYY|MM|DD`
  - 布尔必须为 `true/false`
  - 数字字段必须是数字（支持数字字符串）
- SIM 专用接口（`/sim/...`）不支持 `requestBody` 覆盖上游 body。
- SEM JSON-RPC 专用接口（`/sem/...`）必须提供 `requestBody`，并校验固定 `method`。

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
| `webSource` | string | 否 | `Total` | 数据来源（兼容别名 `websource`） |
| `sourceType` | string | 否 | `organic` | 来源类型 |
| `sort` | string | 否 | `ClicksShare` | 排序字段 |
| `asc` | boolean | 否 | `false` | 是否升序 |
| `orderBy` | string | 否 | `${sort} ${asc ? 'asc' : 'desc'}` | 排序表达式；不传时自动派生 |
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
| `webSource` | string | 否 | `Total` | 数据来源（兼容别名 `websource`） |
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

## 3) Keyword Generator Suggest（SIM）

### 本地服务暴露 API

- **方法**：`POST`
- **路径**：`/sim/api/KeywordGenerator/google/suggest`

### 页面侧实际请求（插件在页面执行）

- **方法**：`POST`
- **URL**：`https://sim.3ue.co/api/KeywordGenerator/google/suggest?...query...`

### 使用说明

用于获取 Google Keyword Generator 的关键词建议列表。

### 请求体字段（完整）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `keyword` | string | ✅ | - | 查询关键词，例如 `image to text` |
| `country` | string | 否 | `999` | 国家/地区代码 |
| `latest` | string | 否 | `28d` | 时间窗口 |
| `from` | string | 否 | - | 起始日期，格式 `YYYY\|MM\|DD` |
| `to` | string | 否 | - | 结束日期，格式 `YYYY\|MM\|DD` |
| `isWindow` | boolean | 否 | `true` | 是否窗口模式 |
| `websource` | string | 否 | `Total` | 数据来源（兼容 `webSource`） |
| `sort` | string | 否 | `windowVolume` | 排序字段 |
| `asc` | boolean | 否 | `false` | 是否升序 |
| `orderBy` | string | 否 | `${sort} ${asc ? 'asc' : 'desc'}` | 排序表达式；不传时自动派生 |
| `rangeFilter` | string | 否 | - | 过滤条件，例如 `cpc,0.1,\|difficulty,1,80` |
| `rowsPerPage` | number | 否 | `100` | 每页条数，范围 `[1, 500]` |
| `page` | number | 否 | `1` | 页码，范围 `[1, 500]` |
| `type` | string | 否 | `Broad` | 关键词类型 |
| `timeoutMs` | number | 否 | `45000` | 页面请求超时（ms），上限 `180000` |
| `waitTimeoutMs` | number | 否 | `120000` | 本地服务等待扩展回包超时（ms），上限 `300000` |
| `requestId` | string | 否 | 自动生成 UUID | 请求追踪 ID |

### 本地调用示例（curl）

```bash
curl -X POST http://127.0.0.1:17311/sim/api/KeywordGenerator/google/suggest \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "keyword": "image to text",
    "country": "999",
    "from": "2026|06|08",
    "to": "2026|07|05",
    "isWindow": true,
    "websource": "Total",
    "sort": "windowVolume",
    "asc": false,
    "orderBy": "windowVolume desc",
    "rangeFilter": "cpc,0.1,|difficulty,1,80",
    "rowsPerPage": 100,
    "page": 2,
    "type": "Broad",
    "latest": "28d"
  }'
```

### 插件页面请求示例（真实请求）

```js
fetch("https://sim.3ue.co/api/KeywordGenerator/google/suggest?keyword=image+to+text&country=999&from=2026%7C06%7C08&to=2026%7C07%7C05&isWindow=true&websource=Total&sort=windowVolume&asc=false&orderBy=windowVolume+desc&rangeFilter=cpc%2C0.1%2C%7Cdifficulty%2C1%2C80&rowsPerPage=100&page=2&type=Broad&latest=28d", {
  "headers": {
    "accept": "application/json",
    "content-type": "application/json; charset=utf-8",
    "x-requested-with": "XMLHttpRequest",
    "x-sw-page": "https://pro.similarweb.com/#/digitalsuite/acquisition/findkeywords/keyword-generator-tool/999/28d?searchEngine=google&keyword=image%20to%20text&webSource=Total&isWWW=*&tab=phraseMatch",
    "x-sw-page-view-id": "c45a073b-7663-4808-8f68-9967c3090eb6"
  },
  "referrer": "https://sim.3ue.co/",
  "body": "[]",
  "method": "POST",
  "mode": "cors",
  "credentials": "include"
});
```

### 响应示例（已简化）

#### A. 本地服务返回（统一封装）

```json
{
  "ok": true,
  "data": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\"records\":[...],\"totalRecords\":216,...}",
    "truncated": false,
    "finalUrl": "https://sim.3ue.co/api/KeywordGenerator/google/suggest?..."
  },
  "meta": {
    "requestId": "..."
  }
}
```

#### B. `data.body` 解析后的上游响应（节选）

```json
{
  "records": [
    {
      "keyword": "imagen a texto",
      "cpc": 0.2,
      "difficulty": 50,
      "averageVolume": 126531,
      "windowVolume": 78380
    },
    {
      "keyword": "image text editor",
      "cpc": 0.22,
      "difficulty": 53,
      "averageVolume": 64524,
      "windowVolume": 56740
    }
  ],
  "totalRecords": 216,
  "totalClicks": 458833.7405290663,
  "totalVolume": 728290
}
```

---

## 4) Keywords WebAPI（SEM · ideas.GetKeywords）

### 本地服务暴露 API

- **方法**：`POST`
- **路径**：`/sem/kmtgw/v2/webapi/ideas.GetKeywords`

### 页面侧实际请求（插件在页面执行）

- **方法**：`POST`
- **URL**：`https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=...`

### 使用说明

用于代理 SEM 的 JSON-RPC 接口 `ideas.GetKeywords`。

> 该接口是**按 method 固定绑定**的专用入口，不是通用 webapi 转发接口。

### 请求体字段（完整）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `__gmitm` | string | ✅ | - | 上游请求 query 参数，必须与当前会话有效值一致（兼容别名 `gmitm`） |
| `requestBody` | object \| string | ✅ | - | JSON-RPC 请求体，`method` 必须为 `ideas.GetKeywords`；string 时需为合法 JSON |
| `timeoutMs` | number | 否 | `45000` | 页面请求超时（ms），上限 `180000` |
| `waitTimeoutMs` | number | 否 | `120000` | 本地服务等待扩展回包超时（ms），上限 `300000` |
| `requestId` | string | 否 | 自动生成 UUID | 请求追踪 ID |

### 本地调用示例（curl）

```bash
curl -X POST http://127.0.0.1:17311/sem/kmtgw/v2/webapi/ideas.GetKeywords \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "__gmitm": "ayWzA3*l4EVcTpZei43sW*qRvljSdU",
    "requestBody": {
      "id": 14,
      "jsonrpc": "2.0",
      "method": "ideas.GetKeywords",
      "params": {
        "mode": 0,
        "currency": "USD",
        "database": "us",
        "filter": {
          "phrase": [],
          "competition_level": [],
          "cpc": [
            {
              "inverted": false,
              "operation": 5,
              "value": 0.1
            }
          ],
          "difficulty": [
            {
              "inverted": false,
              "operation": 4,
              "value": 90
            }
          ],
          "results": [],
          "serp_features": [
            {
              "inverted": false,
              "value": []
            }
          ],
          "volume": [],
          "words_count": [],
          "phrase_include_logic": 0
        },
        "groups": [],
        "order": {
          "direction": 1,
          "field": "volume"
        },
        "groups_order": {
          "direction": 1,
          "field": "count"
        },
        "phrase": "image to text",
        "questions_only": false,
        "page": {
          "number": 1,
          "size": 100
        }
      }
    }
  }'
```

### 插件页面请求示例（真实请求）

```js
fetch("https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU", {
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-arch": "\"arm\"",
    "sec-ch-ua-bitness": "\"64\"",
    "sec-ch-ua-full-version": "\"149.0.7827.201\"",
    "sec-ch-ua-full-version-list": "\"Google Chrome\";v=\"149.0.7827.201\", \"Chromium\";v=\"149.0.7827.201\", \"Not)A;Brand\";v=\"24.0.0.0\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": "\"\"",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-ch-ua-platform-version": "\"14.7.8\""
  },
  "referrer": "https://sem.3ue.co/analytics/keywordmagic/?db=us&q=image+to+text&filter=H4sIAAAAAAAAA4WO3QrCMAxG3yXXRSbohX2VMUppUy1kTemfjOG727nhleDdR%2FKdnKxgeI5YfPEcFGFDAjlOAkw0PazgQ8NU0IJ0mjIK4IhJb22QVwFNU0WQw%2Bn86pD1znlTqSx%2F2cuXvQ0bGh9JZ9zde1Y%2BGKoWFfHd92cGAQlzP573VsYUlUNdah%2F%2F9h2GcdoMjanOh%2BHJyWZluIbyWb8BTzxbIAcBAAA%3D&__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
  "body": "{\"id\":14,\"jsonrpc\":\"2.0\",\"method\":\"ideas.GetKeywords\",\"params\":{\"mode\":0,\"currency\":\"USD\",\"database\":\"us\",\"filter\":{\"phrase\":[],\"competition_level\":[],\"cpc\":[{\"inverted\":false,\"operation\":5,\"value\":0.1}],\"difficulty\":[{\"inverted\":false,\"operation\":4,\"value\":90}],\"results\":[],\"serp_features\":[{\"inverted\":false,\"value\":[]}],\"volume\":[],\"words_count\":[],\"phrase_include_logic\":0},\"groups\":[],\"order\":{\"direction\":1,\"field\":\"volume\"},\"groups_order\":{\"direction\":1,\"field\":\"count\"},\"phrase\":\"image to text\",\"questions_only\":false,\"page\":{\"number\":1,\"size\":100}}}",
  "method": "POST",
  "mode": "cors",
  "credentials": "omit"
});
```

### 响应示例（结构完整，keywords 仅保留前 2 项）

#### A. 本地服务返回（统一封装）

```json
{
  "ok": true,
  "data": {
    "status": 200,
    "headers": {
      "content-type": "application/json; charset=utf-8",
      "x-service": "kmtgw.v2"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"id\":14,\"result\":{\"keywords\":[{\"phrase\":\"image to text\",\"database\":\"us\",\"volume\":60500,\"cpc\":1.91,\"competition_level\":0.01,\"difficulty\":53,\"intents\":[0],\"results\":129,\"serp_features\":[7,9,28],\"trend\":[66,54,44,66,81,81,54,66,44,54,81,66],\"snapshot_date\":\"20260620\",\"update_status\":0,\"status_updated_at\":0,\"serp_id\":\"b-h-97-0614-5215067199588878276\",\"serp_updated_at\":1781436713},{\"phrase\":\"image to text converter\",\"database\":\"us\",\"volume\":18100,\"cpc\":1.88,\"competition_level\":0.11,\"difficulty\":68,\"intents\":[0,3],\"results\":122,\"serp_features\":[7,9,28],\"trend\":[67,44,36,36,54,67,54,36,54,100,29,44],\"snapshot_date\":\"20260620\",\"update_status\":0,\"status_updated_at\":0,\"serp_id\":\"b-e-97-0617-617807360941201470\",\"serp_updated_at\":1781694311}],\"topics_enabled\":false}}",
    "truncated": false,
    "finalUrl": "https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU"
  },
  "meta": {
    "requestId": "..."
  }
}
```

#### B. `data.body` 解析后的上游响应（结构完整，keywords 仅保留前 2 项）

```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "result": {
    "keywords": [
      {
        "phrase": "image to text",
        "database": "us",
        "volume": 60500,
        "cpc": 1.91,
        "competition_level": 0.01,
        "difficulty": 53,
        "intents": [
          0
        ],
        "results": 129,
        "serp_features": [
          7,
          9,
          28
        ],
        "trend": [
          66,
          54,
          44,
          66,
          81,
          81,
          54,
          66,
          44,
          54,
          81,
          66
        ],
        "snapshot_date": "20260620",
        "update_status": 0,
        "status_updated_at": 0,
        "serp_id": "b-h-97-0614-5215067199588878276",
        "serp_updated_at": 1781436713
      },
      {
        "phrase": "image to text converter",
        "database": "us",
        "volume": 18100,
        "cpc": 1.88,
        "competition_level": 0.11,
        "difficulty": 68,
        "intents": [
          0,
          3
        ],
        "results": 122,
        "serp_features": [
          7,
          9,
          28
        ],
        "trend": [
          67,
          44,
          36,
          36,
          54,
          67,
          54,
          36,
          54,
          100,
          29,
          44
        ],
        "snapshot_date": "20260620",
        "update_status": 0,
        "status_updated_at": 0,
        "serp_id": "b-e-97-0617-617807360941201470",
        "serp_updated_at": 1781694311
      }
    ],
    "topics_enabled": false
  }
}
```

---

## 5) Keywords WebAPI Summary（SEM · ideas.GetKeywordsSummary）

### 本地服务暴露 API

- **方法**：`POST`
- **路径**：`/sem/kmtgw/v2/webapi/ideas.GetKeywordsSummary`

### 页面侧实际请求（插件在页面执行）

- **方法**：`POST`
- **URL**：`https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=...`

### 使用说明

用于获取关键词集合的汇总信息，重点是 `result.total`（相关关键词总数）。

推荐调用顺序：

1. 先调用 `ideas.GetKeywordsSummary` 获取 `total`；
2. 再按 `ideas.GetKeywords` 的分页参数（`page.size`）计算总页数；
3. 循环调用 `ideas.GetKeywords` 直到取完所有页。

> 该接口是**按 method 固定绑定**的专用入口，不是通用 webapi 转发接口。

### 请求体字段（完整）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `__gmitm` | string | ✅ | - | 上游请求 query 参数，必须与当前会话有效值一致（兼容别名 `gmitm`） |
| `requestBody` | object \| string | ✅ | - | JSON-RPC 请求体，`method` 必须为 `ideas.GetKeywordsSummary`；string 时需为合法 JSON |
| `timeoutMs` | number | 否 | `45000` | 页面请求超时（ms），上限 `180000` |
| `waitTimeoutMs` | number | 否 | `120000` | 本地服务等待扩展回包超时（ms），上限 `300000` |
| `requestId` | string | 否 | 自动生成 UUID | 请求追踪 ID |

### 本地调用示例（curl）

```bash
curl -X POST http://127.0.0.1:17311/sem/kmtgw/v2/webapi/ideas.GetKeywordsSummary \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "__gmitm": "ayWzA3*l4EVcTpZei43sW*qRvljSdU",
    "requestBody": {
      "id": 15,
      "jsonrpc": "2.0",
      "method": "ideas.GetKeywordsSummary",
      "params": {
        "mode": 0,
        "currency": "USD",
        "database": "us",
        "filter": {
          "phrase": [],
          "competition_level": [],
          "cpc": [
            {
              "inverted": false,
              "operation": 5,
              "value": 0.1
            }
          ],
          "difficulty": [
            {
              "inverted": false,
              "operation": 4,
              "value": 90
            }
          ],
          "results": [],
          "serp_features": [
            {
              "inverted": false,
              "value": []
            }
          ],
          "volume": [],
          "words_count": [],
          "phrase_include_logic": 0
        },
        "groups": [],
        "order": {
          "direction": 1,
          "field": "volume"
        },
        "groups_order": {
          "direction": 1,
          "field": "count"
        },
        "phrase": "image to text",
        "questions_only": false
      }
    }
  }'
```

### 插件页面请求示例（真实请求）

```js
fetch("https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU", {
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-arch": "\"arm\"",
    "sec-ch-ua-bitness": "\"64\"",
    "sec-ch-ua-full-version": "\"149.0.7827.201\"",
    "sec-ch-ua-full-version-list": "\"Google Chrome\";v=\"149.0.7827.201\", \"Chromium\";v=\"149.0.7827.201\", \"Not)A;Brand\";v=\"24.0.0.0\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": "\"\"",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-ch-ua-platform-version": "\"14.7.8\""
  },
  "referrer": "https://sem.3ue.co/analytics/keywordmagic/?db=us&q=image+to+text&filter=H4sIAAAAAAAAA4WO3QrCMAxG3yXXRSbohX2VMUppUy1kTemfjOG727nhleDdR%2FKdnKxgeI5YfPEcFGFDAjlOAkw0PazgQ8NU0IJ0mjIK4IhJb22QVwFNU0WQw%2Bn86pD1znlTqSx%2F2cuXvQ0bGh9JZ9zde1Y%2BGKoWFfHd92cGAQlzP573VsYUlUNdah%2F%2F9h2GcdoMjanOh%2BHJyWZluIbyWb8BTzxbIAcBAAA%3D&__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
  "body": "{\"id\":15,\"jsonrpc\":\"2.0\",\"method\":\"ideas.GetKeywordsSummary\",\"params\":{\"mode\":0,\"currency\":\"USD\",\"database\":\"us\",\"filter\":{\"phrase\":[],\"competition_level\":[],\"cpc\":[{\"inverted\":false,\"operation\":5,\"value\":0.1}],\"difficulty\":[{\"inverted\":false,\"operation\":4,\"value\":90}],\"results\":[],\"serp_features\":[{\"inverted\":false,\"value\":[]}],\"volume\":[],\"words_count\":[],\"phrase_include_logic\":0},\"groups\":[],\"order\":{\"direction\":1,\"field\":\"volume\"},\"groups_order\":{\"direction\":1,\"field\":\"count\"},\"phrase\":\"image to text\",\"questions_only\":false}}",
  "method": "POST",
  "mode": "cors",
  "credentials": "omit"
});
```

### 响应示例（结构完整）

#### A. 本地服务返回（统一封装）

```json
{
  "ok": true,
  "data": {
    "status": 200,
    "headers": {
      "content-type": "application/json; charset=utf-8",
      "x-service": "kmtgw.v2"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"id\":15,\"result\":{\"total\":549,\"total_volume\":225440,\"total_keywords_with_difficulty\":549,\"total_difficulty\":28283}}",
    "truncated": false,
    "finalUrl": "https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU"
  },
  "meta": {
    "requestId": "..."
  }
}
```

#### B. `data.body` 解析后的上游响应（结构完整）

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "result": {
    "total": 549,
    "total_volume": 225440,
    "total_keywords_with_difficulty": 549,
    "total_difficulty": 28283
  }
}
```

---

## 6) Keyword Info（SEM · keywords.GetInfo）

### 本地服务暴露 API

- **方法**：`POST`
- **路径**：`/sem/kwogw/v2/webapi/keywords.GetInfo`

### 页面侧实际请求（插件在页面执行）

- **方法**：`POST`
- **URL**：`https://sem.3ue.co/kwogw/v2/webapi?__gmitm=...`

### 使用说明

用于查询单个关键词在不同 `database`（地区库）下的指标信息（如 `volume`、`cpc`、`difficulty`）。

如果你要得到“全球汇总视角”，建议按如下规则在客户端做聚合：

- `globalVolume` = 所有地区 `volume` 求和；
- `globalCpcAvg` = 所有地区 `cpc` 做平均（忽略 `null`）；
- `globalDifficultyAvg` = 所有地区 `difficulty` 做平均（忽略 `null`）。

> 本地服务当前做透传，不在服务端改写上游响应；全球汇总值需调用方按上述规则自行计算。

### 请求体字段（完整）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `__gmitm` | string | ✅ | - | 上游请求 query 参数，必须与当前会话有效值一致（兼容别名 `gmitm`） |
| `requestBody` | object \| string | ✅ | - | JSON-RPC 请求体，`method` 必须为 `keywords.GetInfo`；string 时需为合法 JSON |
| `timeoutMs` | number | 否 | `45000` | 页面请求超时（ms），上限 `180000` |
| `waitTimeoutMs` | number | 否 | `120000` | 本地服务等待扩展回包超时（ms），上限 `300000` |
| `requestId` | string | 否 | 自动生成 UUID | 请求追踪 ID |

### 本地调用示例（curl）

```bash
curl -X POST http://127.0.0.1:17311/sem/kwogw/v2/webapi/keywords.GetInfo \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "__gmitm": "ayWzA3*l4EVcTpZei43sW*qRvljSdU",
    "requestBody": {
      "id": 32,
      "jsonrpc": "2.0",
      "method": "keywords.GetInfo",
      "params": {
        "phrase": "image to text",
        "device": 0,
        "currency": "USD",
        "database": "us",
        "locati0n": 0,
        "date": ""
      }
    }
  }'
```

### 插件页面请求示例（真实请求）

```js
fetch("https://sem.3ue.co/kwogw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU", {
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-arch": "\"arm\"",
    "sec-ch-ua-bitness": "\"64\"",
    "sec-ch-ua-full-version": "\"149.0.7827.201\"",
    "sec-ch-ua-full-version-list": "\"Google Chrome\";v=\"149.0.7827.201\", \"Chromium\";v=\"149.0.7827.201\", \"Not)A;Brand\";v=\"24.0.0.0\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": "\"\"",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-ch-ua-platform-version": "\"14.7.8\""
  },
  "referrer": "https://sem.3ue.co/analytics/keywordoverview/?db=us&q=text+images&__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
  "body": "{\"id\":32,\"jsonrpc\":\"2.0\",\"method\":\"keywords.GetInfo\",\"params\":{\"phrase\":\"image to text\",\"device\":0,\"currency\":\"USD\",\"database\":\"us\",\"locati0n\":0,\"date\":\"\"}}",
  "method": "POST",
  "mode": "cors",
  "credentials": "omit"
});
```

### 响应示例（结构完整，keywords 仅保留前 2 项）

#### A. 本地服务返回（统一封装）

```json
{
  "ok": true,
  "data": {
    "status": 200,
    "headers": {
      "content-type": "application/json; charset=utf-8",
      "x-service": "kwogw.v2"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"id\":32,\"result\":{\"keywords\":[{\"phrase\":\"image to text\",\"database\":\"ae\",\"locati0n\":0,\"volume\":6600,\"cpc\":null,\"competition_level\":null,\"difficulty\":null,\"rds_median\":null,\"intents\":[],\"results\":null,\"serp_features\":[],\"trend\":null,\"serp_id\":\"\",\"serp_updated_at\":0,\"cleaned_phrase\":\"image to text\",\"exact_match\":true,\"update_status\":0,\"status_updated_at\":0},{\"phrase\":\"image to text\",\"database\":\"af\",\"locati0n\":0,\"volume\":480,\"cpc\":null,\"competition_level\":null,\"difficulty\":null,\"rds_median\":null,\"intents\":[],\"results\":null,\"serp_features\":[],\"trend\":null,\"serp_id\":\"\",\"serp_updated_at\":0,\"cleaned_phrase\":\"image to text\",\"exact_match\":true,\"update_status\":0,\"status_updated_at\":0}]}}",
    "truncated": false,
    "finalUrl": "https://sem.3ue.co/kwogw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU"
  },
  "meta": {
    "requestId": "..."
  }
}
```

#### B. `data.body` 解析后的上游响应（结构完整，keywords 仅保留前 2 项）

```json
{
  "jsonrpc": "2.0",
  "id": 32,
  "result": {
    "keywords": [
      {
        "phrase": "image to text",
        "database": "ae",
        "locati0n": 0,
        "volume": 6600,
        "cpc": null,
        "competition_level": null,
        "difficulty": null,
        "rds_median": null,
        "intents": [],
        "results": null,
        "serp_features": [],
        "trend": null,
        "serp_id": "",
        "serp_updated_at": 0,
        "cleaned_phrase": "image to text",
        "exact_match": true,
        "update_status": 0,
        "status_updated_at": 0
      },
      {
        "phrase": "image to text",
        "database": "af",
        "locati0n": 0,
        "volume": 480,
        "cpc": null,
        "competition_level": null,
        "difficulty": null,
        "rds_median": null,
        "intents": [],
        "results": null,
        "serp_features": [],
        "trend": null,
        "serp_id": "",
        "serp_updated_at": 0,
        "cleaned_phrase": "image to text",
        "exact_match": true,
        "update_status": 0,
        "status_updated_at": 0
      }
    ]
  }
}
```

### 全球汇总计算示例（调用方侧）

```js
const keywords = parsed.result?.keywords ?? [];
const globalVolume = keywords.reduce((sum, item) => sum + (Number(item.volume) || 0), 0);

const cpcValues = keywords
  .map((item) => (typeof item.cpc === 'number' ? item.cpc : null))
  .filter((v) => v !== null);
const globalCpcAvg = cpcValues.length
  ? cpcValues.reduce((sum, v) => sum + v, 0) / cpcValues.length
  : null;

const kdValues = keywords
  .map((item) => (typeof item.difficulty === 'number' ? item.difficulty : null))
  .filter((v) => v !== null);
const globalDifficultyAvg = kdValues.length
  ? kdValues.reduce((sum, v) => sum + v, 0) / kdValues.length
  : null;
```

---

## 7) 其他接口

### 7.1 健康检查

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
      "/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown",
      "/sim/api/KeywordGenerator/google/suggest",
      "/sem/kmtgw/v2/webapi/ideas.GetKeywords",
      "/sem/kmtgw/v2/webapi/ideas.GetKeywordsSummary",
      "/sem/kwogw/v2/webapi/keywords.GetInfo"
    ],
    "targetPath": "/api/websiteOrganicLandingPagesV2"
  }
}
```

### 7.2 已下线通用接口

- **方法**：`POST`
- **路径**：`/v1/sim/request`
- **说明**：固定返回 `410`（已下线）

### 7.3 扩展内部接口（不建议 AI 直接调用）

- `POST /v1/extension/poll`
- `POST /v1/extension/result`

---

## 8) 常见错误码

- `AUTH_FAILED`：token 无效（401）
- `INVALID_JSON`：JSON 解析失败（400）
- `INVALID_PARAMS`：参数不合法（400）
- `INVALID_METHOD`：方法不支持（400）
- `UPSTREAM_ERROR`：页面侧执行失败（502）
- `TIMEOUT`：等待扩展/页面结果超时（504）
