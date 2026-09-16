import './polyfills';
import { TonConnectUI } from '@tonconnect/ui';
import {
  Address, beginCell, toNano, SendMode,
} from '@ton/core';

// ===== CONFIG =====
const FACTORY_ADDRESS = 'kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh';
const MANIFEST_URL = 'https://oblachka81-cloud.github.io/neuron-vesting/tonconnect-manifest.json';

// ===== TONCONNECT (в try/catch, чтобы не падала вся страница) =====
const tc = new TonConnectUI({
  manifestUrl: MANIFEST_URL,
  buttonRootId: 'ton-connect',
});

const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const form = document.getElementById('lock-form') as HTMLFormElement;

function setStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

tc.onStatusChange((wallet) => {
  if (wallet) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Lock';
    setStatus(`Connected: ${wallet.account.address.slice(0, 6)}...${wallet.account.address.slice(-4)}`, 'ok');
  } else {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connect wallet first';
    setStatus('');
  }
});

// ===== PAYLOAD BUILDER (TEP-74 compliant) =====
function buildCreateLockCell(
  queryId: bigint,
  jettonMaster: Address,
  beneficiary: Address,
  unlockAt: bigint
) {
  return beginCell()
    .storeUint(0x1, 32)
    .storeUint(queryId, 64)
    .storeAddress(jettonMaster)
    .storeAddress(beneficiary)
    .storeUint(unlockAt, 64)
    .endCell();
}

function buildForwardPayload(createLockCell: any) {
  // TEP-74: bit 1 (is reference) + ref(inner)
  return beginCell()
    .storeBit(1)
    .storeRef(createLockCell)
    .endCell()
    .asSlice();
}

// ===== FORM SUBMIT =====
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('Building transaction...');

  try {
    const wallet = tc.wallet;
    if (!wallet) throw new Error('Wallet not connected');

    const jettonMaster = Address.parse((document.getElementById('jettonMaster') as HTMLInputElement).value.trim());
    const amount = (document.getElementById('amount') as HTMLInputElement).value;
    const beneficiary = Address.parse((document.getElementById('beneficiary') as HTMLInputElement).value.trim());
    const unlockAtInput = (document.getElementById('unlockAt') as HTMLInputElement).value;
    const unlockAt = BigInt(Math.floor(new Date(unlockAtInput + 'Z').getTime() / 1000));

    const creator = Address.parse(wallet.account.address);
    const amountNano = BigInt(Math.round(parseFloat(amount) * 1e9));
    const queryId = BigInt(Date.now());

    // Build CreateLock and wrap per TEP-74
    const createLockCell = buildCreateLockCell(queryId, jettonMaster, beneficiary, unlockAt);
    const forwardPayload = buildForwardPayload(createLockCell);

    // User's jetton wallet address
    const userJettonWalletStr = prompt(
      `Enter YOUR jetton wallet address for ${jettonMaster.toString({ testOnly: true })}\n` +
      `(find it in your wallet app, or use https://tonviewer.com/${jettonMaster.toString()} to look up)`
    );
    if (!userJettonWalletStr) {
      setStatus('Cancelled');
      return;
    }
    const userJettonWallet = Address.parse(userJettonWalletStr);

    // Build JettonTransfer body (TEP-74 opcode 0xf8a7ea5)
    const transferBody = beginCell()
      .storeUint(0xf8a7ea5, 32)       // JettonTransfer op
      .storeUint(queryId, 64)
      .storeCoins(amountNano)         // jettons to send
      .storeAddress(Address.parse(FACTORY_ADDRESS))  // destination
      .storeAddress(creator)          // response_destination (return excess)
      .storeBit(0)                    // no custom_payload
      .storeCoins(toNano('0.1'))      // forward_ton_amount (gas for factory)
      .storeBit(1)                    // forward_payload in reference
      .storeRef(forwardPayload.asCell())
      .endCell();

    await tc.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [
        {
          address: userJettonWallet.toString({ testOnly: true }),
          amount: toNano('0.25').toString(),
          payload: transferBody.toBoc().toString('base64'),
        },
      ],
    });

    setStatus('✅ Transaction sent! Factory will create your LockupWallet shortly.', 'ok');
  } catch (err: any) {
    console.error(err);
    setStatus('❌ ' + (err.message || 'Transaction failed'), 'err');
  }
});

// Default unlock: 1 hour from now (надёжно: прямая строка локального формата)
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}
(document.getElementById('unlockAt') as HTMLInputElement).value = localIso(new Date(Date.now() + 3600 * 1000));
