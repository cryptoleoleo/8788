#!/usr/bin/env node
/**
 * 多台子内盘跟单：Gang + Flap + Four.meme
 * WebSocket eth_subscribe 监听被跟地址买入，再通过 CLI / baw contract-call 跟买。
 *
 *   node copytrade.js --watch 0xA,0xB --bnb 0.05
 *   node copytrade.js --watch 0xA --bnb 0.05 --venues flap,four --live --from 0xYourAgentWallet
 *
 * 默认 dry-run。--live 才签名。
 * Flap/Four 走 baw contract-call（不需要 fourmeme 的 PRIVATE_KEY）。
 * Gang 走 gang CLI（默认 buy；--follow 才先试 note follow）。
 */
import WebSocket from 'ws'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  encodeEventTopics,
  parseAbiItem,
  decodeEventLog,
  decodeAbiParameters,
  encodeFunctionData,
  formatEther,
  parseEther,
  pad,
  isAddress,
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
} from 'viem'

const DEFAULT_HTTP_RPC = 'https://bsc-rpc.publicnode.com'
const HTTP_RPC = process.env.GANG_RPC_URL || process.env.BSC_RPC_URL || DEFAULT_HTTP_RPC
// gang CLI defaults to bsc-dataseed.binance.org (易超时); 跟单时统一改掉
if (!process.env.GANG_RPC_URL && !process.env.BSC_RPC_URL) {
  process.env.GANG_RPC_URL = DEFAULT_HTTP_RPC
}

const GANG_PADS = {
  soft: '0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7',
  v2: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E',
  u: '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb',
  s: '0x60aee38576035E757deD30fF8db8A8DA476430C1',
}
const FLAP_PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0'
const FOUR_TM2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b'
const FOUR_HELPER3 = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034'

const SOFT_BUY = parseAbiItem(
  'event Buy(address indexed token, address indexed buyer, uint256 bnbIn, uint256 fee, uint256 tokensOut, uint256 realBnb)',
)
const V2_BUY = parseAbiItem(
  'event Buy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 taxDividend, uint256 taxPlatform, uint256 tokensOut, uint256 realQuote)',
)
const SOFT_TOPIC = encodeEventTopics({ abi: [SOFT_BUY], eventName: 'Buy' })[0]
const V2_TOPIC = encodeEventTopics({ abi: [V2_BUY], eventName: 'Buy' })[0]
const FLAP_BOUGHT_TOPIC = keccak256(toBytes('TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)'))
const FOUR_PURCHASE_TOPIC = keccak256(toBytes('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)'))

const PAD_KIND = Object.fromEntries(
  Object.entries(GANG_PADS).map(([k, a]) => [a.toLowerCase(), k === 'soft' ? 'soft' : 'v2']),
)

const BUYER_TOPIC_CHUNK = 25

function usage(code = 1) {
  console.error(`Usage: node copytrade.js --watch <addr[,addr…]> --bnb <n> [options]

Options:
  --watch <addr>         被跟单地址；可逗号分隔或多次传入（或 --watch-file）
  --watch-file <path>    地址列表文件
  --bnb <n>              跟单金额（BNB / quote）；--mirror 时为上限
  --venues <list>        gang,flap,four（默认三个都开）
  --from <addr>          你的 Agentic Wallet 地址（Flap/Four 必填；可省略则尝试 baw wallet address）
  --ws <url>             BSC WSS（默认 wss://bsc-rpc.publicnode.com）
  --live                 真正签名执行（默认只预览）
  --mirror               尽量跟对方同额，不超过 --bnb
  --slippage <pct>       滑点%，默认 1
  --note <text>          仅 Gang：公开 note
  --no-note              仅 Gang：不写 note
  --follow               仅 Gang：先试 gang follow（默认直接 buy）
  --min-leader <n>       忽略对方小于该金额的买入
  --cooldown <sec>       同 venue+token 冷却秒数（默认 60）
  --max-steps <n>        Gang wrap/approve 最多步数（默认 6）
`)
  process.exit(code)
}

function parseAddressList(raw) {
  return String(raw).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
}

function loadWatchFile(path) {
  const text = readFileSync(path, 'utf8')
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.replace(/#.*$/, '').trim()
    if (s) out.push(...parseAddressList(s))
  }
  return out
}

