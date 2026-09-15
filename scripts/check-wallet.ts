import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import * as bip39 from 'bip39';
import { getMasterKeyFromSeed, derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';

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
        for (const path of ["m/44'/607'/0'/0'/0'", "m/44'/607'/0'"]) {
            const derived = derivePath(path, getMasterKeyFromSeed(seed).key).key;
            const kp = nacl.sign.keyPair.fromSeed(Buffer.from(derived));
            keys.push({ name: `BIP39 ${path}`, publicKey: Buffer.from(kp.publicKey) });
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
