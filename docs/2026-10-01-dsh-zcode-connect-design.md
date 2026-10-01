# dsh-zcode-connect 设计文档

> 日期：2026-10-01
> 状态：待用户 review
> 目标读者：实现者（可能是未来的我或另一个 agent）

---

## 1. 要做什么

做一个 DSH 插件，把本机 ZCode 账号的 **Start Plan 免费额度**接成 DSH 的一个模型 provider，让用户在 DSH 里直接用 GLM 模型，不必切到 ZCode 客户端。

### 验收标准（v1）

1. `dsh plugin --profile desktop exec dsh-zcode-connect doctor`
   输出：凭据发现、账号身份、通道选择、握手结果、计划到期时间、额度余量。
2. DSH 模型选择器出现 **ZCode** 分组，可选 `GLM-5.3` / `GLM-5.3-Flash`。
3. **一次真实对话拿到回复**（用户明确要求 v1 就必须能用上免费额度，不是只做面板）。
4. 设置卡片显示池健康、账号、额度（总量/已用/剩余/周期）、计划到期、冷却状态。

### 硬边界

| 边界 | 说明 |
|---|---|
| 只读 `~/.zcode` | 绝不写入，不污染 ZCode 自身登录态 |
| 不做登录/扫码 | 加号的方式 = 用户在 ZCode 客户端里登录，插件自动吸收 |
| 不改 ZCode 配置 | 不替用户切换 ZCode 的连接模式 |
| 凭据不落盘明文 | 只读解密后的内存副本；不复制到 `~/.dsh` |

---

## 2. 调研结论（全部有实测证据）

本节每条结论都标注证据来源。**「实测」= 我在本机真跑过；「读码」= 从产物/源码读到；「推断」= 未验证。**

### 2.1 凭据可离线解密 —— 实测 ✅

`~/.zcode/v2/credentials.json` 的值形如 `enc:v1:<iv>.<tag>.<data>`。

```
算法：AES-256-GCM
key = sha256(secret)
secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
      ?? `zcode-credential-fallback:${platform}:${homedir}:${username}`
iv = 12 字节，tag = 16 字节，载荷 base64url
```

来源：读码 `Resources/glm/zcode.cjs` @4293021（`createZCodeCredentialCipher` / `deriveCipherKey` / `resolveCredentialSecret`）。
证据：**我按此算法成功解密了全部 6 个字段**（`zcodejwttoken`、`oauth:bigmodel:access_token`、`oauth:bigmodel:user_info`、`oauth:active_provider`、`web-remote-control:external-relay:pass_hash`、`account-provider:...:api-key`）。

**无 Keychain、无签名校验、无设备绑定。**

### 2.2 设备指纹明文可得 —— 实测 ✅

`~/.zcode/v2/onboarding-record.json` → `deviceMid`（也是 `telemetry-state.json` 里的同一个值）。
用于请求头 `X-Device-Mid`。

### 2.3 额度接口免签名 —— 实测 ✅

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
  Authorization: Bearer <zcodejwttoken>
