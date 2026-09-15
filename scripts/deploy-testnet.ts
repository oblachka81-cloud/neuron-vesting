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

    console.log('Deployer wallet:', walletContract.address.toString({ testOnly: true }));

    // STEP 1: Activate wallet if uninitialized
    const state = await client.getContractState(walletContract.address);
    if (!state || state.state === 'uninit') {
        console.log('Wallet is uninitialized, activating...');
        const seqno = 0;
        const transfer = walletContract.createTransfer({
            seqno,
            secretKey: key.secretKey,
            messages: [internal({
                to: walletContract.address,
                value: toNano('0.01'),
                body: beginCell().endCell(),
            })],
        });
        await client.sendExternalMessage(walletContract, key.secretKey, transfer);
        console.log('Activation sent, waiting 15s...');
        await new Promise((r) => setTimeout(r, 15000));
    }

    // STEP 2: Deploy factory
    const treasury = process.env.TREASURY_ADDRESS
        ? Address.parse(process.env.TREASURY_ADDRESS)
        : walletContract.address;

    const factoryInit = await LockupFactory.init(treasury);
    const factoryAddress = contractAddress(0, factoryInit);

    console.log('Factory address:', factoryAddress.toString({ testOnly: true }));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory already deployed!');
        return;
    }

    const seqno = await walletContract.getSeqno();
    await walletContract.sendTransfer({
        seqno,
        secretKey: key.secretKey,
        messages: [internal({
            to: factoryAddress,
            value: toNano('0.5'),
            init: factoryInit,
            body: beginCell().endCell(),
        })],
    });

    console.log('Factory deploy sent, waiting 20s...');
    await new Promise((r) => setTimeout(r, 20000));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory deployed on testnet!');
        console.log('Explorer: https://testnet.tonviewer.com/' + factoryAddress.toString({ testOnly: true }));
    } else {
        console.log('⚠️ Not confirmed yet, check explorer in a minute');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
