# 内盘一键买卖（Agentic 钱包签名）

本地网页 + 本地签名桥：粘贴代币 CA → 自动解析 Market / Probe / Quote → 点一次按钮买入或卖出。

**签名方是币安 Agentic 钱包**（`baw` CLI 的 dev-mode `contract-call`），不是普通 EOA。
这类内盘在 Market 侧校验 Agent，MetaMask 之类的普通钱包即使有余额也买不进去。

## 架构

```
浏览器 (index.html + protocol.js)
   │  POST /api/send { to, data }   ← 只允许白名单调用
   ▼
本地桥 (serve.mjs, 127.0.0.1:8787)
   │  baw contract-call preview --from <Agentic 钱包> --inputData <data>
   │  baw contract-call execute --requestId <id>
   ▼
BSC 链上（Portal.buyWithQuote / Portal.sellBps / QUOTE.approve）
```

浏览器里不需要装任何钱包扩展，也拿不到私钥；签名只在 `baw` 里发生。

## 启动

```powershell
node serve.mjs
# 打开 http://127.0.0.1:8787
```

前置条件：`baw` 已安装且 `baw wallet status` 为 `CONNECTED`（`~/.baw` 里已有会话）。

`baw` 的定位顺序：环境变量 `BAW_CLI`（指向 `dist/index.js`）→ PATH 里的 `baw`。

## 隐私

这个压缩包里**没有任何**私钥、助记词、会话 token、cookie 或 `~/.baw` 文件——签名永远发生在你本机的 `baw` 里，包里只有代码。

- 页面里的 `__BRIDGE_TOKEN__` 是占位符，`serve.mjs` 每次启动随机生成后注入，只用于「本页 ↔ 本地桥」鉴权，不落盘、不复用
- 示例脚本的 `WALLET` 默认是 `0x000…000`；要跑真实调用请自己传：`WALLET=0x你的地址 node verify.mjs`
- `serve.mjs` 只监听 `127.0.0.1`，不对外网开放
- `ui.png` 是未连接状态的界面截图，不含地址


## 使用

1. 「连接」→ 顶部显示钱包、baw 会话、链
2. 填代币 CA → 「解析」（回车也行）→ 显示 Market / Probe / 代币 / PHASE / 余额
3. 买入：填金额或用 **10% / 25% / 50% / 全部**（按钱包余额算，原生池会预留 0.002 BNB gas）→ 关掉「预演」→ 买入 → 弹窗确认 → 执行
4. 卖出：切到「卖出」页签 → 填比例 → 卖出
5. 实时预估：输入金额时自动调用 `quoteBuyProbe` / `sellPlanCustomProbe`，显示预计份额、手续费、最少接受

「预演模式」默认开启，且会真的走一遍钱包级模拟（`previewOnly`），不是只拼 calldata。

## BNB 自动换汇买入（8788 开发版）

标准 Portal/Probe 买入框和 four.meme 买入框都支持两种计价方式：

- **BNB（自动换算）**：输入 BNB → 用 `baw market-order quote` 显示 `≈ X 计价币` → 确认后先换汇，等订单 `FINISHED` + 链上收据，刷新余额，再把实际到账的计价币全部用于原有买入。
- **直接输入计价币**：保持原流程，只花钱包里已有的计价币。

执行约束：

- 换汇失败（包括 `ORDER_API_ERROR`）原样透传 CLI 错误，不重试、不买入。
- 换汇成功但买入失败时明确提示 `已换得 X 计价币，未买入`，换到的币留在钱包，不自动重试。
- 预演模式只查换汇报价，不换汇、不买入。

桥接口：

```text
POST /api/swap/quote   { "toToken": "0x计价币", "amount": "0.01" }
POST /api/swap         { "toToken": "0x计价币", "amount": "0.01" }
```

`/api/swap` 只允许 BNB → 白名单计价币（BNCB / BNC4 / USDT / USDC / U / USD1）；确实需要新增时，用环境变量显式扩展：

```powershell
$env:BAW_SWAP_QUOTES="0x地址:符号,0x地址:符号"
```

`/api/swap` 会轮询 `market-order list --orderId` 到 `FINISHED` / `FAILED`，`FINISHED` 后再等 BSC 收据；全程不会重新提交订单。

## DEX 市价卖出（four.meme 内盘关闭/迁移）

