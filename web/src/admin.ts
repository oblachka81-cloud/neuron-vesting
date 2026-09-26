import './polyfills';
import { Address, beginCell, toNano, Cell } from '@ton/core';
import { API_URL, FACTORY_ADDRESS, IS_TEST, TONCENTER } from './config';

const LS_TOKEN = 'nv_admin_token';
let token = localStorage.getItem(LS_TOKEN) || '';
const $ = (id: string) => document.getElementById(id)!;

async function api(path: string, opts: any = {}) {
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API_URL + path, { ...opts, headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function tonRun(method: string, address: string, stack: any[]) {
  const res = await fetch(TONCENTER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '1', jsonrpc: '2.0', method: 'runGetMethod', params: { address, method, stack } }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'toncenter error');
  return j.result.stack;
}

const sliceOf = (a: Address) => ['tvm.Slice', beginCell().storeAddress(a).endCell().toBoc().toString('base64')];
const cellFrom = (b64: string) => Cell.fromBoc(Buffer.from(b64, 'base64'))[0];

async function factoryJettonWallet(master: Address): Promise<Address> {
  const stack = await tonRun('get_wallet_address', master.toString({ testOnly: IS_TEST }), [sliceOf(Address.parse(FACTORY_ADDRESS))]);
  return cellFrom(stack[0][1].bytes).beginParse().loadAddress();
}

async function jettonData(master: Address) {
  const stack = await tonRun('get_jetton_data', master.toString({ testOnly: IS_TEST }), []);
  const supply = BigInt(stack[0][1]);
  const mintable = BigInt(stack[1][1]) !== 0n;
  const admin = cellFrom(stack[2][1].bytes).beginParse().loadAddress();
  const revoked = admin.toString().replace(/[^0]/g, '').length === 0;
  return { supply, mintable, admin, revoked };
}

function deepLink(body: Cell, amountTon = '0.1') {
  return 'ton://transfer/' + FACTORY_ADDRESS + '?amount=' + toNano(amountTon).toString() +
    '&bin=' + encodeURIComponent(body.toBoc().toString('base64'));
}

const q = BigInt(Date.now());

function setJettonWalletBody(master: Address, jw: Address) {
  return beginCell().storeUint(0x21, 32).storeUint(q, 64).storeAddress(master).storeAddress(jw).endCell();
}
function withdrawFeesBody(master: Address, dest: Address, amountNano: bigint) {
  return beginCell().storeUint(0x20, 32).storeUint(q, 64).storeAddress(master).storeAddress(dest).storeCoins(amountNano).endCell();
}
function withdrawTonBody(dest: Address, amountNano: bigint) {
  return beginCell().storeUint(0x22, 32).storeUint(q, 64).storeCoins(amountNano).storeAddress(dest).endCell();
}

function showLink(box: HTMLElement, link: string, note: string) {
  box.innerHTML = `<p class="hint">${note}</p><pre>${link}</pre>
    <button class="gray" onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(link)}'))">Copy link</button>
    <a href="${link}"><button>Open in Tonkeeper</button></a>`;
}

// ===== login =====
$('btn-login').addEventListener('click', async () => {
  const st = $('login-status');
  st.textContent = 'Logging in...';
  try {
    const j = await fetch(API_URL + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: ($('pass') as HTMLInputElement).value }),
    }).then((r) => r.json());
    if (!j.token) throw new Error('invalid passphrase');
    token = j.token;
    localStorage.setItem(LS_TOKEN, token);
    enter();
  } catch (e: any) { st.textContent = '❌ ' + e.message; st.className = 'hint err'; }
});
$('btn-logout').addEventListener('click', () => {
  localStorage.removeItem(LS_TOKEN); token = ''; location.reload();
});

function enter() {
  $('login-box').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('who').textContent = ' · session till ' + new Date(Date.now() + 12 * 3600 * 1000).toLocaleString();
  reloadAll();
}

async function reloadAll() { loadQueue(); loadFees(); loadEvents(); }
$('btn-reload').addEventListener('click', reloadAll);

// ===== queue =====
async function loadQueue() {
  const box = $('queue');
  box.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const j = await api('/api/admin/applications');
    const apps = j.applications || [];
    if (!apps.length) { box.innerHTML = '<p class="hint">No applications</p>'; return; }
    box.innerHTML = apps.map((a: any) => `
      <div class="card">
        <b>#${a.id}</b> <span class="pill ${a.status}">${a.status}</span><br/>
        master: <code>${a.jetton_master}</code><br/>
        name: ${a.applicant_name || '—'} · url: ${a.project_url ? `<a href="${a.project_url}" target="_blank">↗</a>` : '—'}<br/>
        notes: ${a.notes || '—'}<br/>
        <span class="hint">applicant: ${a.applicant}</span><br/>
        <div id="dd-${a.id}"></div>
        ${a.status === 'pending' ? `
          <button onclick="window.__nv.dd(${a.id})">Due diligence</button>
          <button onclick="window.__nv.approve(${a.id})">Approve</button>
          <button class="red" onclick="window.__nv.reject(${a.id})">Reject</button>` : ''}
        ${a.decision_reason ? `<p class="hint">reason: ${a.decision_reason}</p>` : ''}
      </div>`).join('');
  } catch (e: any) { box.innerHTML = `<p class="hint err">${e.message}</p>`; }
}

