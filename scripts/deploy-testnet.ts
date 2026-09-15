import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { toNano, contractAddress, beginCell, Address } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';

async function main() {
    const mnemonic = (process.env.TESTNET_MNEMONIC || '').trim().split(/\s+/);
    if (mnemonic.length !== 12 && mnemonic.length !== 24) throw new Error('TESTNET_MNEMONIC must be 12 or 24 words');
    const key = await mnemonicToPrivateKey(mnemonic);

    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
    const walletContract = client.open(wallet);

    const treasury = process.env.TREASURY_ADDRESS
        ? Address.parse(process.env.TREASURY_ADDRESS)
        : walletContract.address;

    const stateInit = await LockupFactory.init(treasury);
    const factoryAddress = contractAddress(0, stateInit);

    console.log('Factory address:', factoryAddress.toString({ testOnly: true }));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('Already deployed, nothing to do');
        return;
    }

    const seqno = await walletContract.getSeqno();
    const transfer = await walletContract.createTransfer({
        secretKey: key.secretKey,
        seqno,
        messages: [internal({
            to: factoryAddress,
            value: toNano('0.5'),
            init: stateInit,
            body: beginCell().endCell(),
        })],
    });
    await walletContract.send(transfer);

    console.log('Deploy transaction sent, waiting...');
    await new Promise((r) => setTimeout(r, 15000));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory deployed on testnet!');
        console.log('Explorer: https://testnet.tonviewer.com/' + factoryAddress.toString({ testOnly: true }));
    } else {
        console.log('⚠️ Not confirmed yet, check the explorer in a minute');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