function normalizeWatches(addrs) {
  const set = new Map()
  for (const a of addrs) {
    if (!isAddress(a)) {
      console.error('invalid address:', a)
      usage()
    }
    const g = getAddress(a)
    set.set(g.toLowerCase(), g)
  }
  return [...set.values()]
}

function parseVenues(raw) {
  const all = new Set(['gang', 'flap', 'four'])
  if (!raw) return all
  const set = new Set()
  for (const p of String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!all.has(p)) {
      console.error('unknown venue:', p)
      usage()
    }
    set.add(p)
  }
  return set
}

function parseArgs(argv) {
  const out = {
    watchRaw: [],
    watchFile: null,
    bnb: null,
    venuesRaw: null,
    from: null,
    ws: process.env.GANG_WS_RPC || process.env.BSC_WS_RPC || 'wss://bsc-rpc.publicnode.com',
    live: false,
    mirror: false,
    slippage: 1,
    note: null,
    noNote: false,
    preferBuy: true,
    minLeader: 0,
    cooldown: 60,
    maxSteps: 6,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) usage()
      return v
    }
    if (a === '--help' || a === '-h') usage(0)
    else if (a === '--watch') out.watchRaw.push(...parseAddressList(next()))
    else if (a === '--watch-file') out.watchFile = next()
    else if (a === '--bnb') out.bnb = next()
    else if (a === '--venues') out.venuesRaw = next()
    else if (a === '--from') out.from = next()
    else if (a === '--ws') out.ws = next()
    else if (a === '--live') out.live = true
    else if (a === '--mirror') out.mirror = true
    else if (a === '--slippage') out.slippage = Number(next())
    else if (a === '--note') out.note = next()
    else if (a === '--no-note') out.noNote = true
    else if (a === '--follow') out.preferBuy = false
    else if (a === '--min-leader') out.minLeader = Number(next())
    else if (a === '--cooldown') out.cooldown = Number(next())
    else if (a === '--max-steps') out.maxSteps = Number(next())
    else {
      console.error('unknown flag:', a)
      usage()
    }
  }
  if (out.watchFile) out.watchRaw.push(...loadWatchFile(out.watchFile))
  const watches = normalizeWatches(out.watchRaw)
  if (!watches.length) {
    console.error('need --watch / --watch-file')
    usage()
  }
  if (out.bnb == null || !(Number(out.bnb) > 0)) {
    console.error('invalid --bnb')
    usage()
  }
  if (out.from && !isAddress(out.from)) {
    console.error('invalid --from')
    usage()
  }
  return {
    ...out,
    watches,
    watchSet: new Set(watches.map((a) => a.toLowerCase())),
    venues: parseVenues(out.venuesRaw),
    from: out.from ? getAddress(out.from) : null,
    slippage: Number.isFinite(out.slippage) ? out.slippage : 1,
  }
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function run(cmd, args, { timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    })
    let stdout = ''
    let stderr = ''
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, error: `timeout ${timeoutMs}ms`, stdout, stderr, code: -1 })
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => {
      clearTimeout(t)
      let json = null
      const text = stdout.trim()
      try {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          try { json = JSON.parse(lines[i]); break } catch { /* */ }
        }
        if (!json && text.startsWith('{')) json = JSON.parse(text)
      } catch { /* */ }
      resolve({ ok: code === 0, code, stdout, stderr, json })
    })
  })
}

