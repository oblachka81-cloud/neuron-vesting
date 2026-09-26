import { toNano, Address, beginCell } from '@ton/core';
import type { TonConnectUI } from '@tonconnect/ui';
import { API_URL, EXPLORER, FACTORY_ADDRESS, TONCENTER } from './config';
import { buildClaimBody } from './ton';

type Lock = {
  lock_id: string; creator: string; beneficiary: string; jetton_master: string;
  amount: string; claimed_amount: string; unlock_at: string; lockup_wallet: string;
  status: 'locked' | 'ready' | 'claimed';
};

let currentWallet: string | null = null;
let tcRef: TonConnectUI | null = null;
const pad = (n: number) => String(n).padStart(2, '0');

export function mountCabinet(tc: TonConnectUI) {
  tcRef = tc;
  tc.onStatusChange((w) => {
    currentWallet = w ? w.account.address : null;
    refreshLocks();
  });

  document.getElementById('btn-refresh-locks')?.addEventListener('click', refreshLocks);
  (document.getElementById('app-form') as HTMLFormElement).addEventListener('submit', onAppSubmit);

  // first load
  refreshWhitelist();
}

async function refreshLocks() {
  const list = document.getElementById('locks-list')!;
  if (!currentWallet) { list.innerHTML = '<p class="hint">Connect wallet to see your locks</p>'; return; }
  list.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const r = await fetch(`${API_URL}/api/locks?wallet=${currentWallet}`);
    const j = await r.json();
    const locks: Lock[] = j.locks || [];
    if (locks.length === 0) { list.innerHTML = '<p class="hint">No locks yet</p>'; return; }
    list.innerHTML = locks.map(lockCard).join('');
    list.querySelectorAll('[data-claim]').forEach((b) => {
      b.addEventListener('click', () => onClaim(
        (b as HTMLElement).dataset.lockId!,
        (b as HTMLElement).dataset.wallet!
      ));
    });
    startTimers();
  } catch (e: any) {
    list.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }
}

function lockCard(l: Lock) {
  const amt = (BigInt(l.amount) / 10n ** 9n).toString();
  let status: string;
  if (l.status === 'claimed') status = '✅ received';
  else if (l.status === 'ready') {
    const isBen = currentWallet && l.beneficiary.toLowerCase() === currentWallet.toLowerCase();
    const claimBtn = isBen
      ? `<button class="btn-claim" data-claim data-lock-id="${l.lock_id}" data-wallet="${l.lockup_wallet}">Claim</button>`
      : `<span class="hint" style="margin-left:8px">(claim for beneficiary only)</span>`;
    status = ` <span data-timer="${l.unlock_at}" class="timer">ready</span>${claimBtn}`;
  } else {
    status = ` unlocks in <span data-timer="${l.unlock_at}" class="timer"></span>`;
  }
  const ms = l.jetton_master.slice(0, 6) + '...' + l.jetton_master.slice(-4);
  return `<div class="lock-card">
    <div class="lock-head">#${l.lock_id} · <code>${ms}</code> · ${amt}</div>
    <div class="lock-status">${status}</div>
    <div class="lock-foot">
      <a href="${EXPLORER(l.lockup_wallet)}" target="_blank">lockup wallet ↗</a>
    </div>
  </div>`;
}

