import { Address, beginCell, Cell } from '@ton/core';
import { TONCENTER, IS_TEST } from './config';

export async function getUserJettonWallet(jettonMaster: Address, owner: Address): Promise<Address> {
  const ownerCell = beginCell().storeAddress(owner).endCell();
  const payload = {
    id: '1', jsonrpc: '2.0', method: 'runGetMethod',
    params: {
      address: jettonMaster.toString({ testOnly: IS_TEST }),
      method: 'get_wallet_address',
      stack: [['tvm.Slice', ownerCell.toBoc().toString('base64')]],
    },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(TONCENTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.ok) {
      const bytes = json.result.stack[0][1].bytes;
      const cell = Cell.fromBoc(Buffer.from(bytes, 'base64'))[0];
      return cell.beginParse().loadAddress();
    }
    console.warn('get_wallet_address attempt', attempt, json);
    await new Promise((r) => setTimeout(r, 1300));
  }
  throw new Error('get_wallet_address failed after 3 attempts (Toncenter rate limit)');
}

// Claim op per lockup_wallet.tact: message(0x10) Claim { query_id: uint64; amount: coins }
// amount = 0 -> claim all available
export function buildClaimBody(queryId: bigint, amount: bigint = 0n) {
  return beginCell()
    .storeUint(0x10, 32)
    .storeUint(queryId, 64)
    .storeCoins(amount)
    .endCell();
}