→ 200 {"code":0,"data":{"server_time":…,"plans":[…],"balances":[…]}}
```

`balances[]` 字段（面板数据源）：

```
bucket_id, entitlement_id, plan_id, user_plan_id, show_name, meter, unit_type,
capabilities[], priority, entitlement_priority, plan_priority,
total_units, used_units, remaining_units, available_units,
period_start, period_end, expires_at
```

`plans[]` 额外给 `grant_units` / `period`（`daily` / `one_time`）/ `entitlements[]`。

**实测快照（2026-10-01 09:44）：**

| 模型 | 计划 | 总量 | 已用 | 剩余 | 周期 |
|---|---|---:|---:|---:|---|
| GLM-5.3-Flash | ZCode Trust Build (`zcode-v3-start-plan-trust-1001`) | 100,000,000 | 0 | 100,000,000 | → 10-02 00:00 |
| GLM-5.3 | ZCode Start Plan (`zcode-v3-start-plan-0817`) | 3,000,000 | 0 | 3,000,000 | 每日重置 → 10-03 23:59 |
| GLM-5.3-Flash | ZCode Start Plan (`zcode-v3-start-plan-0817`) | 5,000,000 | 0 | 5,000,000 | 每日重置 → 10-03 23:59 |

> `billing/current` 只给 `plans[].entitlements[].grant_units`（授予量），**不给用量**。
> `billing/balance` 才有 `balances[]`（用量）。**面板必须用 `balance`。**
> `billing/balance` 偶尔返回 `{"code":3001,"msg":"parameter error"}`（实测遇到 1 次，重试即 200）→ 需要重试。

### 2.4 签名特性门免签名 —— 实测 ✅

```
GET https://zcode.z.ai/api/v1/agent/configs
→ 200 {"code":0,"data":{"codingPlanSignature":{"enable":true}}}
```

### 2.5 上游有两扇门，凭据互不通用 —— 实测 ✅

| | 通道 A：`ultra` 平台网关 | 通道 B：`zcode-plan` |
|---|---|---|
| 端点 | `https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`（国内）<br>`https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`（国际） | `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` |
| 凭据 | coding-plan `api-key`（`x-api-key` 或 `Bearer`） | `zcodejwttoken`（`Bearer`） |
| 签名 | **不需要** | **强制 V4 客户端签名** |
| 实测结果 | 直达业务层，返回 `429 code=1309 套餐已到期` | 无签名 → `405 {"code":3012,"msg":"request has been blocked due to unusual activity."}` |

网关路由表来源：读码 `official-coding-plan-gateway.ts`（开源 `zai-org/ZCode`，`apps/zcode-cli/packages/adapters/src/model/`）：

```ts
OFFICIAL_CODING_PLAN_GATEWAY_ROUTES = [
  { providerEndpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra/anthropic/v1/messages" },
  { providerEndpoint: "https://api.z.ai/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra-zai/anthropic/v1/messages" },
]
```

注释原文：「请求方法、请求体、鉴权头与响应均原样透传」。

**已排除的捷径（全部实测失败）：**

| 尝试 | 结果 |
|---|---|
| `ultra` + `Bearer <jwt>` | `401 Authorization Token非法` |
| `ultra` + `x-api-key: <oauth access_token>` | 401 |
| `ultra` + `Bearer <oauth access_token>` | 401 |
| `zcode-plan` + `x-api-key: <api-key>` | 401 |
| `zcode-plan` + `Bearer <api-key>` | 401 |
| `zcode-plan/anthropic/v1/messages` + oauth | 401 |
| `/zcode-plan/chat/completions`（及 `v1/`、`models`） | 全 404 |
| 猜测的 4 个 start-plan 网关路径 | 全 404 |

### 2.6 Start Plan 模式**不需要签名** —— 实测 ✅（本次最重要的发现）

**实测证据（用户切换后的一次真实成功调用，2026-10-01 09:57）：**

```
event   : model.client_signing.unsigned_sent
message : "Client request signing skipped by provider access mode"
reason  : "access_mode"
provider: account:bigmodel-start-plan
baseURL : https://zcode.z.ai/api/v1/zcode-plan/anthropic
status  : completed（23127 tokens）
```

并且该请求的记录头里**不含任何 `X-Client-Sig` / `X-Client-Pow` / `X-App-Id`**（§9 U1 有完整头清单）。
原始日志里该事件共出现 3 次，全部为 `unsigned_sent`，无一次 `signed_sent`。

**读码佐证** —— `cRs` = `requiresClientRequestSigning`，读码 `zcode.cjs` @3725853 附近：

```js
function requiresClientRequestSigning({ access, baseURL }) {
  if (access.type === "zhipu-account" &&
      (access.mode === "start-plan" || access.mode === "off-peak"))
    return false;                                    // ← 这两条不需要签名
  if (access.type === "zhipu-coding-plan-api-key" ||
      access.type === "zhipu-account" &&
        (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan") ||
      kXe(baseURL) !== null)
    return true;
  try { return rRs.has(new URL(baseURL).hostname.toLowerCase()) } catch { return false }
}
```

`zhipu-account` 的 access 结构（读码 `zcode.cjs` @548214）只有 `accountType`（`zai`|`bigmodel`）/ `mode` / `entitled`，**没有 apiKey 字段**。

`mode` 枚举（读码 @534918）：`start-plan` | `individual-coding-plan` | `team-coding-plan` | `off-peak`。

**对本机账号的实测印证：** 本地 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表里，真实请求行的
`provider_id = account:bigmodel-start-plan`、`model_id = GLM-5.3-Flash` —— 说明该账号确实以 **start-plan 模式** 成功跑过请求。

> **结论：如果插件以 `zhipu-account` + `mode=start-plan` 的语义发请求，就走 A 门且无需签名。**
> 这是 v1 的首选路径。

### 2.7 用户的 ZCode 当前连的是哪条 —— 实测 ✅（需要用户注意）

`~/.zcode/v2/setting.json`：

```json
"providerFamilyConnectionSelections": { "bigmodel": { "kind": "individual-coding-plan" } }
```

而 `individual-coding-plan` **属于需要签名的那一类**。凭据也印证：

```
account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:<accountId>:api-key
```

所以用户当前 ZCode 客户端连的是 **individual-coding-plan（需要签名，且套餐已到期）**，不是 start-plan。
**v1 要跑通，需要用户在 ZCode 里切到 Start Plan**（或插件显式以 start-plan 语义发请求——见 §5.3）。

---

## 3. 上游协议规格

### 3.1 通道 A（首选，免签名）

```
POST https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages        # 国内 (bigmodel)
POST https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages    # 国际 (zai)

Headers:
  Content-Type: application/json
  Accept: application/json
  anthropic-version: 2023-06-01
  x-api-key: <credential>            # 或 Authorization: Bearer <credential>，两者实测均可
  User-Agent: ZCode/<version>
  X-ZCode-App-Version: <version>
  X-Title: Z Code@electron
  X-Release-Channel: production
  X-Client-Language: zh-CN
  X-Client-Timezone: Asia/Shanghai
  X-ZCode-Agent: glm
  X-Platform: darwin-arm64
  X-Os-Category: macos
  X-Os-Version: <os.release()>
  X-Device-Mid: <onboarding-record.json 的 deviceMid>
  HTTP-Referer: https://zcode.z.ai

Body: Anthropic Messages 标准体
  { model, max_tokens, messages[], system?, tools?, stream? }
```

头集合来源：读码 `zcode.cjs` 的 `iHo` / `buildCliZCodeSourceHeaders` / `createRuntimePlatformHeaders`（`Gur` 基础头 + `nHo()` 平台头）。

**baseURL 规整规则**（读码 `mRs` = `normalizeAnthropicBaseURL`）：path 不以 `/v1` 结尾则补 `/v1`，然后由 anthropic provider 再拼 `/messages`。

### 3.2 通道 B（需要签名）

同路径族 `zcode-plan`，`Authorization: Bearer <zcodejwttoken>` + V4 签名头（见 §4）。

---

## 4. V4 客户端请求签名协议（完整重建）

**本节全部来自读码**（`zcode.cjs` 偏移 840890–860200 的签名模块），并且**已实测验证到认证阶段**（见 §4.6）。

> ⚠️ 该模块**不在开源仓库里**。已确认：开源 `apps/zcode-cli/packages/adapters/src/model/` 全量清单无任何 `signing*`/`handshake*`/`pow*` 文件；开源版 `model-execution.ts` 的 `AiSdkModelExecution` 只有 `{env, network}`，而打包版还有 `codingPlanSignature`/`endpointRoutingPort`/`clientRequestSigningState`。**签名模块被刻意剔除**，故只能从产物重建。

### 4.1 常量

```
APP_ID          = "zcode"
HANDSHAKE_ACTION= "get_sign_key"
HANDSHAKE_PATH  = "/api/paas/c1f3a7e2/v2/client"     # 拼在 provider baseURL 的 origin 上
KDF_SALT        = "WD_CLIENT_SIGN_KDF_SALT"
INFO_HMAC       = "getSignKey_hmac"
INFO_PRIV       = "ed25519_priv"
POW_BITS        = 8
NONCE_BYTES     = 16        # → randomHex(16) = 32 个 hex 字符
HANDSHAKE_TIMEOUT_MS = 10000
签名头集合（重放时需先删除）:
  X-Client-Ts, X-Client-Version, X-Client-Sig, X-Client-Nonce,
  X-Client-Pow, X-App-Id, X-Client-Sign-Verified
```

### 4.2 凭据格式

```
credential   = "<apiKeyId>.<apiKeySecret>"     # 恰好一个 "."，两侧非空
apiKeyId     = credential 第一个 "." 之前
apiKeySecret = credential 第一个 "." 之后
```

读码 `Glr` = `parseClientSigningCredential` @840890：

```js
function Glr(e) {
  let t = e.indexOf(".");
  if (t <= 0 || t !== e.lastIndexOf(".") || !e.slice(0,t).trim() || !e.slice(t+1).trim()) return;
  return { apiKeyId: e.slice(0,t), apiKeySecret: e.slice(t+1), credential: e };
}
```

**实测印证**：本机 `account-provider:...:api-key` 解密后长度 49，点号 1 个，
`apiKeyId` = 32 字符，`apiKeySecret` = 16 字符。**完全符合。**

### 4.3 KDF 与基础原语

读码 `iur` = `deriveBytes`、`tur` = `createHandshakeSignature`、`rur` = `signBusinessMessage` @845301–847040：

```
deriveBytes(secret, info):                    # HKDF
  HKDF-SHA256(ikm = secret, salt = KDF_SALT, info = info, bits = 256)

handshakeSignature(secret, message):           # HMAC
  key = deriveBytes(secret, "getSignKey_hmac")
  return base64(HMAC-SHA256(key, UTF8(message)))

decryptSigningPrivateKey(passphrase, secret, privateCipherB64):
  cipher = base64decode(privateCipherB64)
  assert cipher.length > 12 + 16
  key    = deriveBytes(secret, "ed25519_priv")
  plain  = AES-GCM-decrypt(key, iv = cipher[0:12], ct = cipher[12:], aad = UTF8(passphrase))
  pkcs8  = base64decode(UTF8(plain))
  return importKey("pkcs8", pkcs8, "Ed25519")

signBusinessMessage(privateKey, message):
  return base64(Ed25519-sign(privateKey, UTF8(message)))
```

### 4.4 PoW

读码 `our` = `createClientRequestProofOfWork` @846171：

```
createClientRequestProofOfWork({ apiKeyId, appId, sessionId, ts, powBits, signal }):
  prefix = hex(sha256(UTF8(`${apiKeyId}\n${appId}\n${sessionId}\n${ts}\n`))).slice(0, 32)
  nonce  = randomHex(12)                                  # 24 hex 字符
  for counter = 0 … 0xFFFFFFFF:
    answer = `${nonce}\n${counter.toString(16).padStart(8,"0")}\n`
    if hasLeadingZeroBits(sha256(UTF8(`${prefix}\n${answer}\n`)), powBits):
      return answer
  throw
```

`hasLeadingZeroBits(hash, bits)`：前 `floor(bits/8)` 字节必须全 0；余数字节的高 `bits%8` 位必须为 0。
`powBits` 合法域 0–32；实际用 **8**（≈256 次尝试，可忽略的开销）。

### 4.5 握手

读码 `performHandshake` @854180+：

```
ts    = String(Date.now())
nonce = randomHex(16)
sig   = handshakeSignature(apiKeySecret, `get_sign_key\n${apiKeyId}\n${ts}\n${nonce}\n`)
        # 注意：这条消息【没有】尾随换行

POST <baseURL.origin>/api/paas/c1f3a7e2/v2/client
  Authorization: <credential>
  Content-Type: application/json
  body: { "apiKey": <credential>, "nonce": <nonce>, "sig": <sig>, "ts": <ts> }
  redirect: "manual", timeout: 10000ms

HTTP 必须为 200，否则失败
响应体：{ code, msg, data: { privateCipher } }
  code === 500        → 服务端错误
  code !== 200        → 业务拒绝（msg 匹配 /^HANDSHAKE_[A-Z_]+$/，例如 HANDSHAKE_INVALID_REQUEST、
                        HANDSHAKE_AUTH_FAILED）
  data.privateCipher 缺失 → 协议错误

privateKey = decryptSigningPrivateKey(apiKeyId, apiKeySecret, data.privateCipher)
```

### 4.6 业务请求签名

读码 `sendSigned` @853204+：

```
sessionId = <待发送请求的> headers["X-Session-Id"]     # 必须存在，否则 invalid-config
ts        = String(Date.now())
nonce     = randomHex(16)
pow       = createClientRequestProofOfWork({ apiKeyId, appId:"zcode", powBits:8, sessionId, ts })

sig = signBusinessMessage(privateKey, `${apiKeyId}\n${ts}\n${clientVersion}\n${sessionId}\n${nonce}\n`)
      # 注意：这条【有】尾随换行

headers["X-Client-Ts"]      = ts
headers["X-Client-Version"] = clientVersion
headers["X-Client-Sig"]     = sig
headers["X-Session-Id"]     = sessionId
headers["X-Client-Nonce"]   = nonce
headers["X-App-Id"]         = "zcode"
headers["X-Client-Pow"]     = pow
```

**两条消息的换行差异是真实的**（握手无尾随 `\n`，业务签名有）——照抄，不要"统一美化"。

### 4.7 密钥缓存与降级

读码 `KJt` / `lPe` / `cPe`：

- 私钥按 `(apiKey, handshakeUrl origin)` 缓存于 `keyState`，**无 TTL**。
- 并发请求共享同一个 `handshakePromise`。
- 401 且响应体含 `VERIFY_SIGNATURE_INVALID` 或 `VERIFY_APIKEY_EXPIRED` 时：
  使缓存的私钥失效 → 重新握手 → 重签一次（最多 2 次尝试）→ 仍失败则进入
  `bypassSigning = true`，**之后一律不签名发送**（fail-open）。
- 握手失败若 `failOpenEligible`（网络/超时/协议错误），则**不签名直接发送**。

> **这对实现很重要**：上游设计本身就允许"签名失败就裸发"。所以插件在签名路上
> 可以安全地 fail-open，不会因为签名实现不完备而彻底不可用。

### 4.8 实测验证状态

我按 §4.1–4.5 实现了握手（Node WebCrypto），对三个 origin 实测：

| origin | 结果 |
|---|---|
| `https://api.z.ai` | `200 {"code":4011,"msg":"HANDSHAKE_AUTH_FAILED"}` |
| `https://open.bigmodel.cn` | `200 {"code":4011,"msg":"HANDSHAKE_AUTH_FAILED"}` |
| `https://zcode.z.ai` | `404 page not found`（该 origin 无此路由） |

对照：用错误 body（`{"action":"get_sign_key"}`）时返回 `{"code":4001,"msg":"HANDSHAKE_INVALID_REQUEST"}`。

**结论：**
- ✅ **请求体形状正确**——`4001 INVALID_REQUEST` → `4011 AUTH_FAILED`，说明格式校验已通过，进入了认证阶段。
- ✅ 路由在 `api.z.ai` / `open.bigmodel.cn` 上存在。
- ✅ 握手 origin 由 **provider baseURL 的 origin** 决定（不是固定 `zcode.z.ai`）。
- ❌ 该凭据被拒。**与"本账号 individual-coding-plan 已到期（1309）"一致**。属**账号级**而非**协议级**失败。

---

## 5. 架构

### 5.1 双通道设计

```
DSH 会话
 └─ provider "zcode"（模型选择器分组）
      └─ pool.acquire()               选健康账号 / 判冷却
           └─ upstream.send()         按 §5.2 两维度决定端点与签名
                ├─ 通道 A：ultra 平台网关 → zcode.z.ai/api/v1/ultra{,-zai}/anthropic/v1/messages
                └─ 通道 B：zcode-plan    → zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
                     └─ SSE 流式 → DSH LlmAdapter.stream()
```

### 5.2 门选择规则

**「端点路由」与「是否需要签名」是两个正交的维度，必须分开判断。**

**维度一：端点路由**（由 baseURL 决定，走 `official-coding-plan-gateway.ts` 的改写表）

```
baseURL ∈ { https://open.bigmodel.cn/api/anthropic, https://api.z.ai/api/anthropic }
    → 改写为 https://zcode.z.ai/api/v1/ultra{,-zai}/anthropic/v1/messages
其余 baseURL → 直连，不改写
```

**维度二：是否需要签名**（由 `cRs` = `requiresClientRequestSigning` 决定）

| access.type | access.mode | 需要签名 |
|---|---|---|
| `zhipu-account` | `start-plan` | **否** |
| `zhipu-account` | `off-peak` | **否** |
| `zhipu-account` | `individual-coding-plan` | **是** |
| `zhipu-account` | `team-coding-plan` | **是** |
| `zhipu-coding-plan-api-key` | —（无此字段） | **是** |
| 其它 | — | 由 hostname 白名单 `rRs` 决定，否则否 |

来源：读码 `cRs` @3725853 附近（原文见 §2.6）。签名总是作用在**已改写后的实际发送 URL** 上。

> ⚠️ **一处实测与读码的张力，必须诚实记录**：
> 按上表，`zhipu-coding-plan-api-key` 需要签名。但我用该类型凭据（`x-api-key`）**未签名**
> 直接请求 `ultra` 网关时，**没有被 3012 拦截**，而是拿到了上游业务错误 `429 code=1309 套餐已到期`
> （§2.5 实测）。两种解释：
> (a) 网关仅在 `zcode-plan` 路由上强制签名，`ultra` 路由不强制；
> (b) 网关先做权益校验，套餐仅失效时在签名校验之前就返回 1309。
> **无法从现有证据区分。** 因此：
> - 不要据此断言「`zhipu-coding-plan-api-key` 不需要签名」；
> - 实现时对已改写为 `ultra` 的请求，**先发不签名版本，收到 3012 再升级为签名重发**——
>   这个策略在两种解释下都正确，且上游本就 fail-open（§4.7）。

**权威规则**：以 `cRs` 为准决定"是否准备好签名能力"；以运行时是否收到 `3012` 决定"本次是否真的需要签名"。

### 5.3 v1 打通的实际路径（已由实测大幅收敛）

用户在 ZCode 里切到 Start Plan 后成功调用一次，取证结论（详见 §9 U1）：

```
providerId : account:bigmodel-start-plan      ← zhipu-account + mode=start-plan
baseURL    : https://zcode.z.ai/api/v1/zcode-plan/anthropic
签名       : 无（unsigned_sent / reason=access_mode）
认证头     : 无（连脱敏占位都不存在）
结果       : completed，23127 tokens
```

**因此 v1 的实现策略已明确：**

- **不需要 V4 签名**（§4 对 Start Plan 路径无关紧要）。§4 仅在账号处于
  `individual-coding-plan` / `team-coding-plan` 时才需要。
- **不需要持有凭据**——因为客户端请求本身就不带凭据。
- **唯一尚待解决的一环是「如何让上游认账」**，两个候选方向：
  - **B1（理想）**：复用 ZCode 的本地路由/注入服务，插件只做代理。零凭据、零签名。
  - **B2（保底）**：按 MITM 抓包结果复刻下层注入。

**v1 的验收因此改为：在 DSH 里发出一次 `GLM-5.3-Flash` 对话并拿到回复，
且不产生 `3012`。** 这是可达成的，因为路径已完全确定，只剩"注入层"这一环。

---

## 6. 模块划分

每个模块单一职责、接口窄、可独立测试。协议层不依赖 DSH。

| 模块 | 职责 | 依赖 | 可测性 |
|---|---|---|---|
| `src/credentials.ts` | 发现并解密 `~/.zcode/v2/credentials.json`；读 `onboarding-record.json` 的 `deviceMid`。**纯函数** | node:crypto | fixture 密文解密 |
| `src/origin.ts` | 由凭据判定 region（`bigmodel`/`zai`），产出端点集与头集合 | — | 纯函数 |
| `src/signing.ts` | §4 的完整 V4 协议：KDF/HMAC/AES-GCM/Ed25519/PoW/握手/签名/密钥缓存/fail-open | node:crypto | 向量测试 + 真实握手 |
| `src/anthropic.ts` | Anthropic Messages 客户端：SSE 流式、头合并、错误归类 | signing | mock SSE |
| `src/billing.ts` | `billing/balance` 额度查询（带 3001 重试）+ `agent/configs` 特性门 | fetch | mock |
| `src/pool.ts` | 账号池：健康度、429/1309 冷却、冷却到期恢复、单账号边界 | 以上 | 纯状态机 |
| `src/adapter.ts` | `LlmAdapter` 实现：`stream` / `listModels` / `resolveModel` / `prepareCall` | pool | 集成 |
| `src/index.ts` | 宿主入口：注册 provider / 设置节 / HTTP 路由 | adapter | — |
| `src/client/index.tsx` | 设置卡片 | — | 手动 |
| `src/bin.ts` | CLI：`status` / `accounts` / `doctor` / `quota` / `reset` | pool | — |
| `src/status-paths.ts` | 路由路径常量，**host 与 client 两侧 import 同一份** | — | — |

**关键分层**：`credentials.ts` / `signing.ts` / `origin.ts` 不 import 任何 `@deepseek-ai/*`，
可在普通 Node 下跑测试。宿主 API 变动不影响协议层。

---

## 7. DSH 宿主 API（已对照本机真实 host 包验证）

宿主版本：读 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json` 确认。
签名来源：`@deepseek-ai/dsh-tool-cordis` 的 `lib/types/api-catalog.js`（本机真实包）。

### 7.1 插件三部件

1. `package.json` 的 `dsh` 字段：`dsh.bundle.patch` + `dsh.client.{inject, platform}`，
   并用 `exports["./client"]` 暴露浏览器 bundle。
2. `cordis.patch.yml`：把插件 `insert` 进 profile，`id` 即后续 `settingsNs` 要对齐的 entry id。
3. 两个入口：host 侧与 client 侧各自 `export const name / inject / apply(ctx, config?)`（**named exports，无 default**）。

```jsonc
// package.json 关键片段
{
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.1.5-rc.1 <0.2.0" },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-settings-plugins",
        "@deepseek-ai/dsh-client-ui-primitives",
        "@deepseek-ai/dsh-client-locale"
      ],
      "platform": "web"
    }
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: llm-zcode-connect
      name: dsh-zcode-connect
```

### 7.2 注册 provider（两个调用，缺一不成）

```ts
export const name = 'llm-zcode-connect'
export const inject = ['llm', 'settings']
export const ZCODE_SETTINGS_NS = 'zcode-connect' as SettingsNamespace

// (a) adapter —— 让模型可用
const releaseAdapter = ctx.llm.registerAdapter([ZCODE_PROVIDER_ID], adapter)
// 签名（本机验证）:
//   registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle

// (b) configurable providers —— 让模型选择器出现配置分组与发现入口
const releaseDirectory = ctx.llm.registerConfigurableProviders([{
  provider: ZCODE_PROVIDER_ID,
  displayName: 'ZCode',
  settingsNs: ZCODE_SETTINGS_NS,
  settingsPath: [],
  declared: false,
}])
// 签名（本机验证）:
//   registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle
//   LlmConfigurableProvider = { provider; displayName; settingsNs; settingsPath: readonly string[]; declared?; error? }

// 两者都必须释放
ctx.effect(() => () => { releaseAdapter?.(); releaseDirectory?.() })
```

### 7.3 模型发现

```ts
ctx.llm.registerModelDiscovery(ZCODE_SETTINGS_NS, async (request) => {
  if (request.provider !== ZCODE_PROVIDER_ID) return []
  const bal = await billing.balances()
  return bal.map(b => ({
    id: modelIdFromCapability(b.capabilities[0]),   // "model:glm-5.3" → "GLM-5.3"
    name: displayName(b.show_name),
    contextWindow: MODEL_META[...].contextWindow,
    maxTokens: MODEL_META[...].maxOutputTokens,
    inputModalities: MODEL_META[...].supportsImage ? ['text','image'] : ['text'],
  }))
})
// 签名（本机验证）:
//   registerModelDiscovery(settingsNs, discover): () => void
//   LlmDiscoveredModel = { id; name?; contextWindow?; maxTokens?; inputModalities?: readonly ModelModality[] }
```

**模型清单以 `billing/balance` 的 `capabilities` 为准**（账号真实授权），
**元数据从 ZCode 的模型规则表取**（见 §7.6）。理由：ZCode 捆绑的
`builtinProviderModelRules` 对 `account:bigmodel-start-plan` 只列了
GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo，与 `billing/balance` 的 `model:glm-5.3` 授权不一致；
以授权为准才不会少给模型。

### 7.4 设置节

**本机 host 上不存在 `settings.installSection`**（那是 0.1.5 旧线 API；`api-catalog.js` 里 grep 零结果）。当前线用：

```ts
ctx.effect(() => ctx.settings.configure({ auto: true }, ctx.fiber))
// 签名（本机验证）:
//   configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void
```

写路径用 `update(ns, patch, expectedRevision?)` / `replace(...)` / `mutate(...)`。
**没有裸 `set(key, value)`。**

变更通知：监听 `loader/volatile-update`。

> ⚠️ volatile 字段在当前线是 `{get(): T}` 活引用，settings provider 会 `structuredClone`
> 整个对象；存活的引用会导致校验失败、命名空间注册不上、**卡片静默消失**。
> 读配置一律经过 `unwrapVolatileDeep`。

### 7.5 HTTP 路由与客户端卡片

```ts
// host 侧
ctx.inject(['webServer'], (webCtx) => {
  ctx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: ZCODE_STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
      json(res, 200, await status())
    },
  }))
})
// 签名（本机验证）: register(route: WebRoute): () => void
//   WebRoute = { kind: 'exact'|'prefix'; path: string; handler(req, res): void|Promise<void> }
// 路由注册【不带】method 字段，方法分发在 handler 内自行判断
// 重复 (kind, path) 会 throw
```

```tsx
// client 侧
export const name = 'dsh-zcode-connect-client'
export const inject = ['slots', 'locale']

