import { Address, beginCell, Cell } from '@ton/core';
import { TONCENTER, IS_TEST } from './config';

export async function getUserJettonWallet(jettonMaster: Address, owner: Address): Promise<Address> {
  const ownerCell = beginCell().storeAddress(owner).endCell();
  const res = await fetch(TONCENTER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: '1', jsonrpc: '2.0', method: 'runGetMethod',
      params: {
        address: jettonMaster.toString({ testOnly: IS_TEST }),
        method: 'get_wallet_address',
        stack: [['tvm.Slice', ownerCell.toBoc().toString('base64')]],
      },
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error('get_wallet_address failed: ' + (json.error || 'unknown'));
  const bytes = json.result.stack[0][1].bytes;
  const cell = Cell.fromBoc(Buffer.from(bytes, 'base64'))[0];
  return cell.beginParse().loadAddress();
}

// TODO: verify against lockup_wallet.tact — пока placeholder
const CLAIM_OP = 0x17a49c59;

export function buildClaimBody(queryId: bigint) {
  return beginCell().storeUint(CLAIM_OP, 32).storeUint(queryId, 64).endCell();
}
