# Gang 内盘 WebSocket 跟单

通过 BSC WebSocket RPC（`eth_subscribe` logs）监听**一个或多个**地址在 Gang Soft / LaunchpadV2 / U / S 上的 **Buy** 事件，再用 `gang` CLI 跟单买入。

## 行为

1. 订阅被跟地址作为 `buyer` 的 Buy 日志（多地址用 topics OR，超过 25 个自动拆订阅）
2. 优先 `gang follow <对方买入 tx> --bnb …`
3. 不可跟则回退 `gang buy --token … --bnb …`
4. `--live` 时自动 `gang execute`，并处理 `wrap-bnb` / `approve-quote`
5. **默认 dry-run**，只打预览，不签名

## 用法

```bash
cd ~/gang-copytrade   # 或你放脚本的目录
npm i

# 单地址
node copytrade.js --watch 0x被跟地址 --bnb 0.05

# 多地址：逗号分隔
node copytrade.js --watch 0xA,0xB,0xC --bnb 0.05

# 多地址：多次 --watch
node copytrade.js --watch 0xA --watch 0xB --bnb 0.05 --live

# 从文件（见 wallets.example.txt）
node copytrade.js --watch-file ./wallets.txt --bnb 0.05 --live

# 尽量跟对方同额，但不超过 0.1
node copytrade.js --watch 0xA,0xB --bnb 0.1 --mirror --live
```

| 参数 | 含义 |
|---|---|
| `--watch` | 被跟单地址；可逗号分隔或重复传入 |
| `--watch-file` | 地址列表文件（一行一个，`#` 注释） |
| `--bnb` | 跟单金额；`--mirror` 时为上限 |
| `--live` | 签名执行 |
| `--mirror` | 跟对方金额（封顶 `--bnb`） |
| `--ws` | BSC WSS（也可用 `GANG_WS_RPC` / `BSC_WS_RPC`） |
| `--min-leader` | 忽略对方过小买入 |
| `--cooldown` | 同 token 冷却秒数（默认 60） |
| `--prefer-buy` | 跳过 follow，直接 buy |
| `--no-note` / `--note` | 不写 / 自定义公开 note |

停止：`Ctrl+C`。

## 注意

- 本机需已安装并登录 `baw` + `gang`（`gang preflight`）
- 跟单会花钱，务必先 dry-run
- 1% 持仓上限、毕业币、无 Agent ID 会导致失败
- note 会公开写在 gang.fun