export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'zcode-connect',
    order: 440,
    label: () => t('row.navLabel'),
    inject: () => ({ t, settingsScope }),
  }, ZCodeCard))
}
```

要点：
- `inject` 是**硬门**，只能列两条 host 线都有的服务；`settingsScope` / `configForms`
  是同一概念的两个互斥名，**都不能写进 `inject`**，只能 `ctx.get()` 软探测。
- 槽位只投影 `id / order / label`，**没有 icon 字段**。
- `settings.plugin.item` 座位是 0.1.5-only，当前线**不存在**，注册在那里会静默无卡片。
- 卡片读数据用同源 `fetch`；写设置走槽位给的 `settingsScope.set(field, value)`。

```ts
// 浏览器 bundle 由 tsdown banner/footer 自动包裹，不要手写
banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
footer: 'return module.exports; } });',
intro:  'var module = { exports: {} }; var exports = module.exports;',
```

### 7.6 模型元数据（从 ZCode 规则表取的真实值）

来源：读 `Resources/config/provider/zcode-builtin.json`（`revision: 30`）。

规则级联：`modelRules` → `modelApiRules` → `providerSiteRules` → `templateModelRules` → `builtinProviderModelRules`。

对 GLM-5.3 系列（`modelMatch: ".*glm-5\\.3(?:-flash)?…"`）：

```
contextWindow   = 1_000_000
maxOutputTokens = 128_000
reasoningLevel  = ["low","high","max"]
  anthropic-messages 映射：
    { "thinking": { "type": "enabled" }, "output_config": { "effort": <reasoningLevel> } }

