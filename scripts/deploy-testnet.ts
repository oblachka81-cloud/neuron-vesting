import { createHmac } from 'crypto';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1, WalletContractV4, internal } from '@ton/ton';
import { toNano, contractAddress, beginCell, Address } from '@ton/core';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';

const H = 0x80000000;

function slip10Ed25519(seed: Buffer, path: number[]): Buffer {
    let I = createHmac('sha512', Buffer.from('ed25519 seed')).update(seed).digest();
    let key = I.subarray(0, 32);
    let chain = I.subarray(32);
    for (const idx of path) {
        const idxBuf = Buffer.from([(idx >>> 24) & 0xff, (idx >>> 16) & 0xff, (idx >>> 8) & 0xff, idx & 0xff]);
        const data = Buffer.concat([Buffer.from([0x00]), Buffer.from(key), idxBuf]);
        I = createHmac('sha512', Buffer.from(chain)).update(data).digest();
        key = I.subarray(0, 32);
        chain = I.subarray(32);
    }
    return Buffer.from(key);
}

async function main() {
    const words = (process.env.TESTNET_MNEMONIC || '').trim().split(/\s+/);

    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    const keys: { name: string; publicKey: Buffer; secretKey: Buffer }[] = [];

    try {
        const k = await mnemonicToPrivateKey(words);
        keys.push({ name: 'TON-native', publicKey: k.publicKey, secretKey: k.secretKey });
    } catch {}

    if (bip39.validateMnemonic(words.join(' '))) {
        const seed = bip39.mnemonicToSeedSync(words.join(' '));
        for (const p of [
            { name: "BIP39 m/44'/607'/0'/0'/0'", path: [44 + H, 607 + H, 0 + H, 0 + H, 0 + H] },
            { name: "BIP39 m/44'/607'/0'", path: [44 + H, 607 + H, 0 + H] },
        ]) {
            const priv = slip10Ed25519(seed, p.path);
            const kp = nacl.sign.keyPair.fromSeed(priv);
            keys.push({ name: p.name, publicKey: Buffer.from(kp.publicKey), secretKey: Buffer.from(kp.secretKey) });
        }
    }

    let chosen: { name: string; secretKey: Buffer; wallet: any; opened: any } | null = null;
    for (const pk of keys) {
        for (const vname of ['V5R1-testnet', 'V4R2']) {
            const w = vname === 'V4R2'
                ? WalletContractV4.create({ workchain: 0, publicKey: pk.publicKey })
                : WalletContractV5R1.create({ workchain: 0, publicKey: pk.publicKey, walletId: { networkGlobalId: -3 } });
            const st = await client.getContractState(w.address);
            const bal = st?.balance ?? 0n;
            console.log(`${pk.name} ${vname}: ${w.address.toString({ testOnly: true })} state=${st?.state} balance=${bal}`);
            if (!chosen && bal >= toNano('0.7')) {
                chosen = { name: pk.name, secretKey: pk.secretKey, wallet: w, opened: client.open(w) };
            }
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    if (!chosen) throw new Error('No funded wallet derived from this mnemonic. Secret must hold the words of 0QDp... wallet');

    console.log('=== CHOSEN:', chosen.name, chosen.wallet.address.toString({ testOnly: true }), '===');

    const treasury = process.env.TREASURY_ADDRESS ? Address.parse(process.env.TREASURY_ADDRESS) : chosen.wallet.address;
    const factoryInit = await LockupFactory.init(treasury);
    const factoryAddress = contractAddress(0, factoryInit);
    console.log('Factory address:', factoryAddress.toString({ testOnly: true }));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory already deployed!');
        return;
    }

    const seqno = await chosen.opened.getSeqno();
    console.log('Wallet seqno:', seqno);

    await chosen.opened.sendTransfer({
        seqno,
        secretKey: chosen.secretKey,
        messages: [internal({ to: factoryAddress, value: toNano('0.5'), init: factoryInit, body: beginCell().endCell() })],
    });

    console.log('Deploy sent, waiting 25s...');
    await new Promise((r) => setTimeout(r, 25000));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory deployed on testnet!');
        console.log('Explorer: https://testnet.tonviewer.com/' + factoryAddress.toString({ testOnly: true }));
    } else {
        console.log('⚠️ Not confirmed yet — check explorer in a minute');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