`four.meme` 面板的「卖出」仍走内盘 `sell`。如果代币已经迁移或内盘阶段关闭，链上会直接回滚 `CoreErrBadPhase`（selector `0xc4e60bf5`），重试没有用。此时使用下方的「DEX 市价卖出」按钮，改走 `baw market-order swap` 换成 BNB。

```text
POST /api/dex-sell/quote   { "token": "0x代币", "amount": "1000" }
POST /api/dex-sell         { "token": "0x代币", "amount": "1000" }
```

- 只允许 `代币 → BNB`，目标固定为 BNB
- 页面卖出面板使用 8 个可编辑比例按钮（默认 `10/25/50/100/0/0/0/0`），`100%` 即全部卖出
- 服务端读取代币 `decimals` / `balanceOf`，金额不得超过余额
- 执行后轮询订单到 `FINISHED / FAILED`，再等链上收据
- `ORDER_API_ERROR` 原样透传，不自动重试
- 预演模式只查报价，不提交交易

## DEX 市价买入（任意 ERC20）

用于不在 Portal/Probe、也不在 four.meme/OpenFour 注册表里的普通 ERC20。页面顶部「DEX 市价买入」卡片可直接输入 CA 和 BNB 数量。

```text
POST /api/dex-buy/quote   { "toToken": "0x代币", "amount": "0.1" }
POST /api/dex-buy         { "toToken": "0x代币", "amount": "0.1" }
```

- 目标必须是合约，且不能是 BNB/WBNB
- BNB 余额必须覆盖买入金额 + 0.002 BNB gas 预留
- 先报价、再手动确认；执行后轮询 `FINISHED / FAILED` 并等收据
- `ORDER_API_ERROR` 等 CLI 错误原样透传，不自动重试
- 这条路径不会检查 OpenFour preset，也不等同于自动买入白名单

## Gang LaunchpadV2 买入（多计价币）

Gang.fun 的 LaunchpadV2 不是只支持 GANG。链上每个币的 `curves(token).quote` 可能是：

```text
GANG / BNCB / WBNB / FXION / OANTHROPIC / BABAB ...
```

8788 现在读取代币自己的 quote 地址和 decimals，自动完成：

```text
BNB -> quote（BAW market-order）
-> approve quote 给 LaunchpadV2
-> LaunchpadV2.buy(token, quoteIn, minTokensOut)
```

卖出：

```text
approve 代币给 LaunchpadV2
-> LaunchpadV2.sell(token, tokensIn, minQuoteOut)
-> quote -> BNB（BAW market-order）
```

```text
POST /api/gang/quote   { "token": "0xGang代币", "amount": "0.1" }
POST /api/gang/buy     { "token": "0xGang代币", "amount": "0.1" }
POST /api/gang/sell/quote { "token": "0xGang代币" }
POST /api/gang/sell       { "token": "0xGang代币" }
GET  /api/gang/site-tokens
```

- `GET /api/gang/site-tokens` 会分页读取 `gang.fun/api/tokens`，当前返回约 190+ 个 CA
- 8788 的「官网代币」按钮可直接选择并解析，一次一个，不做批量买入
- 支持所有 LaunchpadV2 未毕业币，不再限定 quote=GANG
- 已毕业币自动回退 DEX 路由
- Gang 卖出支持 8 个可编辑比例按钮（默认 `10/25/50/100/0/0/0/0`），`100%` 即全部
- 钱包必须有 Agent ID（链上 `isAgent`）
- 受 LaunchpadV2 的 1% 钱包上限限制
- 报价使用链上曲线公式，最低到账按界面滑点保护
- 换汇成功但 approve/buy 失败时，会提示「已换得 X quote，未买入」，不会自动重试
- 卖出成功但 quote→BNB 失败时，quote 留在钱包并明确提示
- 卖出/授权/买入如果触发 Binance App 风控确认：服务端会提交确认请求并等待最多 5 分钟
- 同一时间只允许一笔 Gang 买入/卖出；busy 时不要连续点

## 单一交易面板

页面只有一个「统一买卖」卡片、一个 CA 输入、一个买入/卖出表单，没有 Tab：

| 自动路由 | 买入 | 卖出 |
|---|---|---|
| Portal / 内盘 | BNB 或自动换计价币 | 按份额，8 个可编辑比例 |
| four.meme / Flap | BNB 或自动换计价币 | 按代币余额，8 个可编辑比例 |
| DEX / 任意 ERC20 | BNB 市价买入 | 按代币余额，8 个可编辑比例 |
| Gang Launchpad | BNB→该币 quote（GANG/BNCB/WBNB…）→买入 | 按比例→quote→BNB |