async function rpc(method, params) {
  const res = await fetch(HTTP_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
  return j.result
}

async function resolveFrom(cfg) {
  if (cfg.from) return cfg.from
  const r = await run('baw', ['wallet', 'address', '--json'], { timeoutMs: 30_000 })
  const addr = r.json?.data?.address || r.json?.data?.evmAddress || r.json?.address
  if (addr && isAddress(addr)) return getAddress(addr)
  // try status
  const s = await run('baw', ['wallet', 'status', '--json'], { timeoutMs: 30_000 })
  const a2 = s.json?.data?.address || s.json?.data?.evmAddress
  if (a2 && isAddress(a2)) return getAddress(a2)
  return null
}

function buyerTopic(addr) {
  return pad(addr.toLowerCase(), { size: 32 })
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function pickAmount(cfg, leaderSpent) {
  if (!cfg.mirror) return Number(cfg.bnb)
  const cap = Number(cfg.bnb)
  const m = Number(leaderSpent)
  if (!(m > 0)) return cap
  return Math.min(cap, m)
}

function defaultNote(ev, amount) {
  return `copy ${ev.venue} ${ev.buyer.slice(0, 8)} ${ev.token.slice(0, 8)} @${ev.spent.toFixed(4)} → ${amount}`
}

function decodeGang(logItem) {
  const addr = logItem.address.toLowerCase()
  const kind = PAD_KIND[addr]
  if (!kind) return null
  const abi = kind === 'soft' ? [SOFT_BUY] : [V2_BUY]
  try {
    const { args } = decodeEventLog({ abi, data: logItem.data, topics: logItem.topics, strict: false })
    const spent = kind === 'soft' ? args.bnbIn : args.quoteIn
    return {
      venue: 'gang',
      kind,
      token: getAddress(args.token),
      buyer: getAddress(args.buyer),
      spent: Number(formatEther(spent)),
      txHash: logItem.transactionHash,
    }
  } catch (e) {
    return { error: String(e?.message || e) }
  }
}

function decodeFlap(logItem) {
  try {
    const [ts, token, buyer, amount, eth] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      logItem.data,
    )
    return {
      venue: 'flap',
      kind: 'portal',
      token: getAddress(token),
      buyer: getAddress(buyer),
      spent: Number(formatEther(eth)),
      tokensOut: amount,
      txHash: logItem.transactionHash,
      ts: Number(ts),
    }
  } catch (e) {
    return { error: String(e?.message || e) }
  }
}

function decodeFour(logItem) {
  try {
    const [token, account, price, amount, cost] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      logItem.data,
    )
    return {
      venue: 'four',
      kind: 'tm2',
      token: getAddress(token),
      buyer: getAddress(account),
      spent: Number(formatEther(cost)),
      tokensOut: amount,
      price,
      txHash: logItem.transactionHash,
    }
  } catch (e) {
    return { error: String(e?.message || e) }
  }
}

async function executeRequest(requestId) {
  const r = await run('baw', ['contract-call', 'execute', '--requestId', requestId, '--json'], { timeoutMs: 180_000 })
  log('baw execute', JSON.stringify(r.json || { stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 200) }))
  return r
}

async function bawPreviewExecute(cfg, { to, valueWei, inputData, label }) {
  const args = [
    'contract-call', 'preview',
    '--binanceChainId', '56',
    '--from', cfg.from,
    '--to', to,
    '--value', valueWei.toString(),
    '--inputData', inputData,
    '--json',
  ]
  log(label, 'baw preview', { to, value: formatEther(valueWei) })
  const preview = await run('baw', args, { timeoutMs: 120_000 })
  if (!preview.json) {
    log(label, 'non-json', preview.stdout.slice(0, 400), preview.stderr.slice(0, 200))
    return { success: false, error: 'preview not json' }
  }
  log(label, 'preview result', JSON.stringify(preview.json))
  if (!cfg.live) return { ...preview.json, dryRun: true }
  if (preview.json.success === false) return preview.json
  const rid = preview.json?.data?.requestId || preview.json?.requestId || preview.json?.data?.id
  if (!rid) return { success: false, error: 'no requestId', preview: preview.json }
  const ex = await executeRequest(rid)
  return { success: true, preview: preview.json, executed: ex.json }
}

function isRpcFlake(err) {
  const s = String(err?.error || err?.message || err || '')
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|502|503|429|Service busy|fetch failed|network/i.test(s)
}

async function gangRun(args, opts = {}) {
  return run('gang', args, {
    ...opts,
    env: { GANG_RPC_URL: process.env.GANG_RPC_URL || HTTP_RPC },
  })
}

async function gangPreviewWithRetry(args, label, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await gangRun(args, { timeoutMs: 120_000 })
    if (last.json?.success) return last
    const errText = JSON.stringify(last.json || {}) + last.stderr + last.stdout
    if (!isRpcFlake(errText) && last.json) return last
    const wait = 2000 * (i + 1)
    log(label, `rpc flake, retry in ${wait}ms`, (last.json?.error || last.error || '').toString().slice(0, 120))
    await sleep(wait)
  }
  return last
}

