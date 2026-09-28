import { toNano, Address, beginCell, Cell } from '@ton/core';
import type { TonConnectUI } from '@tonconnect/ui';
import { API_URL, EXPLORER, FACTORY_ADDRESS, TONCENTER } from './config';

// ───────────────────────────────────────────────────────────────────────────
// NEURON Vesting — Cabinet (My Locks / Apps / Whitelist / Vaults)
//
// Render model (why cards no longer flicker):
//   1. Keyed reconciliation. Each lock card is ONE persistent DOM node,
//      created once and thereafter mutated only at its inner [data-role]
//      nodes. The list is never re-rendered wholesale via innerHTML on
//      refresh, so there is no blank frame between polls.
//   2. Money is DB-authoritative. claimed / available come ONLY from the
//      indexer-backed DB (source of truth = ClaimSettled 0x128). On-chain
//      getters are used solely for the pending/reset flag — never for an
//      amount. This makes transient getter garbage (e.g. 0.000125782 during
//      a claim wave) structurally impossible.
//   3. Self-healing optimistic status. After a local claim we mark the lock
//      "sent" and hold that until EITHER the DB moves claimed_amount for it
//      (network confirmed) OR a TTL elapses. The optimistic state therefore
//      never sticks and never regresses to "ready" while settlement is
//      still propagating through the indexer.
// ───────────────────────────────────────────────────────────────────────────

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

type DisplayStatus = 'locked' | 'ready' | 'in_flight' | 'claimed';

type EnrichedLock = Lock & {
  decimals: number;
  displayStatus: DisplayStatus;
  displayClaimed: bigint;
  displayAvailable: bigint;
  pending: boolean;
  pendingSetAt: bigint;
  resettable: boolean;
  localPend: boolean;
};

let currentWallet: string | null = null;
let tcRef: TonConnectUI | null = null;

const pad = (n: number) => String(n).padStart(2, '0');
const RESET_TIMEOUT = 3600;          // seconds, mirrors the wallet constant
const MESSAGE_VALUE = toNano('0.05');
const LOCAL_PENDING_TTL = 20000;     // ms, safety net if settlement never lands

// Snapshot of the last fetched DB rows, keyed by lock_id. Used to read the
// authoritative claimed_amount at click time without parsing the DOM.
let lastLocks = new Map<string, Lock>();

// lock_id -> { ts, claimedAtClick }: optimistic "I just sent it" marker.
const localPending = new Map<string, { ts: number; claimedAtClick: bigint }>();

let refreshInFlight = false;
let refreshQueued = false;
let timersStarted = false;

export function mountCabinet(tc: TonConnectUI) {
  tcRef = tc;

  tc.onStatusChange((w) => {
    currentWallet = w ? w.account.address : null;
    localPending.clear();
    refreshLocks();
  });

  document.getElementById('btn-refresh-locks')?.addEventListener('click', refreshLocks);
  (document.getElementById('app-form') as HTMLFormElement)?.addEventListener('submit', onAppSubmit);

  // Single delegated listener on the container: survives every card mutation
  // and catches buttons of newly created cards without re-binding.
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

  if (!timersStarted) { timersStarted = true; startTimers(); }

  refreshWhitelist();
  refreshLocks();
}

// ── Address helpers ──────────────────────────────────────────────────────

function normAddr(a: string): string {
  try { return Address.parse(a).toRawString(); }
  catch { return String(a || '').toLowerCase(); }
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
        id: '1', jsonrpc: '2.0', method: 'runGetMethod',
        params: { address, method, stack: [] },
      }),
    });
    const json = await res.json();
    if (!json.ok || !json.result?.stack?.length) return null;
    return stackNum(json.result.stack[0]);
  } catch { return null; }
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
  try { return BigInt(intPart || '0') * base + BigInt(frac || '0'); }
  catch { return null; }
}

// ── Optimistic pending (self-heals on DB progress or TTL) ────────────────

function isLocalPending(l: Lock): boolean {
  const id = String(l.lock_id);
  const p = localPending.get(id);
  if (!p) return false;
  if (Date.now() - p.ts > LOCAL_PENDING_TTL) { localPending.delete(id); return false; }
  // DB moved claimed_amount for this lock => network confirmed => drop optimism.
  if (BigInt(l.claimed_amount || '0') !== p.claimedAtClick) { localPending.delete(id); return false; }
  return true;
}

// ── Display computation (money = DB; pending = getter/optimism) ──────────

