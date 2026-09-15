import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

async function main() {
    const mnemonic = (process.env.TESTNET_MNEMONIC || '').trim().split(/\s+/);
    if (mnemonic.length !== 12 && mnemonic.length !== 24) throw new Error('Bad mnemonic length');
    const key = await mnemonicToPrivateKey(mnemonic);

    const v3 = WalletContractV3R2.create({ workchain: 0, publicKey: key.publicKey });
    const v4 = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
    const v5 = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });

    console.log('=== Addresses derived from your mnemonic ===');
    console.log('V3R2:', v3.address.toString({ testOnly: true }));
    console.log('V4R2:', v4.address.toString({ testOnly: true }));
    console.log('V5R1:', v5.address.toString({ testOnly: true }));
    console.log('=== Compare with fauced address: UQC2wpwC3FbdvGwxutm7m6rjtRtBLtQz2gm2VAjL3nGBQrsQ ===');
}

main().catch(e => { console.error(e); process.exit(1); });
