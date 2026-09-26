import { Address, beginCell, toNano } from '@ton/core';
import type { TonConnectUI } from '@tonconnect/ui';
import { FACTORY_ADDRESS, IS_TEST, TONCENTER } from './config';
import { getUserJettonWallet } from './ton';

// Read mutable fees from factory; fallback to deploy defaults if RPC down.
async function getFactoryFees(): Promise<{ feeBps: number; feeTon: bigint }> {
  const batch = [
    { id: '1', jsonrpc: '2.0', method: 'runGetMethod', params: { address: FACTORY_ADDRESS, method: 'feeBps', stack: [] } },
    { id: '2', jsonrpc: '2.0', method: 'runGetMethod', params: { address: FACTORY_ADDRESS, method: 'feeTon', stack: [] } },
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(TONCENTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      const json = await res.json();
      if (Array.isArray(json) && json.length === 2 && json[0].ok && json[1].ok) {
        const feeBps = Number(BigInt(json[0].result.stack[0][1]));
        const feeTon = BigInt(json[1].result.stack[0][1]);
        return { feeBps, feeTon };
      }
      console.warn('fees attempt', attempt, json);
    } catch (e) {
      console.warn('fees fetch failed', e);
    }
    await new Promise((r) => setTimeout(r, 1300));
  }
  console.warn('fees: fallback to defaults');
  return { feeBps: 50, feeTon: toNano('1') };
}

export function mountWizard(tc: TonConnectUI) {
  const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
  const statusEl = document.getElementById('status') as HTMLParagraphElement;
  const form = document.getElementById('lock-form') as HTMLFormElement;

  const setStatus = (msg: string, kind: 'ok' | 'err' | '' = '') => {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + kind;
  };

  tc.onStatusChange((w) => {
    if (w) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Lock';
      setStatus(`Connected: ${w.account.address.slice(0, 6)}...${w.account.address.slice(-4)}`, 'ok');
    } else {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connect wallet first';
      setStatus('');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('Reading current fees from factory...');
    try {
      const w = tc.wallet;
      if (!w) throw new Error('Wallet not connected');

      const jettonMaster = Address.parse((document.getElementById('jettonMaster') as HTMLInputElement).value.trim());
      const amount = (document.getElementById('amount') as HTMLInputElement).value;
      const beneficiary = Address.parse((document.getElementById('beneficiary') as HTMLInputElement).value.trim());
      const unlockAtInput = (document.getElementById('unlockAt') as HTMLInputElement).value;
      const unlockAt = BigInt(Math.floor(new Date(unlockAtInput).getTime() / 1000));
      const creator = Address.parse(w.account.address);
      const amountNano = BigInt(Math.round(parseFloat(amount) * 1e9));
      const queryId = BigInt(Date.now());

      const { feeBps, feeTon } = await getFactoryFees();
      const gasBuffer = toNano('0.15');
      const forwardTon = feeTon + gasBuffer;
      const outerValue = forwardTon + toNano('0.05');

      setStatus(`Fees: ${feeBps / 100}% + ${Number(feeTon) / 1e9} TON. Looking up jetton wallet...`);
      const userJettonWallet = await getUserJettonWallet(jettonMaster, creator);

      const createLockCell = beginCell()
        .storeUint(0x1, 32)
        .storeUint(queryId, 64)
        .storeAddress(jettonMaster)
        .storeAddress(beneficiary)
        .storeUint(unlockAt, 64)
        .endCell();

      const transferBody = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(queryId, 64)
        .storeCoins(amountNano)
        .storeAddress(Address.parse(FACTORY_ADDRESS))
        .storeAddress(creator)
        .storeBit(0)
        .storeCoins(forwardTon)
        .storeBit(1)
        .storeRef(createLockCell)
        .endCell();

      await tc.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{
          address: userJettonWallet.toString({ testOnly: IS_TEST }),
          amount: outerValue.toString(),
          payload: transferBody.toBoc().toString('base64'),
        }],
      });
      setStatus('✅ Transaction sent! Factory will create your LockupWallet shortly.', 'ok');
    } catch (err: any) {
      console.error(err);
      setStatus('❌ ' + (err.message || 'Transaction failed'), 'err');
    }
  });

  const localIso = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  (document.getElementById('unlockAt') as HTMLInputElement).value = localIso(new Date(Date.now() + 3600 * 1000));
}