function computeDisplay(
  l: Lock, known: boolean, pending: boolean, localPend: boolean, now: number,
): DisplayStatus {
  const amount = BigInt(l.amount);
  const claimed = BigInt(l.claimed_amount || '0');
  if (claimed >= amount) return 'claimed';          // final DB state wins
  if (known && pending) return 'in_flight';         // getter confirms in-flight
  if (localPend) return 'in_flight';                // hold optimism while indexer catches up
  if (Number(l.unlock_at) <= now) return 'ready';
  return 'locked';
}

function buildEnriched(
  l: Lock, known: boolean, pending: boolean, pendingSetAt: bigint,
): EnrichedLock {
  const now = Math.floor(Date.now() / 1000);
  const amount = BigInt(l.amount);
  const claimed = BigInt(l.claimed_amount || '0');
  const decimals = safeDecimals((l as any).decimals);
  const localPend = isLocalPending(l);
  const ds = computeDisplay(l, known, pending, localPend, now);
  const displayAvailable = (ds === 'in_flight' || ds === 'claimed')
    ? 0n
    : (amount > claimed ? amount - claimed : 0n);
  const resettable =
    pending && pendingSetAt > 0n && BigInt(now) >= pendingSetAt + BigInt(RESET_TIMEOUT);

  return {
    ...l, decimals, displayStatus: ds,
    displayClaimed: claimed, displayAvailable,
    pending, pendingSetAt, resettable, localPend,
  };
}

// ── Rendering: card skeleton + inner-node mutation ───────────────────────

function renderStatusHTML(l: EnrichedLock): string {
  const isBen = currentWallet ? sameAddr(l.beneficiary, currentWallet) : false;

  if (l.displayStatus === 'claimed') return '✅ received';

  if (l.displayStatus === 'in_flight') {
    let s = '⏳ claim in flight';
    if (l.resettable && isBen) {
      s += ` <button class="btn-reset" style="margin-left:8px" data-reset data-lock-id="${l.lock_id}" data-wallet="${l.lockup_wallet}">Reset</button>`;
    } else if (l.pendingSetAt > 0n) {
      s += ` · reset in <span data-reset-timer="${Number(l.pendingSetAt + BigInt(RESET_TIMEOUT))}" class="timer"></span>`;
    }
    return s;
  }

  if (l.displayStatus === 'ready') {
    if (l.localPend) return '⏳ transaction sent, waiting confirmation';
    if (!isBen) return `⏰ ready <span class="hint">(claim for beneficiary only)</span>`;
    const availText = formatTokens(l.displayAvailable, l.decimals);
    return `
      ⏰ ready
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn-claim" data-claim-full data-lock-id="${l.lock_id}" data-wallet="${l.lockup_wallet}">Claim all</button>
        <input class="partial-input" data-partial="${l.lock_id}" type="text" inputmode="decimal" placeholder="partial amount"
          style="min-width:150px;padding:6px 8px;border-radius:8px;border:1px solid #333;background:#111;color:#fff"/>
        <button class="btn-claim-partial" data-claim-partial data-lock-id="${l.lock_id}" data-wallet="${l.lockup_wallet}"
          data-available="${l.displayAvailable.toString()}" data-decimals="${l.decimals}">Claim part</button>
      </div>
      <div class="hint" style="margin-top:6px">available: ${availText}</div>`;
  }

  return `🔒 unlocks in <span data-timer="${l.unlock_at}" class="timer"></span>`;
}

function renderProgressHTML(l: EnrichedLock): string {
  const amount = BigInt(l.amount);
  const amt = formatTokens(amount, l.decimals);
  const cl = formatTokens(l.displayClaimed, l.decimals);
  const progress = amount > 0n ? Number((l.displayClaimed * 100n) / amount) : 100;
  return `claimed: ${cl} / ${amt} · ${progress}%`;
}

function headFootHTML(l: Lock): { head: string; foot: string } {
  const amount = BigInt(l.amount);
  const decimals = safeDecimals((l as any).decimals);
  const amt = formatTokens(amount, decimals);
  const ms = l.jetton_master.slice(0, 6) + '...' + l.jetton_master.slice(-4);
  return {
    head: `#${l.lock_id} · <code>${ms}</code> · ${amt}`,
    foot: `<a href="${EXPLORER(l.lockup_wallet)}" target="_blank" rel="noopener">lockup wallet ↗</a>`,
  };
}