站点规则 (baseUrl = https://zcode.z.ai/api/v1/zcode-plan/anthropic):
  supportsImage = true, supportsVideo = true
GLM-5.3-Flash 额外: supportsPdf = true
GLM-5.3 本身: supportsImage = false（被站点规则覆盖为 true）
```

---

## 8. 数据流与错误处理

### 8.1 一次对话

```
DSH → LlmAdapter.stream(GenerateOptions)
  → pool.acquire()                          # 选健康账号，全冷却则等待
  → door = pickDoor(account)                # §5.2
  → [door B] signing.sign(request)          # 密钥缓存 / 按需握手 / fail-open
  → fetch(anthropicUrl, { headers, body })  # SSE
  → 逐 chunk 翻译为 StreamChunk
  → 记 usage 到池（供面板显示今日用量）
```

### 8.2 错误矩阵

| 上游信号 | 判定 | 动作 |
|---|---|---|
| `405` + `code 3012` | 签名被拒 | 重新握手重签一次；仍失败 → `bypassSigning=true` 裸发一次（上游本就 fail-open） |
| `401` + `VERIFY_SIGNATURE_INVALID` | 签名无效 | 同上 |
| `401` + `VERIFY_APIKEY_EXPIRED` | 凭据过期 | 该账号标记 `credential_expired`，不重试 |
| `401`（其它）/ `403` | 登录态失效 | 账号移出池，卡片提示「回 ZCode 重新登录」 |
| `429` + `code 1309` | 套餐到期/不可用 | 账号冷却至次日 00:00，卡片显示原文（如「GLM Coding Plan 套餐已到期」） |
| `429`（其它） | 限流 | 按 `retry-after` 或默认 60s 冷却 |
| 握手 `4011 HANDSHAKE_AUTH_FAILED` | 凭据不被接受 | 该账号禁用签名通道，回退通道 A |
| 握手超时/网络 | `failOpenEligible` | 裸发一次 |
| `400 context_length_exceeded` | 上下文溢出 | 交回 DSH 的 compaction 路径（必须输出 DSH 认得的错误措辞） |

> 最后一条的教训直接来自 xdpool 的 CHANGELOG：插件报的友好英文若不匹配
> DSH 的 `isContextWindowExceededError()`，DSH 会当成普通坏请求，
> 跳过恢复路径直接抛 400。**错误文案必须是 DSH 认得的措辞。**

---

## 9. 未决项（实现前必须解决，按重要性排序）

### U1. Start Plan 请求的认证是如何完成的（**最关键**）

**已完全查明的部分**（用户在 ZCode 里切到 Start Plan 并成功调用一次，我在 2026-10-01 09:57 之后取证）：

| 项 | 值 | 来源 |
|---|---|---|
| provider id | `account:bigmodel-start-plan` | `cli/log` 的 `model.network.completed` |
| baseURL | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | 同上 |
| 实际路径 | `…/anthropic/v1/messages` | baseURL 规整 + provider 拼 `/messages` |
| **是否签名** | **否** —— `model.client_signing.unsigned_sent`，`reason: "access_mode"`，日志原文 `"Client request signing skipped by provider access mode"` | `cli/log` |
| 模型 | `GLM-5.3-Flash`，`status: completed`，23127 tokens | `cli/db/db.sqlite` 的 `model_usage` |
| 权益解析源 | `billing/balance` → `hasActiveStartPlan: true` → `entitled: true` | `v2/logs` 的 `[coding-plan-availability]` |
| provider 全集 | 8 个：`{zai,bigmodel} × {individual-coding-plan, team-coding-plan, start-plan, offpeak-idle-plan}`；仅 `bigmodel-start-plan` 为 `entitled: true` | `v2/logs` 的 `account provider config` |

**请求头完整清单**（来自 `cli/rollout/model-io-sess_34bb7e4a-….jsonl` 的 `request.headers`，逐字）：

```
http-referer, user-agent, x-zcode-app-version, x-title, x-release-channel,
x-client-language, x-client-timezone, x-zcode-agent, x-platform, x-os-category,
x-os-version, x-request-id, x-zcode-session-type, x-zcode-trace-id,
x-query-id, x-session-id
```

**关键否证**：记录时使用的 `sanitizeModelNetworkHeaders`（开源 `runner-network-headers.ts`）是
**保名脱敏**——保留头名、把值替换为 `"[redacted]"`，且脱敏名单明确包含
`authorization` / `proxy-authorization` / `cookie` / `x-api-key` / `api-key`。

**而上述 16 个头里连 `authorization: [redacted]` 这一项都不存在。**
→ 该成功请求**确实没有携带任何认证头**（也没有 cookie、没有 api-key）。

**这推翻了我此前的推断**（原以为 `Authorization` 取自 `requestAuth.apiKey`）。实际是：
`toAiSdkProviderConfig` 对 `access.type === "zhipu-account"` **刻意排除 apiKey**，
于是 `withAnthropicAuthorizationHeader(undefined, headers)` 原样返回 headers → 不设 `Authorization`。
（与"无认证头"的观测一致。）

**推论（未验证）**：凭据由**传输层的本地路由服务**注入。bundle 中存在
`endpointRoutingPort` / `routingPort.resolve(...)` 机制（`Ban()`，见读码），会把出站请求改写到一个本地端口；
`createOfficialCodingPlanGatewayFetch` 只做网关 URL 改写，不做凭据注入，
因此注入点应在更下层（本地 host 进程）。这也解释了为何 model 层看不到任何凭据。

**未决的核心问题**：一个零凭据请求为何能被网关授权？

**解决路径（按代价排序）**：
1. **MITM 抓一次成功请求**——唯一能给出确定答案的手段。ZCode 支持 `httpProxy`，
   且自带 CA（`~/.zcode/v2/certs/zcode-network-ca.{pem,key}`）。抓包可直接看到
   网关实际收到的一切（含任何下层注入的凭据）。
2. **找到并复用 ZCode 的本地路由服务端口**——若确实存在，插件可直接把请求代理给它，
   **完全不需要处理凭据**，且天然跟随官方客户端行为。这是最理想的落地方案。
   查法：ZCode 运行时枚举其监听端口（本机 `ps` 被沙箱限制，需换手段）。
3. 在 `app.asar`（326MB）里定位凭据注入层。

**对 v1 的影响（重要）**：
- 若路径 2 成立 → v1 变成"代理到本地服务"，**零签名、零凭据处理**，风险最低。
- 若路径 1 显示凭据确实在下层某处可复现 → 按抓包结果实现。
- 无论哪条，**§4 的 V4 签名对 Start Plan 路径都不需要**（已由 `unsigned_sent` 与请求头双重证实）。
  §4 仅在走 `individual-coding-plan` / `team-coding-plan` 时才相关。


### U2. 通道 B 的成功路径验收

协议已实现并验证到认证阶段，但**本机账号套餐已到期**，无法验收「签名通过 → 拿到回复」。
需要：用户续费 / 换有效账号 / 或切到 start-plan。

### U3. Start Plan 额度是否经 `ultra` 网关发放

`billing/balance` 证明 Start Plan 有额度，但该额度是否与 `ultra` 网关的权益校验打通，未验证。
`ultra` + coding-plan api-key 返回 1309 只说明**那个套餐**到期，不能推断 Start Plan 不可用。

### U4. `X-Session-Id` 的来源

签名要求请求带 `X-Session-Id`（读码：缺失则 `invalid-config` 抛错）。
ZCode 侧该值来自会话/设备上下文；插件需确定用什么值（会话 id？设备 mid？随机稳定值？）。
API 服务器是否校验其与握手时的 `sessionId` 一致，**未验证**。

---

## 10. 测试策略

| 层 | 方式 | 覆盖 |
|---|---|---|
| `credentials` | fixture 密文解密 | 正确 secret / 错误 secret / 非 `enc:v1:` 明文 / 缺字段 |
| `origin` | 纯函数表驱动 | `bigmodel` / `zai` / `workbuddy.cc` 类国际域 |
| `signing` | 向量测试 | KDF 输出、HMAC 输入拼接、canonical 串、PoW 解的唯一性与校验、`Glr` 边界（0 个点/2 个点/空侧） |
| `signing` | 真实握手（`doctor`） | 断言错误码分类：`4001` / `4011` / 超时 / 200 |
| `anthropic` | mock SSE | 正常流 / 中途 error frame / 空 completion |
| `billing` | mock | `3001` 重试 / `balances` 缺失 / 计划过期 |
| `pool` | 纯状态机 | 冷却进入/到期/恢复；单账号；全冷却；1309 与 429 的区别 |
| `adapter` | 集成（可选真连） | `listModels` 与 `stream` |

**反向验证要求**（照 xdpool 的做法）：每加一条关键断言，都要故意破坏对应实现确认测试变红。

---

## 11. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **协议漂移**：ZCode 更新签名协议 | 中 | 协议隔离在 `signing.ts` 单模块；上游本就 fail-open，签名坏了仍可裸发 |
| **U1 未决**：start-plan 凭据形态未知 | **高** | 见 §9 U1，路径 1/2 均可解 |
| **额度不稳定**：Start Plan 到 10-03 23:59，每日重置 | 中 | 是每日重置而非一次性，可长期用；面板显示到期时间 |
| **ToS**：属非常规用法 | 中 | README 写明「仅供个人学习研究，风险自负」，与 xdpool 免责口径一致 |
| **凭据安全**：解密后持有令牌 | 中 | 只在内存；不写 `~/.dsh`；日志脱敏；不打印令牌 |
| **宿主 API 变动** | 低 | 已对照本机真实 host 包验证；`installSection` 之类旧 API 用软探测兼容 |
| **`settings.section` 静默失败** | 中 | 槽位注册包 try/catch 并 `console.error`；provider 不受卡片失败影响 |

---

## 12. 参考

- [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）——网关路由表、模型规则、`model-execution.ts` 装配。**签名模块不在其中。**
- [XDTrees/dsh-workbuddy-xdpool](https://github.com/XDTrees/dsh-workbuddy-xdpool)（MIT）——DSH 第三方 provider 插件的结构参照（provider 注册、设置卡片、同源路由、CLI 组织、免责声明口径）。
- [liu5269/zcode2api](https://github.com/liu5269/zcode2api)——同类「ZCode Coding Plan → Anthropic Messages」网关（Python）。未采用其实现，仅作存在性印证。
- 本机证据：`~/.zcode/v2/credentials.json`、`~/.zcode/v2/setting.json`、`~/.zcode/v2/onboarding-record.json`、`~/.zcode/cli/db/db.sqlite`、`/Applications/ZCode.app/Contents/Resources/{glm/zcode.cjs, config/provider/zcode-builtin.json}`、`~/.dsh/profiles/node_modules/@deepseek-ai/*`。

---

## 13. 实现顺序（供 writing-plans 展开）

1. `credentials.ts` + `origin.ts` + 单测 —— 无 DSH 依赖，可立即验证
2. `bin.ts` 的 `doctor`（只做凭据 + 额度 + 握手探测）——**先让用户看到真实数据**
3. `billing.ts` + 额度面板（先挂上设置卡片，此时还没有 provider）
4. **解决 U1**（用户切换 / MITM 抓包）—— 决定 v1 是否零签名
5. `anthropic.ts` + `adapter.ts` + `index.ts` —— provider 落地，打通一次真实对话
6. `pool.ts` 冷却与容错
7. `signing.ts`（若 U1 证实必需）—— 按 §4 实现，用 `doctor` 验证到认证阶段
8. README（中英）+ 免责声明
