 // Live jetton prices (exchange-style) for whitelist cards
const CACHE = new Map<string, { ts: number; price: number | null; ch24: number | null }>();

async function fetchMeta(master: string) {
  const c = CACHE.get(master);
  if (c && Date.now() - c.ts < 60_000) return c;
  let price: number | null = null;
  let ch24: number | null = null;
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/ton/tokens/${master}`);
    if (r.ok) {
      const a = (await r.json())?.data?.attributes;
      const p = parseFloat(a?.price_usd);
      if (isFinite(p) && p > 0) price = p;
      const ch = parseFloat(a?.price_change_percentage?.h24);
      if (isFinite(ch)) ch24 = ch;
    }
  } catch { /* ignore */ }
  if (price == null) {
    try {
      const r = await fetch(`https://api.ston.fi/v1/assets?address=${master}`);
      if (r.ok) {
        const p = parseFloat((await r.json())?.asset_list?.[0]?.usd_price);
        if (isFinite(p) && p > 0) price = p;
      }
    } catch { /* ignore */ }
  }
  const rec = { ts: Date.now(), price, ch24 };
  CACHE.set(master, rec);
  return rec;
}

function fmt(p: number): string {
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.001) return p.toFixed(4);
  return p.toExponential(2);
}

async function refresh() {
  const codes = document.querySelectorAll('#whitelist-list code');
  for (const el of Array.from(codes)) {
    const master = (el.textContent || '').trim();
    if (!master.startsWith('EQ') && !master.startsWith('kQ')) continue;
    let tag = el.nextElementSibling as HTMLAnchorElement | null;
    if (!tag || !tag.classList.contains('price-tag')) {
      tag = document.createElement('a');
      tag.className = 'pill price-tag';
      tag.style.marginLeft = '8px';
      tag.style.textDecoration = 'none';
      tag.target = '_blank';
      tag.rel = 'noopener';
      el.insertAdjacentElement('afterend', tag);
    }
    tag.href = 'https://www.geckoterminal.com/ton/tokens/' + master;
    const m = await fetchMeta(master);
    if (m.price == null) {
      tag.textContent = 'price: n/a';
      tag.style.color = '';
    } else {
      const ch = m.ch24 == null ? '' : ' ' + (m.ch24 >= 0 ? '▲' : '▼') + Math.abs(m.ch24).toFixed(1) + '%';
      tag.textContent = '$' + fmt(m.price) + ch;
      tag.style.color = m.ch24 == null ? '' : (m.ch24 >= 0 ? '#7dffa8' : '#ff8a8a');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => setTimeout(refresh, 1500));
setInterval(refresh, 60_000);