// Build a brand-new card node (only for locks not yet in the DOM).
function createCard(l: EnrichedLock): HTMLElement {
  const { head, foot } = headFootHTML(l);
  const node = document.createElement('div');
  node.className = 'lock-card';
  node.setAttribute('data-lock-id', String(l.lock_id));
  node.innerHTML = `
    <div class="lock-head">${head}</div>
    <div class="lock-status" data-role="status">${renderStatusHTML(l)}</div>
    <div class="hint" style="margin-top:6px" data-role="progress">${renderProgressHTML(l)}</div>
    <div class="lock-foot">${foot}</div>`;
  return node;
}

// Mutate inner nodes of an existing card. The card itself is never replaced.
function updateCard(node: HTMLElement, l: EnrichedLock) {
  const status = node.querySelector('[data-role="status"]');
  const progress = node.querySelector('[data-role="progress"]');
  if (status) status.innerHTML = renderStatusHTML(l);
  if (progress) progress.innerHTML = renderProgressHTML(l);
}

// ── Keyed reconcile of the list (no wholesale innerHTML wipe) ────────────

function syncList(locks: Lock[]) {
  const list = document.getElementById('locks-list');
  if (!list) return;

  const existing = new Map<string, HTMLElement>();
  list.querySelectorAll<HTMLElement>('[data-lock-id]').forEach((n) => {
    existing.set(n.getAttribute('data-lock-id')!, n);
  });
  const wanted = new Set(locks.map((l) => String(l.lock_id)));

  for (const [id, node] of existing) if (!wanted.has(id)) node.remove();

  for (const l of locks) {
    const id = String(l.lock_id);
    const e = buildEnriched(l, /*known*/ false, /*pending*/ false, 0n);
    let node = existing.get(id);
    if (!node) {
      node = createCard(e);
      list.appendChild(node);
    } else {
      updateCard(node, e);   // refresh status/progress from latest DB row
      list.appendChild(node); // reorder without recreating content (no flicker)
    }
  }
}

// ── Background enrichment: getters only for the pending flag ─────────────

async function enrichAndPatch(l: Lock) {
  const now = Math.floor(Date.now() / 1000);
  const amount = BigInt(l.amount);
  const claimed = BigInt(l.claimed_amount || '0');

  if (claimed >= amount) { patchFromDb(l); return; }   // closed: skip getter
  if (Number(l.unlock_at) > now) { patchFromDb(l); return; } // still locked
  if (!l.lockup_wallet) { patchFromDb(l); return; }

  const p = await runGetter(l.lockup_wallet, 'isPendingClaim');
  if (p !== null && p !== 0n) {
    const ps = await runGetter(l.lockup_wallet, 'pendingSetAt');
    patch(l, true, true, ps ?? 0n);
  } else {
    patch(l, true, false, 0n);
  }
}

function patchFromDb(l: Lock) { patch(l, false, false, 0n); }

function patch(l: Lock, known: boolean, pending: boolean, pendingSetAt: bigint) {
  const list = document.getElementById('locks-list');
  if (!list) return;
  const node = list.querySelector<HTMLElement>(`[data-lock-id="${CSS.escape(String(l.lock_id))}"]`);
  if (!node) return; // lock left the DOM (wallet switched) — nothing to patch
  updateCard(node, buildEnriched(l, known, pending, pendingSetAt));
}

// ── My Locks ─────────────────────────────────────────────────────────────