async function gangPreviewExecute(cfg, args, label) {
  log(label, 'preview:', args.join(' '))
  let preview = await gangPreviewWithRetry(args, label)
  if (!preview.json) {
    log(label, 'non-json', preview.stdout.slice(0, 400), preview.stderr.slice(0, 200))
    return { success: false, error: 'preview not json' }
  }
  log(label, 'preview result:', JSON.stringify(preview.json))
  if (!cfg.live) return { ...preview.json, dryRun: true }
  for (let step = 0; step < cfg.maxSteps; step++) {
    const j = preview.json
    if (!j?.success) return j
    const rid = j.requestId || j.request_id || j.id
    if (!rid) return { success: false, error: 'no requestId', preview: j }
    const ex = await gangRun(['execute', '--request-id', rid], { timeoutMs: 180_000 })
    log('gang execute', JSON.stringify(ex.json || { stdout: ex.stdout.slice(0, 400) }))
    if (!ex.json?.success && isRpcFlake(ex.json || ex)) {
      log(label, 'execute rpc flake; waiting then re-preview')
      await sleep(5000)
      preview = await gangPreviewWithRetry(args, label)
      continue
    }
    if (j.step === 'wrap-bnb' || j.step === 'approve-quote' || j.step === 'approve') {
      // wait for receipt indexing; dataseed often lags / times out right after broadcast
      await sleep(j.step === 'wrap-bnb' ? 8000 : 5000)
      preview = await gangPreviewWithRetry(args, `${label}-after-${j.step}`)
      if (!preview.json?.success) {
        if (isRpcFlake(preview.json || preview)) {
          log(label, 're-preview still flaky after setup step; try again later')
        }
        return preview.json || { success: false, error: 're-preview failed' }
      }
      continue
    }
    return { success: true, executed: ex.json, preview: j }
  }
  return { success: false, error: 'max steps exceeded' }
}

async function copyGang(cfg, ev, amount) {
  const amountStr = String(amount)
  const note = cfg.noNote ? null : cfg.note || defaultNote(ev, amount)
  const noteArgs = note ? ['--note', note, '--conf', '40'] : []
  const slip = ['--slippage', String(cfg.slippage)]
  if (!cfg.preferBuy) {
    // note 索引常有几秒～一分钟延迟
    for (let i = 0; i < 3; i++) {
      const fr = await gangPreviewExecute(cfg, ['follow', ev.txHash, '--bnb', amountStr, ...slip, ...noteArgs], 'gang-follow')
      const ok = fr?.success === true || (fr?.dryRun && fr?.success !== false && !fr?.error && fr?.reason !== 'not_found')
      if (ok) return fr
      if (fr?.reason === 'not_found' || /not_found/i.test(String(fr?.error || ''))) {
        log('gang follow not indexed yet, wait', 15 * (i + 1), 's')
        await sleep(15_000 * (i + 1))
        continue
      }
      log('gang follow unavailable:', fr?.error || fr?.reason || 'no success')
      break
    }
  }
  return gangPreviewExecute(cfg, ['buy', '--token', ev.token, '--bnb', amountStr, ...slip, ...noteArgs], 'gang-buy')
}

async function copyFlap(cfg, ev, amount) {
  if (!cfg.from) return { success: false, error: 'need --from (agentic wallet) for flap' }
  const inputAmount = parseEther(String(amount))
  // quoteExactInput via eth_call
  const quoteData = encodeFunctionData({
    abi: [{
      type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable',
      inputs: [{ type: 'tuple', components: [
        { name: 'inputToken', type: 'address' },
        { name: 'outputToken', type: 'address' },
        { name: 'inputAmount', type: 'uint256' },
      ] }],
      outputs: [{ type: 'uint256' }],
    }],
    functionName: 'quoteExactInput',
    args: [{ inputToken: zeroAddress, outputToken: ev.token, inputAmount }],
  })
  let minOut = 0n
  try {
    const raw = await rpc('eth_call', [{ to: FLAP_PORTAL, data: quoteData }, 'latest'])
    const quoted = BigInt(raw)
    const bps = BigInt(Math.max(0, Math.min(99, Math.floor(cfg.slippage * 100))))
    minOut = quoted - (quoted * bps) / 10000n
    log('flap quote', { out: formatEther(quoted), minOut: formatEther(minOut) })
  } catch (e) {
    log('flap quote failed, minOut=0', e.message || e)
  }
  const inputData = encodeFunctionData({
    abi: [{
      type: 'function', name: 'swapExactInput', stateMutability: 'payable',
      inputs: [{ type: 'tuple', components: [
        { name: 'inputToken', type: 'address' },
        { name: 'outputToken', type: 'address' },
        { name: 'inputAmount', type: 'uint256' },
        { name: 'minOutputAmount', type: 'uint256' },
        { name: 'permitData', type: 'bytes' },
      ] }],
      outputs: [{ type: 'uint256' }],
    }],
    functionName: 'swapExactInput',
    args: [{
      inputToken: zeroAddress,
      outputToken: ev.token,
      inputAmount,
      minOutputAmount: minOut,
      permitData: '0x',
    }],
  })
  return bawPreviewExecute(cfg, { to: FLAP_PORTAL, valueWei: inputAmount, inputData, label: 'flap' })
}