- 顶部 CA 自动识别 Portal → four.meme → Gang → DEX
- 新面板显示当前路由、代币、计价币、余额
- 买入：8 个可编辑 BNB 按钮（默认 `0.0001/0.1/0.5/1/0.05/0.25/2/5`），点数值直接下单
- 卖出：8 个可编辑比例按钮（默认 `10/25/50/100/0/0/0/0`），点比例直接下单
- 点「编辑数值」可改任意值，支持自定义 BNB / 自定义 %，保存在浏览器 localStorage
- 持仓条：持仓数量、持仓成本、当前价值、未实现盈亏（当前价值按可卖报价估算）
- 滑点 1%/3%/5%/自定义；Gas 慢/标准/快；MEV 保护开关都在交易面板
- 滑点对所有路由生效；Gas/MEV 对 DEX 市价、换汇和 Gang 的 market-order 生效，Portal/four 内盘合约调用使用钱包默认 Gas/MEV
- **快速交易**：默认开启，点买入/卖出数值直接发送，不再弹页面二次确认；可点「快速：开/关」关闭
- 快速交易开启时会自动关闭「预演」；BAW 仍可能要求 Binance App 确认，这部分不能绕过
- CA 输入框粘贴/输入完整 `0x...` 后自动解析；聚焦空输入框会尝试读取剪贴板；也可点「粘贴解析」
- 卖出最终换 BNB；失败不自动重试
- 旧的 Portal / four.meme / DEX / Gang 面板只作为隐藏执行层保留，不再显示
- Portal 代币如果是 `PHASE 3` / `SELL_OK=0`：8788 会先提示 `Market.claim()` 把份额领成 ERC20，再走 DEX 卖出换 BNB
- Portal 代币如果是 `PHASE 3` / `BUY_OK=0`：8788 自动改走 **DEX 市价买入**，不再调用已关闭的内盘 `buy`
- 内盘返回 `MARKET_NOT_OPEN` 时，错误会显示为清晰提示；买入会自动 fallback 到 DEX，若 DEX 无流动性才最终失败
- four.meme 原生 BNB 买入如果内盘 revert：自动改走 DEX 市价买入；如果已经换汇则不会二次 fallback，避免重复花 BNB
- four.meme 原生 BNB 卖出如果内盘 revert：自动改走 DEX 市价卖出；非原生计价币不会盲目 fallback
- `claim` 只允许对 Factory 注册的 Market 调用；服务端白名单单独放行 `claim()` selector
- PnL 遇到买入成本未知时，总利润显示 `—`，不会把卖出额当成利润

## 交易利润（PnL）

```text
GET /api/token-pnl?ca=0x...
```

- 读取 BAW `wallet tx-history` 最近 100 笔
- 解析 BNB / 计价币 / 目标代币流水
- 计算总买入 BNB、总卖出 BNB、平均成本、已实现利润
- 支持“BNB 直接买”“先买 GANG/BNCB 再买目标币”的两段式成本匹配
- 面板底部显示 `余额 / 总买入 / 总卖出 / 总利润`
- 总利润为**已实现利润**（卖出 - 成本），不含未实现和 gas；不足 100 笔历史时可能不完整


## Token 概览（GMGN 风格）

解析任意 CA 后，顶部会显示行情与安全概览：

```text
GET /api/token-overview?ca=0x...
```

- DexScreener：价格、24h 涨跌、市值/FDV、流动性、24h 量、买卖笔数、DEX/交易对
- GoPlus：蜜罐、买/卖税、增发、开源、所有权、持有人数、Top10、LP 锁定
- 30 秒自动刷新；不再内嵌 DEX K 线 iframe，交易面板更紧凑
- 提供 GMGN / DexScreener / BscScan 外链
- 数据源失败时保留基础信息和外链，不阻塞买卖

数据来自 DexScreener 和 GoPlus 的公开接口，仅作交易前参考。

**深链**：`http://127.0.0.1:8787/?ca=0x代币&auto=1` 会自动连接并解析，方便做书签。

界面细节：执行前有确认弹窗（重新取一次计划再发，保证 `MIN_SHARES/MIN_RAW` 新鲜）、地址一键复制、池子已售进度条、日志可复制、CA/滑点/预演开关记忆在 localStorage。

## 安全约束（serve.mjs）