async function refreshLocks() {
  const list = document.getElementById('locks-list');
  if (!list) return;

  if (refreshInFlight) { refreshQueued = true; return; }
  refreshInFlight = true;

  try {
    if (!currentWallet) {
      list.innerHTML = '<p class="hint">Connect wallet to see your locks</p>';
      return;
    }

    const hasCards = !!list.querySelector('[data-lock-id]');
    if (!hasCards) list.innerHTML = '<p class="hint">Loading...</p>';

    const r = await fetch(`${API_URL}/api/locks?wallet=${encodeURIComponent(currentWallet)}`);
    const j = await r.json();
    const locks: Lock[] = j.locks || [];

    if (locks.length === 0) {
      list.innerHTML = '<p class="hint">No locks yet</p>';
      return;
    }

    // Cache DB rows so onClaim can read claimed_amount without DOM parsing.
    lastLocks.clear();
    for (const l of locks) lastLocks.set(String(l.lock_id), l);

    syncList(locks); // instant DB skeleton, keyed, no wipe

    await Promise.allSettled(locks.map((l) => enrichAndPatch(l))); // pending flag, in place
  } catch (e: any) {
    if (!hasCards) list.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`;
  } finally {
    refreshInFlight = false;
    if (refreshQueued) { refreshQueued = false; refreshLocks(); }
  }
}

// ── Timers (installed once; mutate text; plan ONE refresh per transition) ─

function startTimers() {
  let planned = false;
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    let crossed = false;
    document.querySelectorAll('[data-timer], [data-reset-timer]').forEach((el) => {
      const htmlEl = el as HTMLElement;
      const t = Number(htmlEl.dataset.timer || htmlEl.dataset.resetTimer);
      const diff = t - now;
      if (diff <= 0) { htmlEl.textContent = 'ready'; crossed = true; return; }
      const d = Math.floor(diff / 86400);
      const h = Math.floor((diff % 86400) / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      htmlEl.textContent = d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
    });
    if (crossed && !planned) {
      planned = true;
      setTimeout(() => { planned = false; refreshLocks(); }, 1200);
    }
  };
  tick();
  setInterval(tick, 1000);
}

// ── Claim / Reset ────────────────────────────────────────────────────────

async function sendWalletMessage(wallet: string, body: Cell): Promise<boolean> {
  if (!tcRef || !currentWallet) return false;
  try {
    const walletAddress = Address.parse(wallet).toString({ urlSafe: true });
    await tcRef.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [{ address: walletAddress, amount: MESSAGE_VALUE.toString(), payload: body.toBoc().toString('base64') }],
    });
    return true;
  } catch (e: any) {
    alert('❌ ' + (e.message || 'Cancelled'));
    return false;
  }
}

// Flip the status node to "waiting" instantly, without a full refresh.
function applyWaiting(lockId: string) {
  const list = document.getElementById('locks-list');
  if (!list) return;
  const node = list.querySelector<HTMLElement>(`[data-lock-id="${CSS.escape(lockId)}"]`);
  const status = node?.querySelector('[data-role="status"]');
  if (status) status.innerHTML = '⏳ transaction sent, waiting confirmation';
}

function armOptimistic(lockId: string) {
  const db = lastLocks.get(lockId);
  localPending.set(lockId, {
    ts: Date.now(),
    claimedAtClick: BigInt(db?.claimed_amount || '0'),
  });
  applyWaiting(lockId);
}

async function onClaim(
  lockId: string, wallet: string, mode: 'full' | 'partial',
  rawAmount = '', decimals = 9, availableNano?: string,
) {
  if (!tcRef || !currentWallet) return;

  let amount = 0n;
  if (mode === 'partial') {
    const parsed = parseTokenInput(rawAmount, decimals);
    if (parsed === null || parsed <= 0n) { alert('Enter a valid partial amount'); return; }
    if (availableNano) {
      const available = BigInt(availableNano);
      if (parsed > available) { alert('Amount is larger than available'); return; }
      amount = parsed === available ? 0n : parsed; // exact remainder => full-claim semantics
    } else { amount = parsed; }
  }

  armOptimistic(lockId);

  const qid = makeQid();
  const ok = await sendWalletMessage(wallet, buildClaimBody(qid, amount));
  if (!ok) { localPending.delete(lockId); refreshLocks(); return; }

  setTimeout(refreshLocks, 5000);
  setTimeout(refreshLocks, 15000);
}

async function onReset(lockId: string, wallet: string) {
  if (!tcRef || !currentWallet) return;
  armOptimistic(lockId);
  const qid = makeQid();
  const ok = await sendWalletMessage(wallet, buildResetBody(qid));
  if (!ok) { localPending.delete(lockId); refreshLocks(); return; }
  setTimeout(refreshLocks, 5000);
  setTimeout(refreshLocks, 15000);
}

// ── Applications ─────────────────────────────────────────────────────────

async function refreshApps() {
  const list = document.getElementById('apps-list');
  if (!list) return;
  if (!currentWallet) { list.innerHTML = '<p class="hint">Connect wallet</p>'; return; }
  const mine = JSON.parse(localStorage.getItem('nv_my_apps') || '[]');
  if (mine.length === 0) { list.innerHTML = '<p class="hint">No applications yet</p>'; return; }
  list.innerHTML = '<p class="hint">Loading...</p>';
  const rows = [];
  for (const a of mine) {
    try { const r = await fetch(`${API_URL}/api/applications/status/${a.id}`); const j = await r.json(); rows.push(j.application || a); }
    catch { rows.push(a); }
  }
  list.innerHTML = rows.map((a: any) => `<div class="lock-card">
    <div class="lock-head">#${a.id} · <code>${String(a.jetton_master).slice(0, 6)}...</code></div>
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
  statusEl.textContent = 'Submitting...'; statusEl.className = 'status';
  try {
    const body = {
      jetton_master: (document.getElementById('app-jm') as HTMLInputElement).value.trim(),
      applicant: currentWallet,
      applicant_name: (document.getElementById('app-name') as HTMLInputElement).value.trim(),
      project_url: (document.getElementById('app-url') as HTMLInputElement).value.trim() || null,
      notes: (document.getElementById('app-notes') as HTMLTextAreaElement).value || null,
    };
    const r = await fetch(`${API_URL}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    const mine = JSON.parse(localStorage.getItem('nv_my_apps') || '[]');
    mine.unshift({ id: j.application.id, jetton_master: body.jetton_master, status: 'pending' });
    localStorage.setItem('nv_my_apps', JSON.stringify(mine));
    statusEl.textContent = `✅ Submitted! ID #${j.application.id}`; statusEl.className = 'status ok';
    (document.getElementById('app-form') as HTMLFormElement).reset();
    refreshApps();
  } catch (e: any) { statusEl.textContent = '❌ ' + e.message; statusEl.className = 'status err'; }
}

// ── Icons + whitelist ────────────────────────────────────────────────────

async function jettonIcon(master: string): Promise<string | null> {
  try { const r = await fetch(`${API_URL}/api/jetton/${encodeURIComponent(master)}/icon`); if (!r.ok) return null; const j = await r.json(); return j.image || null; }
  catch { return null; }
}

// no-referrer: postimg/cdn often strip hotlinks by Referer header.
function iconTag(src: string | null, size: number): string {
  if (!src) return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:#333;margin-right:6px;vertical-align:middle"></span>`;
  return `<img src="${src}" width="${size}" height="${size}" alt="" referrerpolicy="no-referrer"
    style="border-radius:50%;vertical-align:middle;background:#222;margin-right:6px;object-fit:cover"
    onerror="this.style.opacity='0.35'" />`;
}

async function isWhitelistedOnchain(master: string): Promise<boolean> {
  try {
    const cell = beginCell().storeAddress(Address.parse(master)).endCell();
    const res = await fetch(TONCENTER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '1', jsonrpc: '2.0', method: 'runGetMethod', params: { address: FACTORY_ADDRESS, method: 'isWalletSet', stack: [['tvm.Slice', cell.toBoc().toString('base64')]] } }) });
    const json = await res.json();
    if (!json.ok) return false;
    return stackNum(json.result.stack[0]) !== 0n;
  } catch { return false; }
}

