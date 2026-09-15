import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV2R1, WalletContractV2R2, WalletContractV3R1, WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

async function main() {
    const mnemonic = (process.env.TESTNET_MNEMONIC || '').trim().split(/\s+/);
    const key = await mnemonicToPrivateKey(mnemonic);

    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    const versions = [
        { name: 'V2R1', w: WalletContractV2R1.create({ workchain: 0, publicKey: key.publicKey }) },
        { name: 'V2R2', w: WalletContractV2R2.create({ workchain: 0, publicKey: key.publicKey }) },
        { name: 'V3R1', w: WalletContractV3R1.create({ workchain: 0, publicKey: key.publicKey }) },
        { name: 'V3R2', w: WalletContractV3R2.create({ workchain: 0, publicKey: key.publicKey }) },
        { name: 'V4R2', w: WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }) },
        { name: 'V5R1', w: WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }) },
    ];

    console.log('=== Target: Gram web testnet wallet 0QBLs2...XU9lr ===');
    for (const v of versions) {
        const st = await client.getContractState(v.w.address);
        console.log(`${v.name}: ${v.w.address.toString({ testOnly: true })} state=${st?.state} balance=${st?.balance ?? 0n}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
