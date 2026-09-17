// Deploy LockupFactory v2 to MAINNET (with fallback RPC)
import * as ton from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, toNano } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';

const TREASURY = 'EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl';
const COGNIQ_MASTER = 'EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg';

// Two endpoints — try Toncenter first, fall back to Orbs
const ENDPOINTS = [
    { url: 'https://toncenter.com/api/v2/jsonRPC', key: process.env.TONCENTER_API_KEY },
    { url: 'https://ton.access.orbs.network/1/rpc', key: undefined },
    { url: 'https://toncenter.com/api/v2/jsonRPC', key: undefined },
];

async function main() {
    const mnemonic = (process.env.MAINNET_MNEMONIC || '').trim();
    if (!mnemonic) throw new Error('MAINNET_MNEMONIC is not set');

    // Pick working endpoint
    let client: ton.TonClient | null = null;
    for (const ep of ENDPOINTS) {
        try {
            const c = new ton.TonClient({
                endpoint: ep.url,
                apiKey: ep.key || undefined,
            });
            await c.getBalance(Address.parse(TREASURY));
            client = c;
            console.log('RPC OK:', ep.url, ep.key ? '(with key)' : '(no key)');
            break;
        } catch (e) {
            console.log('RPC FAIL:', ep.url, (e as Error).message);
        }
    }
    if (!client) throw new Error('All RPC endpoints failed');

    const pk = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    const wallet = ton.WalletContractV5R1.create({ workchain: 0, publicKey: pk.publicKey });
    const walletContract = client.open(wallet);

    const balance = await client.getBalance(wallet.address);
    console.log('Deployer:', wallet.address.toString(), 'balance:', balance.toString());
    if (balance < toNano('0.3')) throw new Error('Deployer balance too low');

    const treasury = Address.parse(TREASURY);
    const master = Address.parse(COGNIQ_MASTER);
    const factory = client.open(await LockupFactory.fromInit(treasury));

    console.log('TREASURY:', treasury.toString());
    console.log('FACTORY :', factory.address.toString());
    console.log('Explorer: https://tonviewer.com/' + factory.address.toString());

    if (!(await client.isContractDeployed(factory.address))) {
        console.log('Deploying...');
        const seqno = await walletContract.getSeqno();
        await walletContract.sendTransfer({
            seqno,
            secretKey: pk.secretKey,
            messages: [ton.internal({
                to: factory.address,
                value: toNano('0.5'),
                init: factory.init,
                body: beginCell().endCell(),
            })],
        });
        for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));  // 5 сек вместо 3
    try {
        if (await client.isContractDeployed(factory.address)) break;
    } catch (e) {
        console.log('Polling retry...', (e as Error).message);
    }
}
        if (!(await client.isContractDeployed(factory.address))) throw new Error('Not active after 90s');
        console.log('FACTORY DEPLOYED ✅');
    } else {
        console.log('Already deployed');
    }

    console.log('nextLockId:', (await factory.getNextLockId()).toString());

    const res = await client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(factory.address).endCell() },
    ]);
    const factoryJettonWallet = res.stack.readCell().beginParse().loadAddress()!;
    console.log('FACTORY COGNIQ JETTON WALLET:', factoryJettonWallet.toString());

    const body = beginCell()
        .storeUint(0x21, 32)
        .storeUint(1, 64)
        .storeAddress(master)
        .storeAddress(factoryJettonWallet)
        .endCell();

    console.log('');
    console.log('=== WHITELIST via multisig.ton.org ===');
    console.log('Target:', factory.address.toString());
    console.log('Value : 0.1');
    console.log('Body  :', body.toBoc().toString('base64'));
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
