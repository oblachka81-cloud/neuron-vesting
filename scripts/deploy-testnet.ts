import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { toNano, contractAddress, beginCell, Address, storeStateInit } from '@ton/core';
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

    console.log('Deployer wallet:', walletContract.address.toString({ testOnly: true }));
    console.log('Factory address:', factoryAddress.toString({ testOnly: true }));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('Factory already deployed, nothing to do');
        return;
    }

    // Signed transfer, seqno 0: wallet is uninitialized, this very message deploys it
    const transfer = await walletContract.createTransfer({
        secretKey: key.secretKey,
        seqno: 0,
        messages: [internal({
            to: factoryAddress,
            value: toNano('0.5'),
            init: stateInit,
            body: beginCell().endCell(),
        })],
    });

    // Wrap into external message WITH wallet stateInit (deploy wallet + send transfer in one)
    const walletInitCell = beginCell().store(storeStateInit(wallet.init)).endCell();

    const extMsg = beginCell()
        .storeUint(0b10, 2)
        .storeUint(0b00, 2)
        .storeAddress(walletContract.address)
        .storeCoins(0)
        .storeBit(1)
        .storeBit(1)
        .storeRef(walletInitCell)
        .storeBit(1)
        .storeRef(transfer)
        .endCell();

    await client.sendFile(extMsg.toBoc());

    console.log('Deploy transaction sent, waiting...');
    await new Promise((r) => setTimeout(r, 20000));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory deployed on testnet!');
        console.log('Explorer: https://testnet.tonviewer.com/' + factoryAddress.toString({ testOnly: true }));
    } else {
        console.log('⚠️ Not confirmed yet, check the explorer in a minute');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
