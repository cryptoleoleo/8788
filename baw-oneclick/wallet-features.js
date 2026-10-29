// UI addition inside the original BAW page. No chrome extension/iframe shell.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => { const s=String(n); return s.includes('.') ? s.replace(/0+$/,'').replace(/\.$/,'') : s; };
export function decimalTotal(amount, count) {
  const s=String(amount); if(!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(s)) throw new Error('金额格式无效');
  const [a,b='']=s.split('.'); const value=(BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0')))*BigInt(count);
  const whole=value/10n**18n, part=(value%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');
  return whole+(part?'.'+part:'');
}
export function installWalletFeatures(deps) {
  const $=s=>document.querySelector(s), wrap=$('.wrap');
  const ui={data:{groups:[],wallets:[],tasks:[],copy:{running:[],jobs:[],logs:[]}},tab:'trade',selected:new Set(),enabled:false,activeId:null,executionId:null,job:null,busy:false,apiFailure:null,formTaskId:null,clientId:crypto.randomUUID(),claiming:false};
  const nav=document.createElement('nav'); nav.className='mw-nav';nav.setAttribute('aria-label','BAW 功能');nav.innerHTML=['trade:交易','copy:跟单','wallets:钱包'].map(x=>{const [id,name]=x.split(':');return `<button type="button" data-mw-tab="${id}" aria-selected="${id==='trade'}">${name}</button>`;}).join('');
  const top=$('.topbar'), trade=document.createElement('div');trade.className='mw-trade-view';trade.id='mw-trade';
  for(const node of [...wrap.children]) if(node!==top) trade.appendChild(node);
  wrap.append(nav,trade);
  const walletPage=document.createElement('div');walletPage.className='mw-root mw-page';walletPage.hidden=true;walletPage.id='mw-wallets';
  const copyPage=document.createElement('div');copyPage.className='mw-root mw-page';copyPage.hidden=true;copyPage.id='mw-copy';
  wrap.append(copyPage,walletPage);
  const choose=document.createElement('section');choose.id='mw-wallet-select';choose.className='mw-root';
  $('#unifiedTradePanel').before(choose);
  const status=document.createElement('div');status.className='mw-status mw-root';status.setAttribute('aria-live','polite');status.hidden=true;nav.after(status);
  const dialog=document.createElement('dialog');dialog.id='mw-dialog';dialog.className='mw-root';document.body.append(dialog);
  const btn=(s,a,css='')=>`<button class="btn sm ${css}" type="button" data-mw-action="${a}">${s}</button>`;
  const notify=(message,error=false)=>{status.hidden=false;status.textContent=message;status.classList.toggle('mw-error',error);deps.log(message,error?'bad':'');};
  const api=(path,body)=>deps.bridge('/api/multi/'+path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
  const wallet=id=>ui.data.wallets.find(w=>w.id===id);
  const available=w=>Boolean(w.address)&&w.status==='CONNECTED';
  const selected=()=>ui.data.wallets.filter(w=>ui.selected.has(w.id));
  function groupMarkup(kind, ids) {
    return `<div class="mw-groups">${ui.data.groups.map(g=>{const ws=ui.data.wallets.filter(w=>w.groupId===g.id&&available(w)),n=ws.filter(w=>ids.has(w.id)).length;return `<label class="mw-chip"><input type="checkbox" data-mw-group="${g.id}" data-kind="${kind}" ${ws.length&&n===ws.length?'checked':''} ${!ws.length?'disabled':''}><span>${esc(g.name)}</span><small>${n}/${ws.length}</small></label>`;}).join('')}</div>`;
  }
  function rowsMarkup(kind,ids) {return ui.data.wallets.map(w=>`<div class="mw-wallet"><label><input type="checkbox" data-mw-wallet="${w.id}" data-kind="${kind}" ${ids.has(w.id)?'checked':''} ${available(w)||ids.has(w.id)?'':'disabled'}><span class="mw-wallet-main"><b>${esc(w.name)}</b><small>${esc(w.address?deps.short(w.address):'未绑定地址')}</small></span></label><small class="${available(w)?'mw-success':''}">${available(w)?'已连接':esc(w.status==='UNCHECKED'?'待检查':w.status)}</small></div>`).join('');}
  function mixed(scope,ids,kind) {scope.querySelectorAll(`[data-mw-group][data-kind="${kind}"]`).forEach(el=>{const ws=ui.data.wallets.filter(w=>w.groupId===el.dataset.mwGroup&&available(w)),n=ws.filter(w=>ids.has(w.id)).length;el.indeterminate=n>0&&n<ws.length;});}
  function renderSelection() {
    const open=choose.querySelector('details')?.open;
    choose.innerHTML=`<div class="mw-row mw-head"><h2>购买钱包</h2>${btn('管理分组','manage')}</div><label class="mw-check"><input id="mw-enabled" type="checkbox" ${ui.enabled?'checked':''} ${ui.busy?'disabled':''}>启用分组买卖</label>${groupMarkup('trade',ui.selected)}<details ${open?'open':''}><summary>逐个勾选 · 已选 ${ui.selected.size} 个</summary>${rowsMarkup('trade',ui.selected)}</details><p class="mw-note">${ui.enabled?'买入档位为每钱包金额；点击后核对合计，再依次调用原版交易。':'未启用时，原版单钱包买卖行为保持不变。'}</p><div id="mw-batch-result"></div>`;
    mixed(choose,ui.selected,'trade');
  }
  function renderWallets() {
    walletPage.innerHTML=`<section class="card"><div class="mw-row mw-head"><h2>我的 BSC 钱包</h2>${btn('＋ 添加身份','new-wallet','primary')}</div><div class="mw-row"><small>${ui.data.wallets.length} 个独立 BAW 身份</small>${btn('＋ 新建分组','new-group')}</div><p class="mw-note">每个新增身份单独配对 Binance App。地址由钱包 CLI 验证，不接受手动冒充已连接地址。</p></section><section class="card">${ui.data.groups.map(g=>`<div class="mw-row mw-group-heading"><h3>${esc(g.name)}</h3><button class="btn sm ghost" data-rename-group="${g.id}">重命名</button></div>${ui.data.wallets.filter(w=>w.groupId===g.id).map(w=>`<div class="mw-wallet"><div class="mw-wallet-main"><b>${esc(w.name)} ${ui.activeId===w.id?'<span class="mw-active">当前</span>':''}</b><small>${esc(w.address?deps.short(w.address):'尚未连接')}</small><small class="${available(w)?'mw-success':''}">${esc(w.status||'UNCHECKED')}</small></div><div class="mw-controls"><select data-move-wallet="${w.id}" aria-label="${esc(w.name)}的分组">${ui.data.groups.map(gr=>`<option value="${gr.id}" ${gr.id===w.groupId?'selected':''}>${esc(gr.name)}</option>`).join('')}</select><button class="btn sm ghost" data-check-wallet="${w.id}">检查</button><button class="btn sm" data-login-wallet="${w.id}">连接</button><button class="btn sm ghost" data-use-wallet="${w.id}" ${available(w)?'':'disabled'}>设为当前</button></div></div>`).join('')}`).join('')}</section><p class="mw-help">新增身份与原有身份隔离；“连接”需要你本人在 Binance App 完成配对。原有身份也可在这里登录，继续使用原有 CLI 身份。原页面底部的预设监听仍使用原有身份；多钱包跟买请使用“跟单”页。</p>`;
  }
  let copyIds=new Set();
  function renderCopy(task=null) {
    ui.formTaskId=task?.id||null;copyIds=new Set(task?.walletIds||[]);
    copyPage.innerHTML=`<section class="card"><div class="mw-row mw-head"><h2>跟单任务</h2>${btn('新建任务','new-task')}</div><label>任务名称<input id="mw-task-name" maxlength="40" value="${esc(task?.name||'BSC 跟单')}" /></label><label style="margin-top:10px">已保存任务<select id="mw-task-select"><option value="">新任务</option>${ui.data.tasks.map(t=>`<option value="${t.id}" ${t.id===task?.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label></section><section class="card"><div class="mw-head"><h2>跟谁买</h2></div><label>目标 BSC 地址（每行一个）<textarea id="mw-leaders" placeholder="0x…">${esc(task?.leaders?.join('\n')||'')}</textarea></label><div class="mw-groups">${[['gang','Gang'],['flap','Flap'],['four','Four.meme']].map(([v,n])=>`<label class="mw-check"><input type="checkbox" data-venue="${v}" ${(!task||task.venues.includes(v))?'checked':''}>${n}</label>`).join('')}</div></section><section class="card"><div class="mw-row mw-head"><h2>用哪些钱包跟</h2>${btn('管理钱包','manage')}</div><div id="mw-copy-wallets">${groupMarkup('copy',copyIds)}${rowsMarkup('copy',copyIds)}</div></section><section class="card"><div class="mw-head"><h2>跟单规则</h2></div><label>金额模式<select id="mw-copy-mode"><option value="fixed">固定金额</option><option value="mirror" ${task?.mode==='mirror'?'selected':''}>跟随金额，设上限</option></select></label><label id="mw-amount-label">每钱包金额 / 上限（BNB）<input id="mw-copy-amount" type="text" inputmode="decimal" value="${esc(task?.amount||'0.05')}"></label><div class="mw-two"><label>同币冷却（秒）<input id="mw-cooldown" type="number" min="0" max="86400" value="${task?.cooldown??60}"></label><label>跟单滑点（%）<input id="mw-slip" type="number" step="0.1" min="0.1" max="50" value="${task?.slippage??1}"></label></div><details><summary>高级设置</summary><label>忽略目标小于此金额的买入（BNB）<input id="mw-min-leader" value="${esc(task?.minLeader||'0')}"></label><p class="mw-note">固定金额支持上述平台。镜像和金额过滤仅处理已确认以 BNB 计价的 Gang Soft 事件；其余事件会跳过。</p></details><div class="mw-line"></div><label class="mw-check"><input type="checkbox" id="mw-copy-dry" ${task?.dryRun!==false?'checked':''}>预演模式，不签名</label><div class="mw-total mw-row"><span>每次信号合计 / 上限</span><b id="mw-copy-total">—</b></div>${btn('保存任务','save-task','primary block')}<p class="mw-note">仅跟买入。使用原版解析与交易路线，面板须保持打开；关闭或离线会停止，不补买历史信号。</p></section><section class="card"><h2>任务运行与逐钱包结果</h2><div id="mw-copy-runtime"></div></section>`;
    mixed(copyPage,copyIds,'copy'); updateCopyTotal();renderRuntime();
  }
  function updateCopyTotal(){try{$('#mw-copy-total').textContent=decimalTotal($('#mw-copy-amount').value,copyIds.size)+' BNB';}catch{$('#mw-copy-total').textContent='金额无效';}}
  function renderRuntime(){const el=$('#mw-copy-runtime');if(!el)return;el.innerHTML=ui.data.tasks.map(t=>{const r=ui.data.copy.running.find(r=>r.taskId===t.id);return `<div class="mw-wallet"><span class="mw-wallet-main"><b>${esc(t.name)}</b><small>${r?esc(r.state)+(r.executorOnline?' · 面板在线':' · 执行器离线'):'未启动'} · ${t.dryRun?'预演':'真实交易'}</small></span><button class="btn sm ${r?'ghost':'primary'}" data-${r?'stop':'start'}-task="${t.id}">${r?'停止':'启动'}</button></div>`;}).join('')||'<p class="mw-note">保存任务后可启动监听。</p>';el.innerHTML+=ui.data.copy.jobs.slice(-8).reverse().map(j=>`<div class="mw-status"><b>${esc(deps.short(j.token))}</b> · ${esc(j.status)}<br>${j.results.map(r=>`${esc(wallet(r.walletId)?.name||r.walletId)}：${esc(r.message||r.status)}`).join('<br>')||'等待执行'}</div>`).join('')+ui.data.copy.logs.slice(0,6).map(l=>`<p class="mw-note">${new Date(l.at).toLocaleTimeString()} ${esc(l.message)}</p>`).join('');}
  async function refresh(full=false){const data=await api('state');ui.data=data;for(const id of ui.selected)if(!ui.data.wallets.some(w=>w.id===id))ui.selected.delete(id);renderSelection();renderWallets();if(full||!copyPage.children.length)renderCopy();else{const host=$('#mw-copy-wallets');host.innerHTML=groupMarkup('copy',copyIds)+rowsMarkup('copy',copyIds);mixed(copyPage,copyIds,'copy');updateCopyTotal();renderRuntime();}}
  function tab(id){ui.tab=id;nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.mwTab===id)));trade.hidden=id!=='trade';walletPage.hidden=id!=='wallets';copyPage.hidden=id!=='copy';}
  async function modal(title,body,accept='确定') {
    dialog.innerHTML=`<div class="mw-row mw-head"><h2>${esc(title)}</h2><button class="btn sm ghost" data-cancel>关闭</button></div>${body}<div class="mw-row" style="margin-top:14px"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-accept>${esc(accept)}</button></div>`;
    dialog.showModal();return new Promise(resolve=>{const done=ok=>{dialog.oncancel=null;dialog.close();resolve(ok);};dialog.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>done(false));dialog.querySelector('[data-accept]').onclick=()=>done(true);dialog.oncancel=e=>{e.preventDefault();done(false);};});
  }
  let pairingInProgress = false;
  async function connection(id) {
    if (pairingInProgress) throw new Error('正在等待钱包配对，请先完成或取消当前请求');
    pairingInProgress = true;
    try {
      notify('正在创建 Binance 登录请求…');const result=await api('wallets/signin',{id});
      if(result.alreadyConnected){notify('身份已连接并验证');await refresh();return true;}
      const ok=await modal('完成 Binance App 配对',`<div class="mw-pairing"><p>确认 App 中的配对码一致：</p><code>${esc(result.pairingCode)}</code><a href="${esc(result.urlForWeb)}" target="_blank" rel="noopener noreferrer">打开 Binance 登录页面</a><p class="mw-note">在 Binance App 完成操作后，点击下方“等待配对完成”。</p></div>`,'等待配对完成');
      if(!ok){notify('已取消等待配对；需要时可重新点击连接。');return false;}
      notify('正在等待 Binance 配对完成，最长约 5 分钟…');await api('wallets/verify',{id});notify('身份已连接，BSC 地址核对通过');await refresh();return true;
    } finally { pairingInProgress = false; }
  }
  function readTask(){return {id:ui.formTaskId||undefined,name:$('#mw-task-name').value,leaders:$('#mw-leaders').value.split(/[\s,，]+/).filter(Boolean),walletIds:[...copyIds],venues:[...copyPage.querySelectorAll('[data-venue]:checked')].map(e=>e.dataset.venue),mode:$('#mw-copy-mode').value,amount:$('#mw-copy-amount').value,cooldown:Number($('#mw-cooldown').value),slippage:Number($('#mw-slip').value),minLeader:$('#mw-min-leader').value,dryRun:$('#mw-copy-dry').checked};}
  async function runBatch(kind,value,job=null) {
    if(ui.busy)throw new Error('另一批交易正在处理');
    if($('#sigMode').value!=='bridge')throw new Error('多钱包仅支持独立 Agentic 身份，请切换到 Agentic 桥');
    const ids=job?job.walletIds:[...ui.selected];if(!ids.length)throw new Error('请至少勾选一个钱包');
    for(const id of ids)if(!wallet(id)||!available(wallet(id)))throw new Error('请先检查所有执行钱包连接状态');
    if(kind==='buy')decimalTotal(value,ids.length);
    const ca=job?.token||$('#ca').value.trim();if(!/^0x[0-9a-fA-F]{40}$/.test(ca))throw new Error('先填写有效代币合约');
    const options=deps.getOptions();
    if(!job){const ok=await modal(kind==='buy'?'分组买入确认':'分组卖出确认',`<p class="mw-note">${options.dryRun?'预演，不签名':'真实交易'} · ${esc(ca)}</p><table class="mw-table"><thead><tr><th>执行钱包</th><th>${kind==='buy'?'每钱包金额':'各自持仓比例'}</th></tr></thead><tbody>${ids.map(id=>`<tr><td>${esc(wallet(id).name)}<br><small>${esc(deps.short(wallet(id).address))}</small></td><td>${esc(value)} ${kind==='buy'?'BNB':'%'}</td></tr>`).join('')}</tbody></table>${kind==='buy'?`<div class="mw-total mw-row">合计<b>${decimalTotal(value,ids.length)} BNB</b></div><p class="mw-note">Gas 另计。失败的钱包不会自动重试。</p>`:''}`,options.dryRun?'开始逐钱包预演':'确认逐钱包执行');if(!ok)return;}
    const snapshot={...deps.state},oldCa=$('#ca').value;const previous=ui.activeId;
    ui.busy=true;ui.job=job;deps.state.busy=true;deps.pausePolling();trade.inert=true;walletPage.inert=true;top.inert=true;
    const results=[];
    try {
      if(job)deps.setOptions({dryRun:job.dryRun,slipBps:Math.round(job.slippage*100)});
      for(const id of ids){
        const w=wallet(id);ui.executionId=id;ui.apiFailure=null;
        try {
          deps.state.info=null;deps.state.fm=null;deps.state.venue=null;deps.state.account=null;$('#ca').value=ca;
          await deps.connect();deps.pausePolling();
          if(deps.state.account?.toLowerCase()!==w.address.toLowerCase())throw new Error('返回地址与所选钱包不一致');
          if(!deps.state.venue)await deps.resolve();
          if ((job?.dryRun ?? options.dryRun) && deps.preview) await deps.preview(kind, value);
          else await deps[kind](value);
          if(ui.apiFailure)throw new Error(ui.apiFailure);
          results.push({walletId:id,status:'completed',message:(job?.dryRun??options.dryRun)?'预演流程完成（未签名）':'原版流程结束，详见交易日志'});
        } catch(e){results.push({walletId:id,status:'failed',message:e.message});deps.log(`${w.name}：${e.message}`,'bad');}
        if(job)await api('tasks/result',{jobId:job.id,claim:job.claim,...results.at(-1)});
      }
    } finally {
      ui.executionId=null;ui.activeId=previous;ui.job=null;
      Object.keys(deps.state).forEach(k=>{if(!(k in snapshot))delete deps.state[k];});Object.assign(deps.state,snapshot);$('#ca').value=oldCa;deps.setOptions(options);deps.resumePolling();
      try {
        if(snapshot.account&&/^0x[0-9a-fA-F]{40}$/.test(oldCa))await deps.resolve().catch(e=>deps.log('恢复原页面状态：'+e.message,'warn'));
        deps.restoreDisplay?.();
        const summary=results.map(r=>`${wallet(r.walletId)?.name}：${r.message}`).join('\n');notify(summary||'批次未执行');await refresh();
      } finally {ui.busy=false;trade.inert=false;walletPage.inert=false;top.inert=false;}
    }
  }
  async function handle(e){const b=e.target.closest('button');if(!b)return;
    if(b.dataset.mwTab){tab(b.dataset.mwTab);return;}
    if(b.dataset.checkWallet){await api('wallets/check',{id:b.dataset.checkWallet});await refresh();notify('钱包地址及连接状态已检查');return;}
    if(b.dataset.loginWallet){await connection(b.dataset.loginWallet);return;}
    if(b.dataset.useWallet){if(ui.busy||deps.state.busy)throw new Error('交易处理中');const oldId=ui.activeId,oldState={...deps.state};ui.busy=true;deps.pausePolling();try{ui.activeId=b.dataset.useWallet;Object.assign(deps.state,{account:null,info:null,fm:null,venue:null});await deps.connect();renderWallets();}catch(e){ui.activeId=oldId;Object.assign(deps.state,oldState);deps.restoreDisplay?.();throw e;}finally{ui.busy=false;deps.resumePolling();}return;}
    if(b.dataset.renameGroup){const g=ui.data.groups.find(g=>g.id===b.dataset.renameGroup);if(await modal('重命名分组',`<label>名称<input id="mw-new-name" value="${esc(g.name)}" maxlength="40"></label>`))await api('groups/rename',{id:g.id,name:$('#mw-new-name').value});await refresh();return;}
    if(b.dataset.startTask){const t=ui.data.tasks.find(t=>t.id===b.dataset.startTask);const ok=await modal(t.dryRun?'开始跟单预演':'启动真实跟单',`<p>${esc(t.name)}</p><p class="mw-note">${t.leaders.length} 个目标，${t.walletIds.length} 个执行钱包，每次信号${t.mode==='mirror'?'最高':''} ${decimalTotal(t.amount,t.walletIds.length)} BNB。</p><p class="mw-help">${t.dryRun?'只预演，不签名。':'启动后，新买入信号将自动调用原版买入流程，可能包含换汇及授权。'}面板需保持打开。停止后不会重试未确认的交易。</p>`,'确认启动');if(ok){await api('tasks/start',{id:t.id,clientId:ui.clientId,liveAcknowledged:!t.dryRun});await refresh();}return;}
    if(b.dataset.stopTask){await api('tasks/stop',{id:b.dataset.stopTask});await refresh();notify('监听已停止；已广播的交易仍以链上结果为准');return;}
    switch(b.dataset.mwAction){
      case 'manage':tab('wallets');break;
      case 'new-group':if(await modal('新建分组','<label>名称<input id="mw-new-name" maxlength="40" placeholder="例如：试单组"></label>')){await api('groups/create',{name:$('#mw-new-name').value});await refresh();}break;
      case 'new-wallet':if(await modal('新增独立 BAW 身份',`<label>钱包名称<input id="mw-new-name" maxlength="40" placeholder="例如：钱包 02"></label><label>所属分组<select id="mw-new-group">${ui.data.groups.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label><p class="mw-note">创建后点击“连接”，用对应 Binance 身份配对；不会复制原有钱包登录数据。</p>`,'创建身份')){await api('wallets/create',{name:$('#mw-new-name').value,groupId:$('#mw-new-group').value});await refresh();}break;
      case 'new-task':renderCopy();break;
      case 'save-task':{const r=await api('tasks/save',readTask());await refresh();renderCopy(r.task);notify('任务已保存，未自动启动');break;}
    }
  }
  nav.addEventListener('click',handle);[choose,walletPage,copyPage].forEach(el=>el.addEventListener('click',e=>handle(e).catch(err=>notify(err.message,true))));
  async function change(e){const t=e.target;
    if(t.id==='mw-enabled'){ui.enabled=t.checked;renderSelection();}
    if(t.dataset.mwWallet){const set=t.dataset.kind==='copy'?copyIds:ui.selected;t.checked?set.add(t.dataset.mwWallet):set.delete(t.dataset.mwWallet);if(t.dataset.kind==='trade'){ui.enabled=true;renderSelection();}else {$('#mw-copy-wallets').innerHTML=groupMarkup('copy',copyIds)+rowsMarkup('copy',copyIds);mixed(copyPage,copyIds,'copy');updateCopyTotal();}}
    if(t.dataset.mwGroup){const set=t.dataset.kind==='copy'?copyIds:ui.selected;ui.data.wallets.filter(w=>w.groupId===t.dataset.mwGroup&&available(w)).forEach(w=>t.checked?set.add(w.id):set.delete(w.id));if(t.dataset.kind==='trade'){ui.enabled=true;renderSelection();}else{$('#mw-copy-wallets').innerHTML=groupMarkup('copy',copyIds)+rowsMarkup('copy',copyIds);mixed(copyPage,copyIds,'copy');updateCopyTotal();}}
    if(t.dataset.moveWallet){await api('wallets/update',{id:t.dataset.moveWallet,groupId:t.value});await refresh();}
    if(t.id==='mw-copy-amount')updateCopyTotal();
    if(t.id==='mw-task-select')renderCopy(ui.data.tasks.find(x=>x.id===t.value));
  }
  [choose,walletPage,copyPage].forEach(el=>el.addEventListener('change',e=>change(e).catch(err=>notify(err.message,true))));
  const timer=setInterval(async()=>{
    if(!ui.data.copy.running.length)return;
    try {await api('tasks/heartbeat',{clientId:ui.clientId});}catch(e){notify('跟单执行器离线：'+e.message,true);return;}
    if(ui.busy||deps.state.busy||ui.claiming)return;
    ui.claiming=true;
    try {const {job}=await api('tasks/claim',{clientId:ui.clientId});if(job)await runBatch('buy',job.amount,job);else await refresh();}catch(e){notify('跟单执行器：'+e.message,true);}finally{ui.claiming=false;}
  },2500);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  renderSelection();renderWallets();renderCopy();refresh().catch(e=>notify('多钱包功能加载失败：'+e.message,true));
  return {
    loginCurrent:()=>connection(ui.activeId || 'original'),
    handlesTrade:()=>ui.enabled,
    buy:value=>runBatch('buy',String(value)),sell:value=>runBatch('sell',String(value)),
    requestHeaders(path){if(path.startsWith('/api/multi/')||path.startsWith('/api/preset-')||['/api/send-key','/api/addr'].includes(path))return {};const id=ui.executionId||ui.activeId;return id?{'x-baw-wallet':id,...(ui.busy&&deps.getOptions().dryRun?{'x-baw-preview-only':'1'}:{}),...(ui.job?{'x-baw-copy-job':ui.job.id,'x-baw-copy-claim':ui.job.claim}:{})}:{};},
    observe(path,result){if(ui.busy&&result?.ok===false&&['/api/send','/api/swap','/api/dex-buy','/api/dex-sell','/api/gang/buy','/api/gang/sell'].includes(path))ui.apiFailure=typeof result.error==='string'?result.error:result.error?.message||'交易接口返回失败';},
  };
}