- 只监听 `127.0.0.1`
- 页面从服务端注入的随机 token 才能调用 `/api/*`
- 只允许三类调用：`Portal.buyWithQuote`（ERC20 池）/ `Portal.buy`（原生 BNB 池，带 value）/ `Portal.sellBps` / `QUOTE.approve`
- calldata 里的 market / spender 必须是 `Factory.isMarket()` 返回 true 的已注册 Market
- `value` 只允许出现在原生 BNB 买入上，且不得超过钱包 BNB 余额

## four.meme v2 模式

解析时如果 `probeOfToken` 返回 0，插件会自动查 `FOUR_ROUTER.tokens(token)`（`0xe4860339`）：

- 命中 → 切到「four.meme 路由模式」面板（Probe 面板自动隐藏）
- 路由地址：`0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3`
- 买入：`0x995ee6da` `buy(address token,uint256 funds,uint256 minAmount,uint256,bytes)`，`value = funds`
- 卖出：`0x8bfc7764` `sell(address token,uint256 amount,uint256 minFunds,uint256,bytes)`，卖出前自动 `approve(router)`

这套 calldata 是从链上真实成功的买入交易逐字节反推出来的（已做等值校验）。
## 两种签名方式

| 方式 | 延迟 | 私钥位置 | 适用 |
|---|---|---|---|
| **Agentic 桥**（默认） | 一次 HTTP + 一次 `baw` 调用（约 1~2s） | 只在 `baw` / 币安钱包 | 常规操作、需要 App 二次确认的场景 |
| **本地私钥直签** | 一次 HTTP + 一次链上广播（约 300~600ms） | 浏览器内存 + 本机桥进程 | 开盘抢跑、需要压到最低延迟 |

切换方式：顶栏 `签名方式` 选 `本地私钥` → 粘贴私钥 → 点「应用」。

本地直签做了什么：
- 桥里用 ethers 还原地址（`/api/addr`），页面拿它当 `from` 读 Probe 持仓/余额
- 发送时并行取 `nonce` / `gasPrice` / `estimateGas`，签名后 `eth_sendRawTransaction`，只走一次广播
- `estimateGas` 失败会直接把链上 revert 原因返回（不会盲发）
- 支持显式 `gasLimit`（估不出来时的兜底）
- 白名单校验与桥模式完全一致：只允许 `buy/buyWithQuote/sellBps`、four.meme `buy/sell`、`approve(→已注册 Market 或 four.meme 路由)`，`value` 只能是两种买

安全约束：
- 私钥**只存在页面内存**（刷新即清空），不写 localStorage、不进日志、不落盘
- 私钥会经 `127.0.0.1` 传到本机桥进程用于签名；桥不记录请求体
- 直签地址必须有 BNB 付 gas、有计价币才能买
## 开放前的加固（以防开盘剧烈波动 / 节点抽风）

| 问题 | 处理 |
|---|---|
| 节点超时把流程卡死 | 每次 RPC 9s 超时，单节点失败自动重试 1 次再换下一个，并记住最近成功的节点 |
| 解析慢 | `probeOfToken` + `marketOfToken` 并发、`market()` + `assetProbe()` 并发；实测 4.5s → 1.9s |
| 确认后价格已变 | 点「确认执行」会**重新取一次计划**再发，`MIN_SHARES/MIN_RAW` 永远新鲜 |
| 重复探测拖时间 | 确认后不再重复 `quoteFundingProbe`，改用一次 `allowance` 查询 |
| 发送前状态异常 | 自检：会话必须是 `CONNECTED`、BNB ≥ 0.0003（gas） |
| 不知道盘什么时候开 | 每 9 秒轮询 `PHASE / BUY_OK / SELL_OK` 和余额，状态一变就写日志 |
| 浏览器缓存旧 JS | `protocol.js?v=14` 版本号 + `cache-control: no-store` |
| 桥偶发失败 | 预览没拿到 JSON 时自动重试一次；会话过期（10003002）映射成明确提示 |
| 不设下限被夹 | four.meme 面板 `minOut=0` 时确认框红字警告 |
| 出问题难排查 | 每步带耗时，交易哈希带 bscscan 链接，失败提示「可直接再点一次重试」 |
## 两种池子

| 池型 | assetProbe.QUOTE | 买入 | 读数字段 |
|---|---|---|---|
| ERC20（如 BNCB） | 代币地址 | `approve(MARKET, gross)` → `buyWithQuote(market, gross, minShares)`，value=0 | `ACCEPT_RAW / FEE_RAW / OUT_RAW / MIN_RAW` |
| 原生 BNB | `0x000…000` | `buy(market, minShares)`，`value = gross` | `ACCEPT_WEI / FEE_WEI / OUT_WEI / MIN_WEI` |