async function refreshWhitelist() {
  const list = document.getElementById('whitelist-list');
  if (!list) return;
  list.innerHTML = '<p class="hint">Loading...</p>';
  try {
    const r = await fetch(`${API_URL}/api/whitelist`); const j = await r.json(); const wl = j.whitelist || [];
    if (wl.length === 0) { list.innerHTML = '<p class="hint">No approved jettons yet</p>'; return; }
    const rows: string[] = [];
    for (const x of wl) {
      const onchain = await isWhitelistedOnchain(x.jetton_master);
      const src = await jettonIcon(x.jetton_master);
      rows.push(`<div class="lock-card">
        <div class="lock-head">${iconTag(src, 26)} <b>${x.symbol || '?'}</b> · ${x.name || '—'}
          <span style="margin-left:8px;font-size:11px;padding:2px 8px;border-radius:10px;background:${onchain ? '#1d4d2b' : '#6b2b2b'};color:#fff">${onchain ? 'ON-CHAIN ✓' : 'NOT ON-CHAIN'}</span>
        </div>
        <div class="lock-foot"><code>${x.jetton_master}</code> · <a href="${EXPLORER(x.jetton_master)}" target="_blank" rel="noopener">explorer ↗</a></div>
      </div>`);
    }
    list.innerHTML = rows.join('');
  } catch (e: any) { list.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`; }
}

// ── Vaults ─────────────────────────────────────────────────────────────

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
    const r = await fetch(`${API_URL}/api/locks/public`); const j = await r.json();
    const totalTVL_nano = BigInt(j.summary?.total?.total_tvl_nano ?? 0);
    const totalTVL_coins = Number(totalTVL_nano / 10n ** 9n);
    const price = Number(j.price_usd || 0);
    const totalTVL_usd = totalTVL_coins * price;
    const totalLocks = j.summary?.total?.total_locks ?? 0;
    const hasLocks = totalLocks > 0;
    summaryEl.innerHTML = `
      <div class="vault-stats">
        <div class="stat-box"><div class="stat-label">Total Value Locked</div><div class="stat-value">${hasLocks ? formatUSD(totalTVL_usd) : '—'}</div><div class="stat-sub">${hasLocks ? formatCoins(totalTVL_nano) + ' tokens' : 'no active locks'}</div></div>
        <div class="stat-box"><div class="stat-label">Active Locks</div><div class="stat-value">${totalLocks}</div></div>
        <div class="stat-box"><div class="stat-label">Price</div><div class="stat-value">${hasLocks && price > 0 ? '$' + price.toFixed(6) : '—'}</div></div>
      </div>`;
    const byJetton = j.summary?.by_jetton || [];
    if (byJetton.length === 0) { jettonsEl.innerHTML = '<p class="hint">No active locks yet</p>'; return; }
    const rows: string[] = [];
    for (const x of byJetton) {
      const master = String(x.jetton_master); const iconSrc = await jettonIcon(master);
      rows.push(`<div class="jetton-row" style="cursor:pointer" data-master="${master.replace(/"/g, '')}">
        ${iconTag(iconSrc, 24)} <span class="jetton-addr">${master.slice(0, 6)}...${master.slice(-4)}</span>
        <span class="jetton-tvl">${formatCoins(x.tvl_nano)}</span> <span class="jetton-count">${x.locks} locks</span></div>`);
    }
    jettonsEl.innerHTML = rows.join('');
    jettonsEl.querySelectorAll<HTMLElement>('[data-master]').forEach((el) => { el.onclick = () => showJettonDetails(el.dataset.master!); });
  } catch (e: any) { summaryEl.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`; }
}

