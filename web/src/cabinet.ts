import { toNano, Address, beginCell, Cell } from '@ton/core';
import type { TonConnectUI } from '@tonconnect/ui';
import { API_URL, EXPLORER, FACTORY_ADDRESS, TONCENTER } from './config';

type Lock = {
  lock_id: string;
  creator: string;
  beneficiary: string;
  jetton_master: string;
  amount: string;
  claimed_amount: string;
  unlock_at: string;
  lockup_wallet: string;
  status: 'locked' | 'ready' | 'claimed';
  decimals?: string | number;
};

type EnrichedLock = Lock & {
  decimals: number;
  displayStatus: 'locked' | 'ready' | 'in_flight' | 'claimed';
  displayClaimed: bigint;
  displayAvailable: bigint;
  pending: boolean;
  pendingSetAt: bigint;
  resettable: boolean;
};

let currentWallet: string | null = null;
let tcRef: TonConnectUI | null = null;

const pad = (n: number) => String(n).padStart(2, '0');
const RESET_TIMEOUT = 3600;
const MESSAGE_VALUE = toNano('0.05');

const localPending = new Set<string>();
let refreshInFlight = false;
let refreshQueued = false;

export function mountCabinet(tc: TonConnectUI) {
  tcRef = tc;

  tc.onStatusChange((w) => {
    currentWallet = w ? w.account.address : null;
    refreshLocks();
  });

  document.getElementById('btn-refresh-locks')?.addEventListener('click', refreshLocks);
  (document.getElementById('app-form') as HTMLFormElement)?.addEventListener('submit', onAppSubmit);

  // Единый делегат на список — переживает любую перерисовку карточек,
  // слушатели больше не навешиваются по кругу и не текут.
  const list = document.getElementById('locks-list');
  list?.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement)?.closest?.(
      '[data-claim-full],[data-claim-partial],[data-reset]',
    ) as HTMLElement | null;
    if (!btn) return;
    const lockId = btn.dataset.lockId!;
    const wallet = btn.dataset.wallet!;
    if (btn.hasAttribute('data-claim-full')) {
      onClaim(lockId, wallet, 'full');
    } else if (btn.hasAttribute('data-claim-partial')) {
      const inp = list!.querySelector<HTMLInputElement>(`[data-partial="${lockId}"]`);
      onClaim(
        lockId,
        wallet,
        'partial',
        inp?.value || '',
        Number(btn.dataset.decimals || 9),
        btn.dataset.available,
      );
    } else if (btn.hasAttribute('data-reset')) {
      onReset(lockId, wallet);
    }
  });

  refreshWhitelist();
  refreshLocks();
}

// ── Address helpers ──────────────────────────────────────────────────────

function normAddr(a: string): string {
  try {
    return Address.parse(a).toRawString();
  } catch {
    return String(a || '').toLowerCase();
  }
}

function sameAddr(a: string, b: string): boolean {
  return normAddr(a) === normAddr(b);
}

// ── Message builders ─────────────────────────────────────────────────────

function makeQid(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

function buildClaimBody(qid: bigint, amount: bigint): Cell {
  return beginCell()
    .storeUint(0x10, 32)
    .storeUint(qid, 64)
    .storeCoins(amount)
    .endCell();
}

function buildResetBody(qid: bigint): Cell {
  return beginCell()
    .storeUint(0x11, 32)
    .storeUint(qid, 64)
    .endCell();
}

// ── TON Center getter helper ─────────────────────────────────────────────

function stackNum(e: any): bigint {
  const s = String(Array.isArray(e) ? e[1] : e);
  if (s.startsWith('-0x')) return -BigInt('0x' + s.slice(3));
  if (s.startsWith('0x')) return BigInt(s);
  return BigInt(s);
}

async function runGetter(address: string, method: string): Promise<bigint | null> {
  try {
    const res = await fetch(TONCENTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '1',
        jsonrpc: '2.0',
        method: 'runGetMethod',
        params: { address, method, stack: [] },
      }),
    });

    const json = await res.json();
    if (!json.ok || !json.result?.stack?.length) return null;

    return stackNum(json.result.stack[0]);
  } catch {
    return null;
  }
}

