import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1, internal } from '@ton/ton';
import { toNano, contractAddress, beginCell, Address } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';

async function main() {
    const mnemonic = (process.env.TESTNET_MNEMONIC || '').trim().split(/\s+/);
    if (mnemonic.length !== 12 && mnemonic.length !== 24) {
        throw new Error('TESTNET_MNEMONIC must be 12 or 24 words');
    }
    const key = await mnemonicToPrivateKey(mnemonic);

    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    // V5R1 + TESTNET (networkGlobalId = -3) — разгадка студента
    const wallet = WalletContractV5R1.create({
        workchain: 0,
        publicKey: key.publicKey,
        walletId: { networkGlobalId: -3 },
    });
    const walletContract = client.open(wallet);

    const st = await client.getContractState(wallet.address);
    console.log(
        'Deployer wallet:',
        wallet.address.toString({ testOnly: true }),
        'state=', st?.state,
        'balance=', st?.balance ?? 0n
    );
    if ((st?.balance ?? 0n) < toNano('0.7')) {
        throw new Error('Wallet balance too low for deploy');
    }

    const treasury = process.env.TREASURY_ADDRESS
        ? Address.parse(process.env.TREASURY_ADDRESS)
        : wallet.address;

    const factoryInit = await LockupFactory.init(treasury);
    const factoryAddress = contractAddress(0, factoryInit);
    console.log('Factory address:', factoryAddress.toString({ testOnly: true }));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory already deployed!');
        return;
    }

    const seqno = await walletContract.getSeqno();
    console.log('Wallet seqno:', seqno);

    await walletContract.sendTransfer({
        seqno,
        secretKey: key.secretKey,
        messages: [
            internal({
                to: factoryAddress,
                value: toNano('0.5'),
                init: factoryInit,
                body: beginCell().endCell(),
            }),
        ],
    });

    console.log('Deploy sent, waiting 25s...');
    await new Promise((r) => setTimeout(r, 25000));

    if (await client.isContractDeployed(factoryAddress)) {
        console.log('✅ Factory deployed on testnet!');
        console.log(
            'Explorer: https://testnet.tonviewer.com/' +
                factoryAddress.toString({ testOnly: true })
        );
    } else {
        console.log('⚠️ Not confirmed yet — check explorer in a minute');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
