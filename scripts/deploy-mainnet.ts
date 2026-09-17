// Deploy LockupFactory v2 to MAINNET + print whitelist deep-link for treasury
import * as ton from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, beginCell, toNano } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';

const TREASURY = 'EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl';
const COGNIQ_MASTER = 'EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg';

async function main() {
    const mnemonic = (process.env.MAINNET_MNEMONIC || '').trim();
    if (!mnemonic) throw new Error('MAINNET_MNEMONIC is not set');

    const client = new ton.TonClient({
        endpoint: 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY || undefined,
    });

    const pk = await mnemonicToPrivateKey(mnemonic.split(/\s+/));

    // pick whatever wallet class this @ton/ton version actually exports
    const lib: any = ton as any;
    const ctorNames = ['WalletContractV5R1', 'WalletContractV4R2', 'WalletContractV4', 'WalletContractV3R2'];
    const candidates: any[] = [];
    for (const name of ctorNames) {
        const C: any = lib[name];
        if (!C || typeof C.create !== 'function') continue;
        try {
            candidates.push(C.create({ workchain: 0, publicKey: pk.publicKey, network: -239 }));
        } catch {
            try { candidates.push(C.create({ workchain: 0, publicKey: pk.publicKey })); } catch {}
        }
    }
    if (candidates.length === 0) {
        throw new Error('No wallet class found. Exports with "Wallet": ' +
            Object.keys(lib).filter((k) => /Wallet/i.test(k)).join(', '));
    }

    let wallet: any = null;
    for (const c of candidates) {
        const b = await client.getBalance(c.address);
        console.log('candidate wallet:', c.address.toString(), b.toString());
        if (b > toNano('0.05')) { wallet = c; break; }
    }
    if (!wallet) throw new Error('Deployer wallet has no balance on any known version. Send ~1 TON first.');

    const treasury = Address.parse(TREASURY);
    const master = Address.parse(COGNIQ_MASTER);
    const factory = client.open(await LockupFactory.fromInit(treasury));

    console.log('FACTORY ADDRESS:', factory.address.toString());
    console.log('explorer: https://tonviewer.com/' + factory.address.toString());

    const deployed = await client.isContractDeployed(factory.address);
    if (!deployed) {
        console.log('Deploying factory...');
        const transfer = await wallet.createTransfer({
            secretKey: pk.secretKey,
            messages: [ton.internal({
                to: factory.address,
                value: toNano('0.5'),
                init: factory.init,
                body: beginCell().endCell(),
            })],
        });
        await client.sendFile(transfer.toBoc());
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            if (await client.isContractDeployed(factory.address)) break;
        }
        if (!(await client.isContractDeployed(factory.address))) throw new Error('Factory not active after 90s');
        console.log('FACTORY DEPLOYED ✅');
    } else {
        console.log('Factory already active — skipping deploy');
    }

    console.log('nextLockId:', (await factory.getNextLockId()).toString());
    console.log('treasury :', (await factory.getTreasuryAddress()).toString());

    // factory's own COGNIQ jetton wallet (ask the master)
    const res = await client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(factory.address).endCell() },
    ]);
    const factoryJettonWallet = res.stack.readCell().beginParse().loadAddress();
    console.log('FACTORY COGNIQ JETTON WALLET:', factoryJettonWallet.toString());

    // SetJettonWallet body for treasury signature (op 0x21)
    const body = beginCell()
        .storeUint(0x21, 32)
        .storeUint(1, 64)
        .storeAddress(master)
        .storeAddress(factoryJettonWallet)
        .endCell();
    const bin = encodeURIComponent(body.toBoc().toString('base64'));
    console.log('');
    console.log('=== WHITELIST DEEP-LINK (open on tablet with OPS wallet in Tonkeeper) ===');
    console.log('ton://transfer/' + factory.address.toString() + '?amount=100000000&bin=' + bin);
    console.log('');
    console.log('After signing: whitelist done. COGNIQ approved for locks.');
}

main().catch((e) => { console.error('DEPLOY FAILED:', e); process.exit(1); });