async function copyFour(cfg, ev, amount) {
  if (!cfg.from) return { success: false, error: 'need --from (agentic wallet) for four' }
  const funds = parseEther(String(amount))
  // Helper3.tryBuy(token, amount=0, funds) → msgValue at index 5 (per fourmeme script)
  const tryBuyData = encodeFunctionData({
    abi: [{
      type: 'function', name: 'tryBuy', stateMutability: 'view',
      inputs: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'funds', type: 'uint256' },
      ],
      outputs: [
        { type: 'address' }, { type: 'address' }, { type: 'address' },
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      ],
    }],
    functionName: 'tryBuy',
    args: [ev.token, 0n, funds],
  })
  let msgValue = funds
  let minAmount = 0n
  try {
    const raw = await rpc('eth_call', [{ to: FOUR_HELPER3, data: tryBuyData }, 'latest'])
    // decode loosely: last two useful fields vary by helper version; use funds as value fallback
    const words = raw.slice(2).match(/.{64}/g) || []
    if (words.length >= 7) {
      const estimatedAmount = BigInt('0x' + words[3])
      msgValue = BigInt('0x' + words[5])
      const bps = BigInt(Math.max(0, Math.min(99, Math.floor(cfg.slippage * 100))))
      minAmount = estimatedAmount - (estimatedAmount * bps) / 10000n
      log('four tryBuy', { msgValue: formatEther(msgValue), minAmount: formatEther(minAmount) })
    }
  } catch (e) {
    log('four tryBuy failed, using funds as value', e.message || e)
  }
  const inputData = encodeFunctionData({
    abi: [{
      type: 'function', name: 'buyTokenAMAP', stateMutability: 'payable',
      inputs: [
        { name: 'token', type: 'address' },
        { name: 'funds', type: 'uint256' },
        { name: 'minAmount', type: 'uint256' },
      ],
      outputs: [],
    }],
    functionName: 'buyTokenAMAP',
    args: [ev.token, funds, minAmount],
  })
  return bawPreviewExecute(cfg, { to: FOUR_TM2, valueWei: msgValue, inputData, label: 'four' })
}

async function handleBuy(cfg, ev, state) {
  const key = `${ev.venue}:${ev.txHash}`.toLowerCase()
  if (state.seenTx.has(key)) return
  state.seenTx.add(key)
  if (!cfg.watchSet.has(ev.buyer.toLowerCase())) return
  if (!cfg.venues.has(ev.venue)) return
  if (ev.spent < cfg.minLeader) {
    log('skip small', ev.venue, ev.spent, '<', cfg.minLeader)
    return
  }
  const coolKey = `${ev.venue}:${ev.token}`.toLowerCase()
  const now = Date.now()
  const last = state.lastTokenAt.get(coolKey) || 0
  if (cfg.cooldown > 0 && now - last < cfg.cooldown * 1000) {
    log('cooldown', coolKey, `${cfg.cooldown}s`)
    return
  }
  state.lastTokenAt.set(coolKey, now)

  const amount = pickAmount(cfg, ev.spent)
  log('LEADER BUY', {
    venue: ev.venue,
    leader: ev.buyer,
    token: ev.token,
    spent: ev.spent,
    tx: ev.txHash,
    followAmount: amount,
    live: cfg.live,
  })

  let result
  if (ev.venue === 'gang') result = await copyGang(cfg, ev, amount)
  else if (ev.venue === 'flap') result = await copyFlap(cfg, ev, amount)
  else if (ev.venue === 'four') result = await copyFour(cfg, ev, amount)
  else result = { success: false, error: 'unknown venue' }
  log('copy done', ev.venue, result?.success ? 'ok' : result?.error || result)
}

