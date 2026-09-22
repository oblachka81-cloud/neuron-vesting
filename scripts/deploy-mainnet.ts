// Deploy LockupFactory v2.6.0 to MAINNET
import * as ton from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, toNano, storeMessage, internal, SendMode } from '@ton/core';
import { getHttpEndpoint } from '@orbs-network/ton-access';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';

const TREASURY = 'EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl';
const COGNIQ_MASTER = 'EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg';

async function main() {
    const mnemonic = (process.env.MAINNET_MNEMONIC || '').trim();
    if (!mnemonic) throw new Error('MAINNET_MNEMONIC is not set');

    const pk = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    const wallet = ton.WalletContractV5R1.create({ workchain: 0, publicKey: pk.publicKey });

    const rpcCandidates: Array<{ name: string; make: () => Promise<ton.TonClient> }> = [
        {
            name: 'Toncenter+key',
            make: async () => new ton.TonClient({
                endpoint: 'https://toncenter.com/api/v2/jsonRPC',
                apiKey: process.env.TONCENTER_API_KEY,
            }),
        },
        {
            name: 'Orbs',
            make: async () => new ton.TonClient({
                endpoint: await getHttpEndpoint({ network: 'mainnet' }),
            }),
        },
    ];

    let client: ton.TonClient | null = null;
    let walletContract: ton.OpenedContract<ton.WalletContractV5R1> | null = null;
    let seqno: number | null = null;

    for (const rpc of rpcCandidates) {
        try {
            const c = await rpc.make();
            await c.getMasterchainInfo();
            const wc = c.open(wallet);
            const s = await wc.getSeqno();
            client = c;
            walletContract = wc;
            seqno = s;
            console.log(`RPC OK (${rpc.name}), seqno=${s}`);
            break;
        } catch (e) {
            console.log(`${rpc.name} FAIL: ${(e as Error).message}`);
        }
    }

    if (!client || !walletContract || seqno === null) throw new Error('All RPC endpoints failed');
    const c = client;
    const wc = walletContract;

    const balance = await c.getBalance(wallet.address);
    console.log('Deployer:', wallet.address.toString(), 'balance:', balance.toString());
    if (balance < toNano('0.3')) throw new Error('Deployer balance too low');

    const dState = await c.getContractState(wallet.address);
    if (dState.state !== 'active') {
        console.log(`Deployer wallet state=${dState.state} - self-deploying...`);
        const body = await wallet.createTransfer({
            seqno: 0,
            secretKey: pk.secretKey,
            messages: [internal({ to: wallet.address, value: toNano('0.05'), bounce: false })],
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
        const ext = beginCell().store(storeMessage({
            info: { type: 'external-in', dest: wallet.address, importFee: 0n },
            init: { code: wallet.init!.code, data: wallet.init!.data },
            body,
        })).endCell();
        await c.sendFile(ext.toBoc());
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const st = await c.getContractState(wallet.address);
            if (st.state === 'active') { console.log('Deployer wallet ACTIVE'); break; }
        }
    }

    // ── Fee params from env (with defaults) ────────────────────────────
    const FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? '50');
    const FEE_TON_NANO = BigInt(process.env.PLATFORM_FEE_TON_NANO ?? '1000000000');
    const SALT = BigInt(process.env.DEPLOY_SALT ?? '1');

    if (FEE_BPS < 0 || FEE_BPS > 1000) throw new Error('PLATFORM_FEE_BPS must be 0..1000');
    if (FEE_TON_NANO < 0n) throw new Error('PLATFORM_FEE_TON_NANO must be >= 0');

    console.log('');
    console.log('Fee BPS  :', FEE_BPS, `(${FEE_BPS / 100}%)`);
    console.log('Fee TON  :', FEE_TON_NANO.toString(), `nano (${Number(FEE_TON_NANO) / 1e9} TON)`);
    console.log('Salt     :', SALT.toString());

    const treasury = Address.parse(TREASURY);
    const master = Address.parse(COGNIQ_MASTER);
    const factory = c.open(
        await LockupFactory.fromInit(treasury, SALT, BigInt(FEE_BPS), FEE_TON_NANO)
    );

    console.log('TREASURY:', treasury.toString());
    console.log('FACTORY :', factory.address.toString());
    console.log('Explorer: https://tonviewer.com/' + factory.address.toString());

    const initial = await c.getContractState(factory.address);
    if (initial.state !== 'active') {
        console.log('Deploying factory...');
        await wc.sendTransfer({
            seqno: seqno!,
            secretKey: pk.secretKey,
            messages: [internal({
                to: factory.address,
                value: toNano('0.5'),
                init: factory.init,
                body: beginCell().endCell(),
            })],
        });
        console.log('Sent. Waiting up to 90s...');
        let active = false;
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const st = await c.getContractState(factory.address);
            if (st.state === 'active') { console.log('FACTORY DEPLOYED ✅'); active = true; break; }
        }
        if (!active) console.log('⚠️ Factory not active yet. Check explorer.');
    } else {
        console.log('Factory already active at this address (same salt+treasury+fees).');
    }

    console.log('nextLockId:', (await factory.getNextLockId()).toString());

    const res = await c.runMethod(master, 'get_wallet_address', [
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
