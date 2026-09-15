import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, beginCell, Address } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';
import { LockupWallet } from '../build/LockupFactory_LockupWallet';
import '@ton/test-utils';

function makeLockPayload(qid: bigint, jm: Address, ben: Address, creator: Address, unlockAt: bigint) {
    const inner = beginCell()
        .storeUint(0x1, 32)
        .storeUint(qid, 64)
        .storeAddress(jm)
        .storeAddress(ben)
        .storeAddress(creator)
        .storeUint(unlockAt, 64)
        .endCell();
    return beginCell().storeBit(1).storeRef(inner).endCell().asSlice();
}

function makeJettonNotification(queryId: bigint, amount: bigint, sender: Address, payload: any) {
    return {
        $$type: 'JettonNotification' as const,
        query_id: queryId,
        amount: amount,
        sender: sender,
        forward_payload: payload,
    };
}

describe('NEURON Vesting — full suite', () => {
    let blockchain: Blockchain;
    let treasury: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let beneficiary: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<TreasuryContract>;
    let fakeJettonWallet: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let factory: SandboxContract<LockupFactory>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        treasury = await blockchain.treasury('treasury');
        user = await blockchain.treasury('user');
        beneficiary = await blockchain.treasury('beneficiary');
        jettonMaster = await blockchain.treasury('jettonMaster');
        fakeJettonWallet = await blockchain.treasury('jettonWallet');
        attacker = await blockchain.treasury('attacker');

        factory = blockchain.openContract(await LockupFactory.fromInit(treasury.address));
        await factory.send(treasury.getSender(), { value: toNano('2') }, null);
    });

    it('1. deploys factory', async () => {
        expect(await factory.getNextLockId()).toEqual(1n);
    });

    it('2. creates a lock on jetton notification', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        expect(res.transactions).toHaveTransaction({
            from: fakeJettonWallet.address, to: factory.address, success: true,
        });
        expect(await factory.getNextLockId()).toEqual(2n);
        expect(await factory.getFeeOf(jettonMaster.address)).toEqual(5_000_000n);
    });

    it('3. claim before unlock_at -> rejected', async () => {
        blockchain.now = Math.floor(Date.now() / 1000) + 60;
        const unlockAt = BigInt(blockchain.now + 3600);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const wallet = blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );

        const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') },
            { $$type: 'Claim', query_id: 0n });

        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address, to: wallet.address, success: false,
        });
    });

    it('4. claim after unlock_at -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 100);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const wallet = blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );

        blockchain.now = Number(unlockAt) + 10;

        const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') },
            { $$type: 'Claim', query_id: 0n });

        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address, to: wallet.address, success: true,
        });
        expect(res.transactions).toHaveTransaction({
            from: wallet.address, to: fakeJettonWallet.address,
            op: 0x0f8a7ea5,
        });
    });

    it('5. claim by non-beneficiary -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 100);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const wallet = blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );

        blockchain.now = Number(unlockAt) + 10;

        const res = await wallet.send(attacker.getSender(), { value: toNano('0.5') },
            { $$type: 'Claim', query_id: 0n });

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: wallet.address, success: false,
        });
    });

    it('6. extend forward by creator -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const wallet = blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );

        const newUnlock = unlockAt + 7200n;
        const res = await wallet.send(user.getSender(), { value: toNano('0.5') },
            { $$type: 'Extend', query_id: 0n, new_unlock_at: newUnlock });

        expect(res.transactions).toHaveTransaction({
            from: user.address, to: wallet.address, success: true,
        });
        expect(await wallet.getUnlockAt()).toEqual(newUnlock);
    });

    it('7. extend into the past -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 7200);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const wallet = blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );

        const newUnlock = unlockAt - 1800n;
        const res = await wallet.send(user.getSender(), { value: toNano('0.5') },
            { $$type: 'Extend', query_id: 0n, new_unlock_at: newUnlock });

        expect(res.transactions).toHaveTransaction({
            from: user.address, to: wallet.address, success: false,
        });
    });

    it('8. extend by non-creator -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const wallet = blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );

        const newUnlock = unlockAt + 3600n;
        const res = await wallet.send(attacker.getSender(), { value: toNano('0.5') },
            { $$type: 'Extend', query_id: 0n, new_unlock_at: newUnlock });

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: wallet.address, success: false,
        });
    });

    it('9. withdraw fees by treasury -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        expect(await factory.getFeeOf(jettonMaster.address)).toEqual(5_000_000n);

        const res = await factory.send(treasury.getSender(), { value: toNano('0.5') },
            { $$type: 'WithdrawFees', query_id: 0n,
              jetton_master: jettonMaster.address,
              destination_wallet: treasury.address,
              amount: 5_000_000n });

        expect(res.transactions).toHaveTransaction({
            from: treasury.address, to: factory.address, success: true,
        });
        expect(await factory.getFeeOf(jettonMaster.address)).toEqual(0n);
    });

    it('10. withdraw fees by non-treasury -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, user.address, unlockAt);

        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));

        const res = await factory.send(attacker.getSender(), { value: toNano('0.5') },
            { $$type: 'WithdrawFees', query_id: 0n,
              jetton_master: jettonMaster.address,
              destination_wallet: attacker.address,
              amount: 5_000_000n });

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: factory.address, success: false,
        });
    });
});
