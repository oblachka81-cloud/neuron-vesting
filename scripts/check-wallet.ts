import { createHmac } from 'crypto';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import * as bip39 from 'bip39';
import nacl from 'tweetnacl';

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

    const keys: { name: string; publicKey: Buffer }[] = [];

    try {
        const k = await mnemonicToPrivateKey(words);
        keys.push({ name: 'TON-native', publicKey: k.publicKey });
    } catch (e) {
        console.log('TON-native derivation failed:', (e as Error).message);
    }

    if (bip39.validateMnemonic(words.join(' '))) {
        const seed = bip39.mnemonicToSeedSync(words.join(' '));
        const paths: { name: string; p: number[] }[] = [
            { name: "BIP39 m/44'/607'/0'/0'/0'", p: [44 + H, 607 + H, 0 + H, 0 + H, 0 + H] },
            { name: "BIP39 m/44'/607'/0'", p: [44 + H, 607 + H, 0 + H] },
        ];
        for (const pp of paths) {
            const priv = slip10Ed25519(seed, pp.p);
            const kp = nacl.sign.keyPair.fromSeed(priv);
            keys.push({ name: pp.name, publicKey: Buffer.from(kp.publicKey) });
        }
    } else {
        console.log('Not a valid BIP39 mnemonic');
    }

    console.log('=== Target: Gram web testnet wallet 0QBLs2...XU9lr ===');
    for (const k of keys) {
        for (const vname of ['V3R2', 'V4R2', 'V5R1']) {
            const w =
                vname === 'V3R2' ? WalletContractV3R2.create({ workchain: 0, publicKey: k.publicKey }) :
                vname === 'V4R2' ? WalletContractV4.create({ workchain: 0, publicKey: k.publicKey }) :
                WalletContractV5R1.create({ workchain: 0, publicKey: k.publicKey });
            const st = await client.getContractState(w.address);
            console.log(`${k.name} ${vname}: ${w.address.toString({ testOnly: true })} state=${st?.state} balance=${st?.balance ?? 0n}`);
            await new Promise((r) => setTimeout(r, 400));
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