(window as any).__nv = {
  async dd(id: number) {
    const box = $('dd-' + id);
    box.innerHTML = '<p class="hint">Checking on-chain...</p>';
    try {
      const apps = (await api('/api/admin/applications')).applications;
      const a = apps.find((x: any) => x.id === id);
      const master = Address.parse(a.jetton_master);
      const d = await jettonData(master);
      box.innerHTML = `<pre>supply: ${(d.supply / 10n ** 9n).toString()}
mintable: ${d.mintable ? '⚠️ YES (rug risk)' : '✅ no (revoked)'}
admin: ${d.revoked ? '✅ zero (revoked)' : '⚠️ ' + d.admin.toString()}</pre>`;
    } catch (e: any) { box.innerHTML = `<p class="hint err">DD failed: ${e.message}</p>`; }
  },
  async approve(id: number) {
    const box = $('dd-' + id);
    box.innerHTML = '<p class="hint">Approving...</p>';
    try {
      const r = await api('/api/admin/applications/approve', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      const m = r.multisig;
      box.innerHTML = `
        <p class="ok">✅ Approved in DB + whitelist updated.</p>
        <p class="hint">On-chain шаг — подпиши в multisig.ton.org (2-of-3):</p>
        <p><b>Target:</b> <code>${m.target}</code></p>
        <p><b>Value:</b> ${m.value} TON</p>
        <p><b>Factory JW:</b> <code>${m.factory_jetton_wallet}</code></p>
        <p><b>query_id:</b> ${m.query_id}</p>
        <p><b>Body:</b></p>
        <pre>${m.body_base64}</pre>
        <button class="gray" onclick="navigator.clipboard.writeText('${m.body_base64}')">Copy Body</button>
        <a href="https://multisig.ton.org" target="_blank" rel="noopener"><button>Open multisig.ton.org</button></a>
      `;
    } catch (e: any) {
      box.innerHTML = `<p class="hint err">Approve failed: ${e.message}</p>`;
    }
  },
  async reject(id: number) {
    const reason = prompt('Reject reason (will be shown to applicant):');
    if (reason === null) return;
    try {
      await api('/api/admin/applications/reject', { method: 'POST', body: JSON.stringify({ id, reason }) });
      loadQueue();
    } catch (e: any) { alert('❌ ' + e.message); }
  },
};

// ===== fees =====
async function loadFees() {
  const box = $('fees');
  try {
    const s = await api('/api/admin/stats');
    box.innerHTML = `<p>Jetton fees: <b>${(BigInt(s.jetton_fees_nano) / 10n ** 9n).toString()}</b> (nano: ${s.jetton_fees_nano})</p>
      <p>TON fees accumulated: <b>${(BigInt(s.ton_fees_accumulated) / 10n ** 9n).toString()}</b> TON · withdrawn: ${(BigInt(s.ton_fees_withdrawn) / 10n ** 9n).toString()}</p>
      <p class="hint">locks: ${s.total_locks} · locked: ${s.locked} · ready: ${s.ready_to_claim}</p>`;
  } catch (e: any) { box.innerHTML = `<p class="hint err">${e.message}</p>`; }
}

$('btn-wf').addEventListener('click', () => {
  try {
    const master = Address.parse(($('wf-master') as HTMLInputElement).value.trim());
    const dest = Address.parse(($('wf-dest') as HTMLInputElement).value.trim());
    const amount = BigInt(Math.round(parseFloat(($('wf-amount') as HTMLInputElement).value) * 1e9));
    showLink($('withdraw-out'), deepLink(withdrawFeesBody(master, dest, amount)), 'Sign with treasury: WithdrawFees');
  } catch (e: any) { $('withdraw-out').innerHTML = `<p class="hint err">${e.message}</p>`; }
});
$('btn-wt').addEventListener('click', () => {
  try {
    const dest = Address.parse(($('wt-dest') as HTMLInputElement).value.trim());
    const amount = toNano(($('wt-amount') as HTMLInputElement).value);
    showLink($('withdraw-out'), deepLink(withdrawTonBody(dest, amount)), 'Sign with treasury: WithdrawTonFees');
  } catch (e: any) { $('withdraw-out').innerHTML = `<p class="hint err">${e.message}</p>`; }
});

// ===== events =====
async function loadEvents() {
  const box = $('events');
  try {
    const j = await api('/api/admin/events');
    const ev = j.events || [];
    if (!ev.length) { box.innerHTML = '<p class="hint">No events yet</p>'; return; }
    box.innerHTML = `<table><tr><th>id</th><th>type</th><th>lock</th><th>time</th></tr>` +
      ev.map((e: any) => `<tr><td>${e.id}</td><td>${e.event_type}</td><td>#${e.lock_id}</td><td>${new Date(e.created_at).toLocaleString()}</td></tr>`).join('') +
      `</table>`;
  } catch (e: any) { box.innerHTML = `<p class="hint err">${e.message}</p>`; }
}

// auto-enter if token exists
if (token) {
  api('/api/admin/me').then(() => enter()).catch(() => localStorage.removeItem(LS_TOKEN));
}