// ── Token formatting ─────────────────────────────────────────────────────

function safeDecimals(d: any): number {
  const n = Number(d ?? 9);
  if (!Number.isFinite(n)) return 9;
  return Math.max(0, Math.min(18, Math.floor(n)));
}

function formatTokens(nano: bigint, decimals: number): string {
  const neg = nano < 0n;
  const abs = neg ? -nano : nano;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const fracRaw = (abs % base).toString().padStart(decimals, '0');
  const frac = fracRaw.replace(/0+$/, '');

  return `${neg ? '-' : ''}${int.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

function parseTokenInput(value: string, decimals: number): bigint | null {
  const v = String(value || '').trim().replace(',', '.');
  if (!v || v === '.') return null;
  if (!/^\d*(\.\d*)?$/.test(v)) return null;

  const [intPart = '0', fracPart = ''] = v.split('.');
  const frac = fracPart.slice(0, decimals).padEnd(decimals, '0');
  const base = 10n ** BigInt(decimals);

  try {
    return BigInt(intPart || '0') * base + BigInt(frac || '0');
  } catch {
    return null;
  }
}

// ── Concurrency helper ───────────────────────────────────────────────────

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      result[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return result;
}

// ── My Locks ─────────────────────────────────────────────────────────────

async function refreshLocks() {
  const list = document.getElementById('locks-list');
  if (!list) return;

  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;

  try {
    if (!currentWallet) {
      list.innerHTML = '<p class="hint">Connect wallet to see your locks</p>';
      return;
    }

    // Спиннер — ТОЛЬКО когда карточек ещё нет (первый вход / смена кошелька).
    // При повторных refresh старые карточки остаются на экране, моргания нет.
    const hasCards = !!list.querySelector('[data-lock-id]');
    if (!hasCards) list.innerHTML = '<p class="hint">Loading...</p>';

    const r = await fetch(`${API_URL}/api/locks?wallet=${encodeURIComponent(currentWallet)}`);
    const j = await r.json();
    const locks: Lock[] = j.locks || [];

    if (locks.length === 0) {
      list.innerHTML = '<p class="hint">No locks yet</p>';
      return;
    }

    // Мгновенный каркас по данным БД (статус ready/locked/claimed уже валиден).
    list.innerHTML = locks.map(lockCardShell).join('');
    startTimers();

    // On-chain уточнение — фоном, патчит каждую карточку по id, список не трогает.
    await Promise.allSettled(
      locks.map(async (l) => {
        try {
          const e = await enrichLock(l);
          patchLock(e);
        } catch {
          /* тонцентр тормознул/лимит — карточка остаётся по БД, не падаем */
        }
      }),
    );
  } catch (e: any) {
    if (!hasCards) {
      list.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
    }
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshLocks();
    }
  }
}

async function enrichLock(l: Lock): Promise<EnrichedLock> {
  const now = Math.floor(Date.now() / 1000);
  const amount = BigInt(l.amount);
  const dbClaimed = BigInt(l.claimed_amount || '0');
  const decimals = safeDecimals((l as any).decimals);

  const shouldReadOnchain = l.status !== 'locked' || Number(l.unlock_at) <= now;

  let claimedOnchain: bigint | null = null;
  let availableOnchain: bigint | null = null;
  let pending = false;
  let pendingSetAt = 0n;

  if (shouldReadOnchain && l.lockup_wallet) {
    claimedOnchain = await runGetter(l.lockup_wallet, 'claimedAmount');
    availableOnchain = await runGetter(l.lockup_wallet, 'availableClaimable');

    const claimedForCheck = claimedOnchain ?? dbClaimed;

    if (
      (availableOnchain === null || availableOnchain === 0n) &&
      claimedForCheck < amount &&
      Number(l.unlock_at) <= now
    ) {
      const p = await runGetter(l.lockup_wallet, 'isPendingClaim');
      if (p !== null && p !== 0n) {
        pending = true;
        const ps = await runGetter(l.lockup_wallet, 'pendingSetAt');
        pendingSetAt = ps ?? 0n;
      }
    }
  }

  const displayClaimed = claimedOnchain ?? dbClaimed;
  let displayAvailable =
    availableOnchain ?? (amount > displayClaimed ? amount - displayClaimed : 0n);

  if (pending) displayAvailable = 0n;

  let displayStatus: EnrichedLock['displayStatus'];

  if (displayClaimed >= amount) {
    displayStatus = 'claimed';
  } else if (pending) {
    displayStatus = 'in_flight';
  } else if (Number(l.unlock_at) <= now) {
    displayStatus = 'ready';
  } else {
    displayStatus = 'locked';
  }

  if (displayStatus !== 'ready') {
    localPending.delete(String(l.lock_id));
  }

  const resettable =
    pending &&
    pendingSetAt > 0n &&
    BigInt(now) >= pendingSetAt + BigInt(RESET_TIMEOUT);

  return {
    ...l,
    decimals,
    displayStatus,
    displayClaimed,
    displayAvailable,
    pending,
    pendingSetAt,
    resettable,
  };
}

// Кнопки claim/partial — общие для каркаса и полной карточки.
function claimControls(
  lockId: string,
  wallet: string,
  availText: string,
  availNano: bigint,
  decimals: number,
) {
  return `
    ⏰ ready
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn-claim" data-claim-full data-lock-id="${lockId}" data-wallet="${wallet}">Claim all</button>
      <input class="partial-input" data-partial="${lockId}" type="text" inputmode="decimal" placeholder="partial amount"
        style="min-width:150px;padding:6px 8px;border-radius:8px;border:1px solid #333;background:#111;color:#fff"/>
      <button class="btn-claim-partial" data-claim-partial data-lock-id="${lockId}" data-wallet="${wallet}"
        data-available="${availNano.toString()}" data-decimals="${decimals}">Claim part</button>
    </div>
    <div class="hint" style="margin-top:6px">available: ${availText}</div>`;
}

// Каркас по данным БД — рисуется мгновенно, без тонцентра.
function lockCardShell(l: Lock) {
  const amount = BigInt(l.amount);
  const claimed = BigInt(l.claimed_amount || '0');
  const decimals = safeDecimals((l as any).decimals);
  const amt = formatTokens(amount, decimals);
  const cl = formatTokens(claimed, decimals);
  const avail = amount > claimed ? formatTokens(amount - claimed, decimals) : '0';
  const progress = amount > 0n ? Number((claimed * 100n) / amount) : 100;
  const isBen = currentWallet ? sameAddr(l.beneficiary, currentWallet) : false;
  const ms = l.jetton_master.slice(0, 6) + '...' + l.jetton_master.slice(-4);

  let status: string;
  if (l.status === 'claimed') {
    status = '✅ received';
  } else if (l.status === 'ready') {
    status = isBen
      ? claimControls(l.lock_id, l.lockup_wallet, avail, amount - claimed, decimals)
      : `⏰ ready <span class="hint">(claim for beneficiary only)</span>`;
  } else {
    status = `🔒 unlocks in <span data-timer="${l.unlock_at}" class="timer"></span>`;
  }

  return `<div class="lock-card" data-lock-id="${l.lock_id}">
    <div class="lock-head">#${l.lock_id} · <code>${ms}</code> · ${amt}</div>
    <div class="lock-status">${status}</div>
    <div class="hint" style="margin-top:6px">claimed: ${cl} / ${amt} · ${progress}%</div>
    <div class="lock-foot"><a href="${EXPLORER(l.lockup_wallet)}" target="_blank" rel="noopener">lockup wallet ↗</a></div>
  </div>`;
}

// Полная карточка по обогащённым (on-chain) данным — для патча.
function lockCardFull(l: EnrichedLock) {
  const amount = BigInt(l.amount);
  const amt = formatTokens(amount, l.decimals);
  const claimed = formatTokens(l.displayClaimed, l.decimals);
  const available = formatTokens(l.displayAvailable, l.decimals);
  const isBen = currentWallet ? sameAddr(l.beneficiary, currentWallet) : false;
  const isLocalPending = localPending.has(String(l.lock_id));
  const progress = amount > 0n ? Number((l.displayClaimed * 100n) / amount) : 100;
  const ms = l.jetton_master.slice(0, 6) + '...' + l.jetton_master.slice(-4);

  let status: string;
  if (l.displayStatus === 'claimed') {
    status = '✅ received';
  } else if (l.displayStatus === 'in_flight') {
    status = '⏳ claim in flight';
    if (l.resettable && isBen) {
      status += ` <button class="btn-reset" style="margin-left:8px" data-reset data-lock-id="${l.lock_id}" data-wallet="${l.lockup_wallet}">Reset</button>`;
    } else if (l.pendingSetAt > 0n) {
      status += ` · reset in <span data-reset-timer="${Number(l.pendingSetAt + BigInt(RESET_TIMEOUT))}" class="timer"></span>`;
    }
  } else if (l.displayStatus === 'ready') {
    status = isLocalPending
      ? '⏳ transaction sent, waiting confirmation'
      : isBen
        ? claimControls(l.lock_id, l.lockup_wallet, available, l.displayAvailable, l.decimals)
        : `⏰ ready <span class="hint">(claim for beneficiary only)</span>`;
  } else {
    status = `🔒 unlocks in <span data-timer="${l.unlock_at}" class="timer"></span>`;
  }

  return `<div class="lock-card" data-lock-id="${l.lock_id}">
    <div class="lock-head">#${l.lock_id} · <code>${ms}</code> · ${amt}</div>
    <div class="lock-status">${status}</div>
    <div class="hint" style="margin-top:6px">claimed: ${claimed} / ${amt} · ${progress}%</div>
    <div class="lock-foot"><a href="${EXPLORER(l.lockup_wallet)}" target="_blank" rel="noopener">lockup wallet ↗</a></div>
  </div>`;
}

// Патч ОДНОЙ карточки по id — список и соседние карточки не трогаем.
function patchLock(l: EnrichedLock) {
  const list = document.getElementById('locks-list');
  if (!list) return;
  const node = list.querySelector(`[data-lock-id="${CSS.escape(String(l.lock_id))}"]`);
  if (!node) return; // лок уже ушёл из DOM (сменили кошелёк) — некуда патчить
  const tmp = document.createElement('div');
  tmp.innerHTML = lockCardFull(l).trim();
  node.replaceWith(tmp.firstElementChild!);
}

function startTimers() {
  if ((window as any).__nv_timer) clearInterval((window as any).__nv_timer);

  let planned = false;
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    let crossed = false;

    document.querySelectorAll('[data-timer], [data-reset-timer]').forEach((el) => {
      const htmlEl = el as HTMLElement;
      const t = Number(htmlEl.dataset.timer || htmlEl.dataset.resetTimer);
      const diff = t - now;

      if (diff <= 0) {
        htmlEl.textContent = 'ready';
        crossed = true;
        return;
      }

      const d = Math.floor(diff / 86400);
      const h = Math.floor((diff % 86400) / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;

      htmlEl.textContent =
        d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
    });

    // Один refresh на переход через unlock/reset, не шторм каждую секунду.
    if (crossed && !planned) {
      planned = true;
      setTimeout(() => {
        planned = false;
        refreshLocks();
      }, 1200);
    }
  };

  tick();
  (window as any).__nv_timer = setInterval(tick, 1000);
}

async function sendWalletMessage(wallet: string, body: Cell): Promise<boolean> {
  if (!tcRef || !currentWallet) return false;

  try {
    const walletAddress = Address.parse(wallet).toString({ urlSafe: true });

    await tcRef.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [
        {
          address: walletAddress,
          amount: MESSAGE_VALUE.toString(),
          payload: body.toBoc().toString('base64'),
        },
      ],
    });

    return true;
  } catch (e: any) {
    alert('❌ ' + (e.message || 'Cancelled'));
    return false;
  }
}

async function onClaim(
  lockId: string,
  wallet: string,
  mode: 'full' | 'partial',
  rawAmount = '',
  decimals = 9,
  availableNano?: string,
) {
  if (!tcRef || !currentWallet) return;

  let amount = 0n;

  if (mode === 'partial') {
    const parsed = parseTokenInput(rawAmount, decimals);
    if (parsed === null || parsed <= 0n) {
      alert('Enter a valid partial amount');
      return;
    }

    if (availableNano) {
      const available = BigInt(availableNano);
      if (parsed > available) {
        alert('Amount is larger than available');
        return;
      }
      // Если ввели ровно available — используем full-claim семантику (amount=0).
      amount = parsed === available ? 0n : parsed;
    } else {
      amount = parsed;
    }
  }

  localPending.add(String(lockId));
  refreshLocks();

  const qid = makeQid();
  const body = buildClaimBody(qid, amount);

  const ok = await sendWalletMessage(wallet, body);
  if (!ok) {
    localPending.delete(String(lockId));
    refreshLocks();
    return;
  }

  alert('✅ Claim sent. Refreshing in a few seconds.');
  setTimeout(refreshLocks, 5000);
  setTimeout(refreshLocks, 15000);
}

async function onReset(lockId: string, wallet: string) {
  if (!tcRef || !currentWallet) return;

  localPending.add(String(lockId));
  refreshLocks();

  const qid = makeQid();
  const body = buildResetBody(qid);

  const ok = await sendWalletMessage(wallet, body);
  if (!ok) {
    localPending.delete(String(lockId));
    refreshLocks();
    return;
  }

  alert('✅ Reset sent. Refreshing in a few seconds.');
  setTimeout(refreshLocks, 5000);
  setTimeout(refreshLocks, 15000);
}

// ── Applications ─────────────────────────────────────────────────────────

async function refreshApps() {
  const list = document.getElementById('apps-list');
  if (!list) return;

  if (!currentWallet) {
    list.innerHTML = '<p class="hint">Connect wallet</p>';
    return;
  }

  const mine = JSON.parse(localStorage.getItem('nv_my_apps') || '[]');
  if (mine.length === 0) {
    list.innerHTML = '<p class="hint">No applications yet</p>';
    return;
  }

  list.innerHTML = '<p class="hint">Loading...</p>';

  const rows = [];
  for (const a of mine) {
    try {
      const r = await fetch(`${API_URL}/api/applications/status/${a.id}`);
      const j = await r.json();
      rows.push(j.application || a);
    } catch {
      rows.push(a);
    }
  }

  list.innerHTML = rows
    .map(
      (a: any) => `<div class="lock-card">
        <div class="lock-head">#${a.id} · <code>${String(a.jetton_master).slice(0, 6)}...</code></div>
        <div class="lock-status">${statusBadge(a.status)} ${a.decision_reason ? '· ' + a.decision_reason : ''}</div>
      </div>`,
    )
    .join('');
}

function statusBadge(s: string) {
  if (s === 'approved') return '✅ approved';
  if (s === 'rejected') return '❌ rejected';
  return '⏳ pending';
}

async function onAppSubmit(e: Event) {
  e.preventDefault();

  const statusEl = document.getElementById('app-status')!;
  if (!currentWallet) {
    statusEl.textContent = 'Connect wallet first';
    statusEl.className = 'status err';
    return;
  }

  statusEl.textContent = 'Submitting...';
  statusEl.className = 'status';

  try {
    const body = {
      jetton_master: (document.getElementById('app-jm') as HTMLInputElement).value.trim(),
      applicant: currentWallet,
      applicant_name: (document.getElementById('app-name') as HTMLInputElement).value.trim(),
      project_url:
        (document.getElementById('app-url') as HTMLInputElement).value.trim() || null,
      notes: (document.getElementById('app-notes') as HTMLTextAreaElement).value || null,
    };

    const r = await fetch(`${API_URL}/api/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');

    const mine = JSON.parse(localStorage.getItem('nv_my_apps') || '[]');
    mine.unshift({
      id: j.application.id,
      jetton_master: body.jetton_master,
      status: 'pending',
    });

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

// ── Icons + whitelist ────────────────────────────────────────────────────

async function jettonIcon(master: string): Promise<string | null> {
  try {
    const r = await fetch(`${API_URL}/api/jetton/${encodeURIComponent(master)}/icon`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.image || null;
  } catch {
    return null;
  }
}

/** img с no-referrer — postimg/cdn часто режут hotlink по Referer */
function iconTag(src: string | null, size: number): string {
  if (!src) {
    return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:#333;margin-right:6px;vertical-align:middle"></span>`;
  }

  return `<img src="${src}" width="${size}" height="${size}" alt=""
    referrerpolicy="no-referrer"
    style="border-radius:50%;vertical-align:middle;background:#222;margin-right:6px;object-fit:cover"
    onerror="this.style.opacity='0.35'" />`;
}

async function isWhitelistedOnchain(master: string): Promise<boolean> {
  try {
    const cell = beginCell().storeAddress(Address.parse(master)).endCell();

    const res = await fetch(TONCENTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '1',
        jsonrpc: '2.0',
        method: 'runGetMethod',
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
  } catch {
    return false;
  }
}

async function refreshWhitelist() {
  const list = document.getElementById('whitelist-list');
  if (!list) return;

  list.innerHTML = '<p class="hint">Loading...</p>';

  try {
    const r = await fetch(`${API_URL}/api/whitelist`);
    const j = await r.json();
    const wl = j.whitelist || [];

    if (wl.length === 0) {
      list.innerHTML = '<p class="hint">No approved jettons yet</p>';
      return;
    }

    const rows: string[] = [];

    for (const x of wl) {
      const onchain = await isWhitelistedOnchain(x.jetton_master);
      const src = await jettonIcon(x.jetton_master);

      rows.push(`<div class="lock-card">
        <div class="lock-head">
          ${iconTag(src, 26)}
          <b>${x.symbol || '?'}</b> · ${x.name || '—'}
          <span style="margin-left:8px;font-size:11px;padding:2px 8px;border-radius:10px;background:${onchain ? '#1d4d2b' : '#6b2b2b'};color:#fff">
            ${onchain ? 'ON-CHAIN ✓' : 'NOT ON-CHAIN'}
          </span>
        </div>
        <div class="lock-foot"><code>${x.jetton_master}</code> ·
          <a href="${EXPLORER(x.jetton_master)}" target="_blank" rel="noopener">explorer ↗</a></div>
      </div>`);
    }

    list.innerHTML = rows.join('');
  } catch (e: any) {
    list.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }
}

// ── Vaults ───────────────────────────────────────────────────────────────

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
  const summaryEl = document.getElementById('vaults-summary');
  const jettonsEl = document.getElementById('vaults-jettons');
  if (!summaryEl || !jettonsEl) return;

  try {
    const r = await fetch(`${API_URL}/api/locks/public`);
    const j = await r.json();

    const totalTVL_nano = BigInt(j.summary?.total?.total_tvl_nano ?? 0);
    const totalTVL_coins = Number(totalTVL_nano / 10n ** 9n);
    const price = Number(j.price_usd || 0);
    const totalTVL_usd = totalTVL_coins * price;
    const totalLocks = j.summary?.total?.total_locks ?? 0;
    const hasLocks = totalLocks > 0;

    summaryEl.innerHTML = `
      <div class="vault-stats">
        <div class="stat-box">
          <div class="stat-label">Total Value Locked</div>
          <div class="stat-value">${hasLocks ? formatUSD(totalTVL_usd) : '—'}</div>
          <div class="stat-sub">${hasLocks ? formatCoins(totalTVL_nano) + ' tokens' : 'no active locks'}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Active Locks</div>
          <div class="stat-value">${totalLocks}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Price</div>
          <div class="stat-value">${hasLocks && price > 0 ? '$' + price.toFixed(6) : '—'}</div>
        </div>
      </div>
    `;

    const byJetton = j.summary?.by_jetton || [];
    if (byJetton.length === 0) {
      jettonsEl.innerHTML = '<p class="hint">No active locks yet</p>';
      return;
    }

    const rows: string[] = [];

    for (const x of byJetton) {
      const master = String(x.jetton_master);
      const iconSrc = await jettonIcon(master);

      rows.push(`
        <div class="jetton-row" style="cursor:pointer" data-master="${master.replace(/"/g, '')}">
          ${iconTag(iconSrc, 24)}
          <span class="jetton-addr">${master.slice(0, 6)}...${master.slice(-4)}</span>
          <span class="jetton-tvl">${formatCoins(x.tvl_nano)}</span>
          <span class="jetton-count">${x.locks} locks</span>
        </div>
      `);
    }

    jettonsEl.innerHTML = rows.join('');

    jettonsEl.querySelectorAll<HTMLElement>('[data-master]').forEach((el) => {
      el.onclick = () => showJettonDetails(el.dataset.master!);
    });
  } catch (e: any) {
    summaryEl.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }
}

async function showJettonDetails(master: string) {
  const modal = document.getElementById('jetton-modal');
  const content = document.getElementById('modal-content');
  if (!modal || !content) return;

  modal.style.display = 'block';
  content.innerHTML = '<p class="hint">Loading locks...</p>';

  try {
    const r = await fetch(
      `${API_URL}/api/locks/by-jetton?master=${encodeURIComponent(master)}`,
    );
    const j = await r.json();
    const iconSrc = await jettonIcon(master);
    const locks = j.locks || [];
    const defDecimals = Number(j.decimals ?? 9);

    const locksHtml = locks
      .map((l: any) => {
        const now = Math.floor(Date.now() / 1000);
        const status =
          BigInt(l.claimed_amount) >= BigInt(l.amount)
            ? '✅ claimed'
            : Number(l.unlock_at) <= now
              ? '⏰ ready'
              : '🔒 locked';

        const decimals = Number(l.decimals ?? defDecimals);
        const amt = formatTokens(BigInt(l.amount), decimals);
        const unlockDate = new Date(Number(l.unlock_at) * 1000).toLocaleString();
        const cr = String(l.creator);

        return `
        <div class="lock-detail-row">
          <div class="lock-detail-header">
            <span class="lock-id">#${l.lock_id}</span>
            <span class="lock-status">${status}</span>
          </div>
          <div class="lock-detail-info">
            <div><b>Amount:</b> ${amt}</div>
            <div><b>Unlock:</b> ${unlockDate}</div>
            <div><b>Creator:</b> ${cr.slice(0, 6)}...${cr.slice(-4)}</div>
          </div>
          <div class="lock-detail-footer">
            <a href="${EXPLORER(l.lockup_wallet)}" target="_blank" rel="noopener" class="btn-small">Explorer ↗</a>
          </div>
        </div>`;
      })
      .join('');

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        ${iconTag(iconSrc, 40)}
        <div>
          <div style="font-family:monospace;font-size:12px;color:#888">${master}</div>
          <div style="font-size:14px;color:#4ade80">${locks.length} locks</div>
        </div>
      </div>
      <div class="locks-detail-list">${locksHtml || '<p class="hint">No locks</p>'}</div>
    `;
  } catch (e: any) {
    content.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  }

  const close = () => {
    modal.style.display = 'none';
  };

  const closeBtn = document.getElementById('modal-close');
  if (closeBtn) closeBtn.onclick = close;

  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
}

// ── Single export ────────────────────────────────────────────────────────

(window as any).__nv = {
  refreshLocks,
  refreshApps,
  refreshWhitelist,
  refreshVaults,
  showJettonDetails,
};

// COGNIQ pill
(async () => {
  const el = document.getElementById('pill-wl');
  if (!el) return;

  const ok = await isWhitelistedOnchain(
    'EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg',
  );

  el.textContent = ok ? 'COGNIQ WHITELISTED ✓' : 'COGNIQ: NOT WHITELISTED';
  el.style.background = ok ? '#1d4d2b' : '#6b2b2b';
  el.style.color = '#fff';
})();