原生池没有 `quoteFundingProbe`（会返回 `ERC20_MARKET_REQUIRED`），余额在本地用 `eth_getBalance` 判断；
`buyPlanProbe(gross, slippageBps)` 两种池子通用。卖出两端都走 `sellBps(market, bps, minOut)`。

## 协议要点

Probe 系列方法**故意 revert**，读数在 `Error(string)` 里，必须 `eth_call` + 解析 `error.data`：

```
assetProbe()                                  → MARKET / QUOTE / DECIMALS
actionStatusProbe()                           → PHASE / BUY_OK / CLAIM_OK
buyCapacityProbe()                            → ROOM_SHARES / ID
quoteFundingProbe(gross)                      → BALANCE_OK / ALLOWANCE_OK
buyPlanProbe(gross, slippageBps)              → BUY_SHARES / MIN_SHARES / RULES_OK
sellPlanCustomProbe(shareBps, slippageBps)    → SHARES / OUT_RAW / MIN_RAW
positionProbe() / sharesProbe()               → HELD_SHARES / SELL_OK / PHASE
```

买入：`approve(MARKET, gross)`（精确额度）→ `Portal.buyWithQuote(market, gross, MIN_SHARES)`
卖出：`Portal.sellBps(market, shareBps, MIN_RAW)`

`MIN_SHARES` / `MIN_RAW` 必须来自**新鲜**计划——内盘报价每个区块都在变。

## preset 新币监听与自动买入

监听 Four.meme 的 `Binance Agent ID Exclusive` preset：

```text
presetId = 1778027615735
```

- WSS 监听 `TokenCreated`，只读显示新币、计价池、创建者、区块和交易
- 自动买入默认关闭；页面必须手动确认启用
- 只对**非 WBNB/BNB 计价**的新币自动买入（WBNB/BNB 池跳过）
- 买入前用链上 `estimateBuyByBudget` 的 `totalFee / curveQuote` 做含税综合费率过滤，超过 **5%** 跳过
- 固定 `0.1 BNB/笔`，`50%` 最低到账，`1 次/币`，`10 笔/日`
- 使用 OpenFour `buyByBudget` + 原生 zap，在同一笔交易内完成 BNB → 计价币 → 买入
- 只支持预设白名单计价币（NVDAB / QQQB / BNCB / BNC4 / USDT / USDC / U / USD1）
- 未知计价池、ZapRouter 变化、报价失败、需要 App 确认时停止该笔，不重试
- 状态、去重和交易结果只存内存；重启后自动买入恢复为关闭

接口：

```text
GET  /api/preset-watch/status
POST /api/preset-watch/start
POST /api/preset-watch/stop

GET  /api/preset-autobuy/status
GET  /api/preset-autobuy/check
POST /api/preset-autobuy/arm
POST /api/preset-autobuy/disarm
```

监听状态和自动买入状态都只保存在 `serve.mjs` 进程内存中。


## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | UI、余额自动检测、买卖流程、BNB 自动换汇买入、DEX 市价卖出 |
| `protocol.js` | selector、ABI 编码、revert-string 解码、Probe 读取 |
| `serve.mjs` | 静态服务 + `/api/health` + `/api/token-overview` + `/api/token-pnl` + `/api/send`（Agentic 钱包签名桥）+ `/api/swap` / `/api/swap/quote` + `/api/dex-buy` / `/api/dex-buy/quote` + `/api/dex-sell` / `/api/dex-sell/quote` + `/api/gang/*` + preset 监听/自动买入接口 |
| `gang-buy.mjs` | Gang LaunchpadV2 的 BNB→GANG→approve→buy，以及 approve→sell→GANG→BNB |
| `preset-watch.mjs` | WSS 只读监听 preset 1778027615735 的新 TokenCreated |
| `preset-autobuy.mjs` | 非 WBNB 计价新币的自动买入（OpenFour buyByBudget + zap） |
| `openfour-abi/` | 自动买入使用的 OpenFour Core/Tools/Registry ABI |
| `bridge-buy.mjs` | 走桥跑一遍完整买入（验证用） |
| `verify.mjs` / `sell-verify.mjs` | 只读解析 + 生成 calldata |
| `test-protocol.mjs` | Node 只读自测 |