async function showJettonDetails(master: string) {
  const modal = document.getElementById('jetton-modal');
  const content = document.getElementById('modal-content');
  if (!modal || !content) return;
  modal.style.display = 'block'; content.innerHTML = '<p class="hint">Loading locks...</p>';
  try {
    const r = await fetch(`${API_URL}/api/locks/by-jetton?master=${encodeURIComponent(master)}`);
    const j = await r.json(); const iconSrc = await jettonIcon(master); const locks = j.locks || [];
    const defDecimals = Number(j.decimals ?? 9);
    const locksHtml = locks.map((l: any) => {
      const now = Math.floor(Date.now() / 1000);
      const status = BigInt(l.claimed_amount) >= BigInt(l.amount) ? '✅ claimed' : Number(l.unlock_at) <= now ? '⏰ ready' : '🔒 locked';
      const decimals = Number(l.decimals ?? defDecimals);
      const amt = formatTokens(BigInt(l.amount), decimals);
      const unlockDate = new Date(Number(l.unlock_at) * 1000).toLocaleString();
      const cr = String(l.creator);
      return `<div class="lock-detail-row">
        <div class="lock-detail-header"><span class="lock-id">#${l.lock_id}</span><span class="lock-status">${status}</span></div>
        <div class="lock-detail-info"><div><b>Amount:</b> ${amt}</div><div><b>Unlock:</b> ${unlockDate}</div><div><b>Creator:</b> ${cr.slice(0, 6)}...${cr.slice(-4)}</div></div>
        <div class="lock-detail-footer"><a href="${EXPLORER(l.lockup_wallet)}" target="_blank" rel="noopener" class="btn-small">Explorer ↗</a></div>
      </div>`;
    }).join('');
    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        ${iconTag(iconSrc, 40)}
        <div><div style="font-family:monospace;font-size:12px;color:#888">${master}</div><div style="font-size:14px;color:#4ade80">${locks.length} locks</div></div>
      </div>
      <div class="locks-detail-list">${locksHtml || '<p class="hint">No locks</p>'}</div>`;
  } catch (e: any) { content.innerHTML = `<p class="hint" style="color:#ff6b6b">Error: ${e.message}</p>`; }
  const close = () => { modal.style.display = 'none'; };
  const closeBtn = document.getElementById('modal-close'); if (closeBtn) closeBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

// ── Single export ────────────────────────────────────────────────────────

(window as any).__nv = { refreshLocks, refreshApps, refreshWhitelist, refreshVaults, showJettonDetails };

(async () => {
  const el = document.getElementById('pill-wl'); if (!el) return;
  const ok = await isWhitelistedOnchain('EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg');
  el.textContent = ok ? 'COGNIQ WHITELISTED ✓' : 'COGNIQ: NOT WHITELISTED';
  el.style.background = ok ? '#1d4d2b' : '#6b2b2b'; el.style.color = '#fff';
})();