function startTimers() {
  if ((window as any).__nv_timer) clearInterval((window as any).__nv_timer);
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    document.querySelectorAll('[data-timer]').forEach((el) => {
      const t = Number((el as HTMLElement).dataset.timer);
      const diff = t - now;
      if (diff <= 0) { (el as HTMLElement).textContent = 'ready'; return; }
      const d = Math.floor(diff / 86400);
      const h = Math.floor((diff % 86400) / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      (el as HTMLElement).textContent = d > 0
        ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`
        : `${pad(h)}:${pad(m)}:${pad(s)}`;
    });
  };
  tick();
  (window as any).__nv_timer = setInterval(tick, 1000);
}

async function onClaim(_lockId: string, wallet: string) {
  if (!tcRef || !currentWallet) return;
  try {
    const body = buildClaimBody(BigInt(Date.now()));
    const walletAddress = Address.parse(wallet).toString({ urlSafe: true });
    await tcRef.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [{
        address: walletAddress,
        amount: toNano('0.05').toString(),
        payload: body.toBoc().toString('base64'),
      }],
    });
    alert('✅ Claim sent. Refreshing in a few seconds.');
    setTimeout(refreshLocks, 5000);
  } catch (e: any) {
    alert('❌ ' + (e.message || 'Cancelled'));
  }
}

async function refreshApps() {
  const list = document.getElementById('apps-list')!;
  if (!currentWallet) { list.innerHTML = '<p class="hint">Connect wallet</p>'; return; }
  const mine = JSON.parse(localStorage.getItem('nv_my_apps') || '[]');
  if (mine.length === 0) { list.innerHTML = '<p class="hint">No applications yet</p>'; return; }
  list.innerHTML = '<p class="hint">Loading...</p>';
  const rows = [];
  for (const a of mine) {
    try {
      const r = await fetch(`${API_URL}/api/applications/status/${a.id}`);
      const j = await r.json();
      rows.push(j.application || a);
    } catch { rows.push(a); }
  }
  list.innerHTML = rows.map((a: any) => `<div class="lock-card">
    <div class="lock-head">#${a.id} · <code>${a.jetton_master.slice(0,6)}...</code></div>
    <div class="lock-status">${statusBadge(a.status)} ${a.decision_reason ? '· ' + a.decision_reason : ''}</div>
  </div>`).join('');
}

function statusBadge(s: string) {
  if (s === 'approved') return '✅ approved';
  if (s === 'rejected') return '❌ rejected';
  return '⏳ pending';
}

async function onAppSubmit(e: Event) {
  e.preventDefault();
  const statusEl = document.getElementById('app-status')!;
  if (!currentWallet) { statusEl.textContent = 'Connect wallet first'; statusEl.className = 'status err'; return; }
  statusEl.textContent = 'Submitting...';
  statusEl.className = 'status';
  try {
    const body = {
      jetton_master: (document.getElementById('app-jm') as HTMLInputElement).value.trim(),
      applicant: currentWallet,
      applicant_name: (document.getElementById('app-name') as HTMLInputElement).value.trim(),
      project_url: (document.getElementById('app-url') as HTMLInputElement).value.trim() || null,
      notes: (document.getElementById('app-notes') as HTMLTextAreaElement).value || null,
    };
    const r = await fetch(`${API_URL}/api/applications`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    const mine = JSON.parse(localStorage.getItem('nv_my_apps') || '[]');
    mine.unshift({ id: j.application.id, jetton_master: body.jetton_master, status: 'pending' });
    localStorage.setItem('nv_my_apps', JSON.stringify(mine));
    statusEl.textContent = `✅ Submitted! ID #${j.application.id}`;
    statusEl.className = 'status ok';
    (document.getElementById('app-form') as HTMLFormElement).reset();
    refreshApps();
  } catch (e: any) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.className = 'status err';
  }
}

async function jettonIcon(master: string): Promise<string | null> {
  try {
    const r = await fetch(`${API_URL}/api/jetton/${encodeURIComponent(master)}/icon`);
    const j = await r.json();
    return j.image || null;
  } catch { return null; }
}

// ── on-chain check: does factory know this master? ───────────────────────
function stackNum(e: any): bigint {
  const s = String(Array.isArray(e) ? e[1] : e);
  if (s.startsWith('-0x')) return -BigInt('0x' + s.slice(3));
  if (s.startsWith('0x')) return BigInt(s);
  return BigInt(s);
}

async function isWhitelistedOnchain(master: string): Promise<boolean> {
  try {
    const cell = beginCell().storeAddress(Address.parse(master)).endCell();
    const res = await fetch(TONCENTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '1', jsonrpc: '2.0', method: 'runGetMethod',
        params: {
          address: FACTORY_ADDRESS,
          method: 'isWalletSet',
          stack: [['tvm.Slice', cell.toBoc().toString('base64')]],
        },
      }),
    });
    const json = await res.json();
    if (!json.ok) return false;
    return stackNum(json.result.stack[0]) !== 0n;
  } catch { return false; }
}

async function refreshWhitelist() {
  const list = document.getElementById('whitelist-list')!;
  list.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const r = await fetch(`${API_URL}/api/whitelist`);
    const j = await r.json();
    const wl = j.whitelist || [];
    if (wl.length === 0) { list.innerHTML = '<p class="hint">No approved jettons yet</p>'; return; }
    const rows: string[] = [];
    for (const x of wl) {
      const onchain = await isWhitelistedOnchain(x.jetton_master);
      rows.push(`<div class="lock-card">
        <div class="lock-head">
          <img data-icon="${x.jetton_master}" width="26" height="26" alt=""
               style="border-radius:50%;vertical-align:middle;background:#222;margin-right:6px" />
          <b>${x.symbol || '?'}</b> · ${x.name || '—'}
          <span style="margin-left:8px;font-size:11px;padding:2px 8px;border-radius:10px;background:${onchain ? '#1d4d2b' : '#6b2b2b'};color:#fff">
            ${onchain ? 'ON-CHAIN ✓' : 'NOT ON-CHAIN'}
          </span>
        </div>
        <div class="lock-foot"><code>${x.jetton_master}</code> ·
          <a href="${EXPLORER(x.jetton_master)}" target="_blank">explorer ↗</a></div>
      </div>`);
    }
    list.innerHTML = rows.join('');
    const imgs = Array.from(list.querySelectorAll('img[data-icon]')) as HTMLImageElement[];
    for (const img of imgs) {
      const src = await jettonIcon(img.dataset.icon!);
      if (src) img.src = src; else img.style.display = 'none';
      await new Promise((r2) => setTimeout(r2, 300));
    }
  } catch (e: any) {
    list.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }
}

// ── Vaults Tab Logic ───────────────────────────────────────────────────────

