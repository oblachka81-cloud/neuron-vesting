import { Address, beginCell, toNano } from '@ton/core';
import type { TonConnectUI } from '@tonconnect/ui';
import { FACTORY_ADDRESS, IS_TEST } from './config';
import { getUserJettonWallet } from './ton';

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
    setStatus('Building transaction...');
    try {
      const w = tc.wallet;
      if (!w) throw new Error('Wallet not connected');

      const jettonMaster = Address.parse((document.getElementById('jettonMaster') as HTMLInputElement).value.trim());
      const amount = (document.getElementById('amount') as HTMLInputElement).value;
      const beneficiary = Address.parse((document.getElementById('beneficiary') as HTMLInputElement).value.trim());
      const unlockAtInput = (document.getElementById('unlockAt') as HTMLInputElement).value;
      const unlockAt = BigInt(Math.floor(new Date(unlockAtInput + 'Z').getTime() / 1000));
      const creator = Address.parse(w.account.address);
      const amountNano = BigInt(Math.round(parseFloat(amount) * 1e9));
      const queryId = BigInt(Date.now());

      setStatus('Looking up your jetton wallet...');
      const userJettonWallet = await getUserJettonWallet(jettonMaster, creator);

      const createLockCell = beginCell()
        .storeUint(0x1, 32).storeUint(queryId, 64)
        .storeAddress(jettonMaster).storeAddress(beneficiary)
        .storeUint(unlockAt, 64).endCell();
      const forwardPayload = beginCell().storeBit(1).storeRef(createLockCell).endCell().asSlice();

      const transferBody = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(queryId, 64)
        .storeCoins(amountNano)
        .storeAddress(Address.parse(FACTORY_ADDRESS))
        .storeAddress(creator)
        .storeBit(0)
        .storeCoins(toNano('1.4'))     // covers 1 TON platform fee + factory gas
        .storeBit(1)
        .storeRef(forwardPayload.asCell())
        .endCell();

      await tc.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{
          address: userJettonWallet.toString({ testOnly: IS_TEST }),
          amount: toNano('1.6').toString(),  // outer gas + forward_ton
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
