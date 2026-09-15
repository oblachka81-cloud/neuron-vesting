import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, beginCell } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory/tact_LockupFactory';
import { LockupWallet } from '../build/LockupWallet/tact_LockupWallet';
import '@ton/test-utils';

describe('NEURON Vesting smoke', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let factory: SandboxContract<LockupFactory>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        factory = blockchain.openContract(LockupFactory.fromInit(deployer.address));
        const res = await factory.send(deployer.getSender(), { value: toNano('1') }, null);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: factory.address,
            deploy: true,
            success: true,
        });
    });

    it('deploys factory and exposes getters', async () => {
        expect(await factory.getNextLockId()).toEqual(1n);
        expect(await factory.getTreasuryAddress()).toEqualAddress(deployer.address);
    });

    it('creates a lock on jetton notification', async () => {
        const jettonWallet = await blockchain.treasury('jettonWallet');
        const user = await blockchain.treasury('user');
        const beneficiary = await blockchain.treasury('beneficiary');
        const jm = await blockchain.treasury('jettonMaster');
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

        const payload = beginCell()
            .storeUint(0x1, 32)
            .storeUint(7n, 64)
            .storeAddress(jm.address)
            .storeAddress(beneficiary.address)
            .storeAddress(user.address)
            .storeUint(unlockAt, 64)
            .endCell()
            .asSlice();

        const res = await factory.send(jettonWallet.getSender(), { value: toNano('1') }, {
            $$type: 'JettonNotification',
            queryId: 1n,
            amount: 1_000_000_000n,
            sender: user.address,
            forwardPayload: payload,
        });

        expect(res.transactions).toHaveTransaction({
            from: jettonWallet.address,
            to: factory.address,
            success: true,
        });

        expect(await factory.getNextLockId()).toEqual(2n);
        expect(await factory.getFeeOf(jm.address)).toEqual(5_000_000n);

        const wallet = blockchain.openContract(
            LockupWallet.fromInit(1n, factory.address, jm.address, beneficiary.address, user.address, 995_000_000n, unlockAt)
        );
        expect(await wallet.getTotalAmount()).toEqual(995_000_000n);
    });
});