function subscribe(ws, id, filter) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['logs', filter] }))
}

async function main() {
  const cfg = parseArgs(process.argv)
  if ((cfg.venues.has('flap') || cfg.venues.has('four')) && !cfg.from) {
    cfg.from = await resolveFrom(cfg)
    if (!cfg.from) {
      console.error('Flap/Four 需要 --from <你的 Agentic Wallet 地址>（或先 baw auth signin）')
      process.exit(1)
    }
  }

  const state = {
    seenTx: new Set(),
    lastTokenAt: new Map(),
    subIds: new Set(),
    subMeta: new Map(), // subId -> 'gang'|'flap'|'four'
    rpcId: 1,
    busy: Promise.resolve(),
  }

  log('starting', {
    watches: cfg.watches,
    venues: [...cfg.venues],
    bnb: cfg.bnb,
    mirror: cfg.mirror,
    live: cfg.live,
    from: cfg.from,
    ws: cfg.ws,
  })
  if (!cfg.live) log('DRY-RUN: 不会签名。确认后加 --live')

  let ws
  let pingTimer
  let reconnectDelay = 1000

  const connect = () => {
    state.subIds.clear()
    state.subMeta.clear()
    ws = new WebSocket(cfg.ws)
    ws.on('open', () => {
      reconnectDelay = 1000
      log('ws open', cfg.ws)
      const pending = []

      if (cfg.venues.has('gang')) {
        const buyers = chunk(cfg.watches.map(buyerTopic), BUYER_TOPIC_CHUNK)
        for (const b of buyers) {
          const buyerFilter = b.length === 1 ? b[0] : b
          pending.push({ venue: 'gang', filter: { address: [GANG_PADS.soft], topics: [SOFT_TOPIC, null, buyerFilter] } })
          pending.push({ venue: 'gang', filter: { address: [GANG_PADS.v2, GANG_PADS.u, GANG_PADS.s], topics: [V2_TOPIC, null, buyerFilter] } })
        }
      }
      if (cfg.venues.has('flap')) {
        // buyer 未 indexed：订阅全部 TokenBought，客户端过滤
        pending.push({ venue: 'flap', filter: { address: [FLAP_PORTAL], topics: [FLAP_BOUGHT_TOPIC] } })
      }
      if (cfg.venues.has('four')) {
        pending.push({ venue: 'four', filter: { address: [FOUR_TM2], topics: [FOUR_PURCHASE_TOPIC] } })
      }

      for (const p of pending) {
        const id = state.rpcId++
        state.pendingVenue = state.pendingVenue || new Map()
        state.pendingVenue.set(id, p.venue)
        subscribe(ws, id, p.filter)
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping()
      }, 25_000)
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id && typeof msg.result === 'string') {
        state.subIds.add(msg.result)
        const venue = state.pendingVenue?.get(msg.id)
        if (venue) state.subMeta.set(msg.result, venue)
        log('subscribed', msg.result, venue || '')
        return
      }
      if (msg.method !== 'eth_subscription') return
      const sub = msg.params?.subscription
      const result = msg.params?.result
      if (!result?.topics) return
      const venue = state.subMeta.get(sub)
      if (!venue) return

      let ev
      if (venue === 'gang') ev = decodeGang(result)
      else if (venue === 'flap') ev = decodeFlap(result)
      else if (venue === 'four') ev = decodeFour(result)
      if (!ev || ev.error) {
        if (ev?.error) log('decode error', venue, ev.error)
        return
      }

      state.busy = state.busy
        .then(() => handleBuy(cfg, ev, state))
        .catch((e) => log('handle error', e?.stack || e))
    })

    ws.on('close', () => {
      clearInterval(pingTimer)
      log('ws closed, reconnect in', reconnectDelay, 'ms')
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    })
    ws.on('error', (e) => log('ws error', e.message || e))
  }

  connect()
  process.on('SIGINT', () => {
    log('bye')
    try { ws?.close() } catch { /* */ }
    process.exit(0)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