function formatUSD(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function formatCoins(nano: bigint | string): string {
  return (BigInt(nano) / 10n ** 9n).toLocaleString('en-US');
}

async function refreshVaults() {
  const summaryEl = document.getElementById('vaults-summary')!;
  const jettonsEl = document.getElementById('vaults-jettons')!;
  
  try {
    const r = await fetch(`${API_URL}/api/locks/public`);
    const j = await r.json();
    
    const totalTVL_nano = BigInt(j.summary.total.total_tvl_nano);
    const totalTVL_coins = Number(totalTVL_nano / 10n ** 9n);
    const totalTVL_usd = totalTVL_coins * j.price_usd;
    const totalLocks = j.summary.total.total_locks;

    summaryEl.innerHTML = `
      <div class="vault-stats">
        <div class="stat-box">
          <div class="stat-label">Total Value Locked</div>
          <div class="stat-value">${formatUSD(totalTVL_usd)}</div>
          <div class="stat-sub">${formatCoins(totalTVL_nano)} COGNIQ</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Active Locks</div>
          <div class="stat-value">${totalLocks}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">COGNIQ Price</div>
          <div class="stat-value">$${j.price_usd.toFixed(6)}</div>
        </div>
      </div>
    `;

    if (j.summary.by_jetton.length === 0) {
      jettonsEl.innerHTML = '<p class="hint">No active locks yet</p>';
    } else {
      const rows = await Promise.all(j.summary.by_jetton.map(async (x: any) => {
        const iconSrc = await jettonIcon(x.jetton_master);
        return `
          <div class="jetton-row" style="cursor:pointer;" onclick="window.__nv.showJettonDetails('${x.jetton_master}')">
            ${iconSrc ? `<img src="${iconSrc}" width="24" height="24" style="border-radius:50%; margin-right:8px;" />` : ''}
            <span class="jetton-addr">${x.jetton_master.slice(0, 6)}...${x.jetton_master.slice(-4)}</span>
            <span class="jetton-tvl">${formatCoins(x.tvl_nano)}</span>
            <span class="jetton-count">${x.locks} locks</span>
          </div>
        `;
      }));
      jettonsEl.innerHTML = rows.join('');
    }
  } catch (e: any) {
    summaryEl.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }
}

// ── Jetton Details Modal ──────────────────────────────────────────────────

async function showJettonDetails(master: string) {
  const modal = document.getElementById('jetton-modal')!;
  const content = document.getElementById('modal-content')!;
  
  modal.style.display = 'block';
  content.innerHTML = '<p class="hint">Loading locks...</p>';
  
  try {
    const r = await fetch(`${API_URL}/api/locks/by-jetton?master=${encodeURIComponent(master)}`);
    const j = await r.json();
    const iconSrc = await jettonIcon(master);
    
    const locksHtml = j.locks.map((l: any) => {
      const now = Math.floor(Date.now() / 1000);
      const status = l.claimed_amount >= l.amount ? '✅ claimed' :
                     l.unlock_at <= now ? '⏰ ready' : '🔒 locked';
      const amt = (BigInt(l.amount) / 10n ** 9n).toString();
      const unlockDate = new Date(l.unlock_at * 1000).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      
      return `
        <div class="lock-detail-row">
          <div class="lock-detail-header">
            <span class="lock-id">#${l.lock_id}</span>
            <span class="lock-status">${status}</span>
          </div>
          <div class="lock-detail-info">
            <div><b>Amount:</b> ${amt}</div>
            <div><b>Unlock:</b> ${unlockDate}</div>
            <div><b>Creator:</b> ${l.creator.slice(0, 6)}...${l.creator.slice(-4)}</div>
          </div>
          <div class="lock-detail-footer">
            <a href="${EXPLORER(l.lockup_wallet)}" target="_blank" class="btn-small">View in Explorer ↗</a>
          </div>
        </div>
      `;
    }).join('');
    
    content.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px;">
        ${iconSrc ? `<img src="${iconSrc}" width="40" height="40" style="border-radius:50%; background:#222;" />` : ''}
        <div>
          <div style="font-family:monospace; font-size:12px; color:#888;">${master}</div>
          <div style="font-size:14px; color:#4ade80;">${j.locks.length} locks</div>
        </div>
      </div>
      <div class="locks-detail-list">
        ${locksHtml}
      </div>
    `;
  } catch (e: any) {
    content.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }
  
  document.getElementById('modal-close')!.onclick = () => { modal.style.display = 'none'; };
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
}

// Expose ALL functions (ЧИСТЫЙ ЭКСПОРТ - без дубликатов)
(window as any).__nv = { 
  refreshLocks, 
  refreshApps, 
  refreshWhitelist, 
  refreshVaults, 
  showJettonDetails 
};

// dynamic pill: reflects on-chain state of COGNIQ in new factory
(async () => {
  const el = document.getElementById('pill-wl');
  if (!el) return;
  const ok = await isWhitelistedOnchain('EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg');
  el.textContent = ok ? 'COGNIQ WHITELISTED ✓' : 'COGNIQ: NOT WHITELISTED';
  el.style.background = ok ? '#1d4d2b' : '#6b2b2b';
  el.style.color = '#fff';
})();
