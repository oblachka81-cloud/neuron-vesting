import { Address, beginCell } from '@ton/core';

const RPC = 'https://toncenter.com/api/v2/jsonRPC';
const TO = Address.parse('UQBniD_M-MTeVqUbWshZrXdQcz0m8lPstG3mQg1AL5KKCGSv');
const FACTORIES: [string, string][] = [
  ['salt3', 'EQBh5qfBk5q_du4aw4pBnxee0_FFKTmBkVIiS2G2ZkWGqhZL'],
  ['salt2', 'EQDchgRlQ02H69hwys9ZGdQiiaqvt6OVVeKQvNb6LWlj0S5z'],
  ...(process.env.SALT1 ? [['salt1', process.env.SALT1] as [string, string]] : []),
];

async function rpc(method: string, params: any): Promise<any> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '1', jsonrpc: '2.0', method, params }),
  });
  const j: any = await r.json();
  if (!j.ok && !j.result) throw new Error(`${method}: ${JSON.stringify(j)}`);
  return j.result;
}

async function main() {
  let qid = 900n;
  for (const [name, addr] of FACTORIES) {
    const bal = BigInt(await rpc('getAddressBalance', { address: addr }));
    let tf = 0n;
    try {
      const g = await rpc('runGetMethod', { address: addr, method: 'ton_fees', stack: [] });
      tf = BigInt(g.stack[0][1]);
    } catch { /* старая версия без геттера */ }
    console.log(`\n=== ${name} ${addr} | balance=${Number(bal) / 1e9} TON | ton_fees=${Number(tf) / 1e9} ===`);

    const feeTake = tf < bal - 50_000_000n ? tf : (bal > 50_000_000n ? bal - 50_000_000n : 0n);
    if (feeTake > 0n) {
      console.log(`ORDER A (Target=${addr}, Value=0.2) WithdrawTonFees ${Number(feeTake) / 1e9} TON:`);
      console.log(beginCell().storeUint(0x22, 32).storeUint(qid++, 64).storeCoins(feeTake).storeAddress(TO).endCell().toBoc().toString('base64'));
    }
    const rest = bal - feeTake - (tf - feeTake) + 130_000_000n - 60_000_000n;
    if (rest > 0n) {
      console.log(`ORDER B (Target=${addr}, Value=0.2) RescueTon ${Number(rest) / 1e9} TON:`);
      console.log(beginCell().storeUint(0x23, 32).storeUint(qid++, 64).storeCoins(rest).storeAddress(TO).endCell().toBoc().toString('base64'));
    }
  }
  console.log('\nПосле исполнения ордеров запусти скрипт ЕЩЁ РАЗ — добьёт остатки.');
}

main().catch(console.error);
