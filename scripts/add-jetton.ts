// Add a TEP-74 jetton master to the LockupFactory on-chain whitelist.
// Usage: npx tsx scripts/add-jetton.ts <JETTON_MASTER_ADDRESS>
//
// Prints a ready-to-sign SetJettonWallet body for multisig.ton.org.
// Does NOT sign or send anything — treasury signs via 2-of-3 multisig.

import { Address, beginCell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { getHttpEndpoint } from '@orbs-network/ton-access';

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS
  || 'EQBAbjNhuYAfWcZ6cnYXHCNhwOf1VH_OBNfkiAzEPvf7S6iE';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

async function main() {
  const masterArg = process.argv[2];
  if (!masterArg) {
    console.error('Usage: npx tsx scripts/add-jetton.ts <JETTON_MASTER_ADDRESS>');
    process.exit(1);
  }

  const master = Address.parse(masterArg);
  const factory = Address.parse(FACTORY_ADDRESS);

  let client: TonClient | null = null;
  const candidates: Array<{ name: string; make: () => Promise<TonClient> }> = [
    {
      name: 'Toncenter+key',
      make: async () => new TonClient({
        endpoint: 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: TONCENTER_API_KEY,
      }),
    },
    {
      name: 'Orbs',
      make: async () => new TonClient({
        endpoint: await getHttpEndpoint({ network: 'mainnet' }),
      }),
    },
  ];
  for (const rpc of candidates) {
    try {
      const c = await rpc.make();
      await c.getMasterchainInfo();
      client = c;
      console.log(`RPC OK (${rpc.name})`);
      break;
    } catch (e) {
      console.log(`${rpc.name} FAIL: ${(e as Error).message}`);
    }
  }
  if (!client) throw new Error('All RPC endpoints failed');
  const c = client;

  console.log('Factory :', factory.toString());
  console.log('Master  :', master.toString());

  const res = await c.runMethod(master, 'get_wallet_address', [
    { type: 'slice', cell: beginCell().storeAddress(factory).endCell() },
  ]);
  const factoryJettonWallet = res.stack.readCell().beginParse().loadAddress()!;
  console.log('Factory JW:', factoryJettonWallet.toString());

  try {
    const check = await c.runMethod(factory, 'isWalletSet', [
      { type: 'slice', cell: beginCell().storeAddress(master).endCell() },
    ]);
    const already = check.stack.readNumber() !== 0n;
    if (already) {
      console.log('');
      console.log('ALREADY WHITELISTED on-chain. Nothing to do.');
      return;
    }
  } catch (e) {
    console.log('isWalletSet getter failed, continuing anyway:', (e as Error).message);
  }

  const qid = BigInt(Date.now());
  const body = beginCell()
    .storeUint(0x21, 32)
    .storeUint(qid, 64)
    .storeAddress(master)
    .storeAddress(factoryJettonWallet)
    .endCell();

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('SET JETTON WALLET — sign via multisig.ton.org');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Target (factory):', factory.toString());
  console.log('Value           : 0.1 TON');
  console.log('Jetton master   :', master.toString());
  console.log('Factory JW      :', factoryJettonWallet.toString());
  console.log('query_id        :', qid.toString());
  console.log('Body (base64)   :', body.toBoc().toString('base64'));
  console.log('');
  console.log('Copy Body → multisig.ton.org → Create new order → Arbitrary order.');
  console.log('Sign with 2 of 3 signers.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
