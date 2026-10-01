# dsh-zcode-proxy

把 GLM 编码套餐（Z.AI / 智谱 BigModel）接进 DeepSeek Harness，作为一个模型 provider。

装完在 DSH 的模型选择器里出现 **ZCode** 分组，直接用你的套餐额度，不用切到别的客户端。

---

## 它解决什么

智谱的编码套餐本来只在官方客户端里能用，或者得靠一个独立代理进程 + 一堆 CLI 命令来启动和控制。这个插件把这件事做进 DSH 本身：

- **不用额外进程** —— DSH 加载插件即可
- **不用敲 CLI 控制** —— 登录在设置卡片里点一下
- **不用装 ZCode 客户端** —— 认证是插件自己走的浏览器授权
- **额度看得见** —— 卡片直接显示剩余 / 总量 / 重置时间

## 安装

`dsh plugin` 把参数原样转发给 profile 目录里的 pnpm，子命令就是 pnpm 的子命令：

```bash
# 安装（--profile 是必填项，必须放在 plugin 后面）
dsh plugin --profile web add github:IronManCantFix/dsh-zcode-proxy

# 查看该 profile 已安装的插件（转发给 pnpm list）
dsh plugin --profile web list

# 升级：重新 add 一次，带上新 tag
dsh plugin --profile web add github:IronManCantFix/dsh-zcode-proxy#v0.0.13

# 卸载
dsh plugin --profile web remove dsh-zcode-proxy
```

装完**重启 DSH**。

> **注意**：`--profile desktop` 只能由 DSH Desktop（Electron 应用）自己管理，命令行传 desktop 会直接报错；桌面版请用设置里的插件面板安装，命令行方式适用于 web、tui 等其他 profile。

安装完成后在 DSH 里：**设置 → 插件 → ZCode → Sign in**。

浏览器会打开授权页，同意后插件自动拿到凭据并保存。模型选择器里随即出现 **ZCode** 分组。

> **凭据存储建议**：设一个 `ZCODE_PROXY_CREDENTIAL_SECRET` 环境变量。不设时用的是机器派生种子，那只是混淆不是保护（见「环境变量」一节）。

### 首次自检

包里自带 CLI，不依赖 `dsh` 命令：

```bash
zcode-proxy status   # 看配置，不发网络请求
zcode-proxy doctor   # 完整体检，含一次真实调用
```

## 命令行

```bash
zcode-proxy login [--provider zai|bigmodel]   # 浏览器授权登录
zcode-proxy logout                            # 清除已保存凭据
zcode-proxy status                            # 看配置（不发网络请求）
zcode-proxy doctor                            # 完整体检（含一次真实调用）
zcode-proxy quota                             # 额度快照
zcode-proxy models                            # 当前账号可用的模型
zcode-proxy refresh-identity                  # 从本机 ZCode 重新提取身份提示词
```

所有命令都支持 `--json`。

---

## 实现说明

### 认证

插件自己跑 ZCode 的浏览器授权流程，**没有本地回调服务器**——授权页的 redirect 指向厂商自己的回调，插件只负责轮询：

```
POST {origin}/api/v1/oauth/cli/init      authorization: Bearer <64位随机hex>
  → { flow_id, poll_token, authorize_url, expires_at, poll_interval_sec }

GET  {origin}/api/v1/oauth/cli/poll/{flow_id}
  未完成 → {"data":{"status":"pending"}}
  完成   → {"data":{"status":"ready", token, <provider>: { access_token }}}
```

凭据保存在 `$DSH_HOME/zcode-proxy/credentials.json`，AES-256-GCM 加密，权限 `0600`。

### 身份提示词

向套餐端点发请求时，`system` 字段必须带上与官方客户端一致的**身份提示词**，否则网关会在到达模型前直接拒绝：

```
HTTP 405  {"code":3012,"msg":"request has been blocked due to unusual activity."}
```

这是实测结论：去掉 `system` 必然被拒；给出真实身份块则返回 200；占位块或同义改写同样被拒。

插件内置了一份快照（`src/identity-data.json`，约 1.2KB，含来源与校验和）。**这是插件里唯一的厂商文案**，且只需前两段（实测完整块 7.8KB 并非必要）。

ZCode 升级导致提示词变化时，用 `refresh-identity` 重新提取。

### 模型元数据

上下文窗口与输出上限取自 ZCode 自带的模型规则表，不是猜测：

| 模型 | 上下文 | 最大输出 | 推理等级 |
|---|---|---|---|
| GLM-5.3 / GLM-5.3-Flash | 1M | 128K | low / high / max |
| GLM-5.2 | 1M | 128K | low / high / max |
| GLM-5-Turbo / GLM-5 | 200K | 64K | disabled / enabled |
| GLM-4.7 / GLM-4.6 | 200K | 131K | disabled / enabled |

**实际提供哪些模型由账号权益决定**（读 `billing/balance` 的 `capabilities`），本表只提供元数据。

### 额度

```
GET {origin}/api/v1/zcode-plan/billing/balance
    Authorization: Bearer <plan JWT>
```

这是唯一不需要客户端签名的接口。上游对这一平面限速较严，所以卡片**不做轮询**，只在打开和手动刷新时查询。

---

## 本地文件

| 路径 | 用途 | 必需 |
|---|---|---|
| `$DSH_HOME/zcode-proxy/credentials.json` | 本插件自己的凭据 | 是 |
| `/Applications/ZCode.app/.../glm/zcode.cjs` | 仅在 `refresh-identity` 时读取 | 否 |

**运行时不会读取 ZCode 的任何文件。** 只有你主动执行 `refresh-identity` 时才会去读本机 ZCode 安装。

## 环境变量

| 变量 | 说明 |
|---|---|
| `ZCODE_PROXY_CREDENTIAL_SECRET` | 存储加密种子。**不设置时用机器派生值，那只是混淆不是保护** |
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh` |
| `ZCODE_HOME` | ZCode 数据目录，仅 `refresh-identity` 相关路径使用 |

## 开发

```bash
node --test test/*.test.js    # 98 项测试
node src/bin.js doctor        # 完整体检
```

模块划分：协议层（`credentials` / `origin` / `identity` / `oauth` / `transport`）不依赖任何 `@deepseek-ai/*` 包，可以用普通 node 直接测。

## 已知限制

- **套餐到期就不可用** —— 上游返回 `1309`，卡片会显示原因，续费后自动恢复
- **身份提示词会随 ZCode 版本漂移** —— 网关收紧校验时可能需要在装了 ZCode 的机器上重新提取
- **上游限速** —— 额度平面查询不宜频繁
- **`deviceMid`** —— 若本机有 ZCode 安装则读取其设备标识；没有时用插件自己的稳定标识

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的账号。
- 使用者需遵守智谱 / Z.AI 的服务条款。因使用本项目产生的任何后果（包括但不限于账号受限、额度清空、服务中断），由使用者自行承担。
- 本项目与智谱、Z.AI、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系。

## 许可证

MIT
