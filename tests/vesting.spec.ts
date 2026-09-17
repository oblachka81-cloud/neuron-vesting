import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, beginCell, Address } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';
import { LockupWallet } from '../build/LockupFactory_LockupWallet';
import '@ton/test-utils';

function makeLockPayload(qid: bigint, jm: Address, ben: Address, unlockAt: bigint) {
    const inner = beginCell()
        .storeUint(0x1, 32)
        .storeUint(qid, 64)
        .storeAddress(jm)
        .storeAddress(ben)
        .storeUint(unlockAt, 64)
        .endCell();
    return beginCell().storeBit(1).storeRef(inner).endCell().asSlice();
}

function makeJettonNotification(queryId: bigint, amount: bigint, sender: Address, payload: any, value: bigint = toNano('1.3')) {
    return {
        $$type: 'JettonNotification' as const,
        query_id: queryId,
        amount: amount,
        sender: sender,
        forward_payload: payload,
    };
}

describe('NEURON Vesting — full suite (v2.1)', () => {
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

        await factory.send(treasury.getSender(), { value: toNano('0.5') },
            { $$type: 'SetJettonWallet', query_id: 0n,
              jetton_master: jettonMaster.address,
              jetton_wallet: fakeJettonWallet.address });
    });

    async function createLock(unlockAt: bigint) {
        const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
        await factory.send(fakeJettonWallet.getSender(), { value: toNano('1.3') },
            makeJettonNotification(1n, 1_000_000_000n, user.address, payload));
        return blockchain.openContract(
            await LockupWallet.fromInit(1n, factory.address, jettonMaster.address,
                beneficiary.address, user.address, 995_000_000n, unlockAt)
        );
    }

    async function verifyWallet(wallet: SandboxContract<LockupWallet>) {
        await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
            $$type: 'JettonNotification',
            query_id: 2n,
            amount: 995_000_000n,
            sender: user.address,
            forward_payload: beginCell().endCell().asSlice(),
        });
        await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') }, {
            $$type: 'WalletAddressInfo',
            query_id: 0n,
            wallet: fakeJettonWallet.address,
            owner: wallet.address,
        });
    }

    it('1. deploys factory', async () => {
        expect(await factory.getNextLockId()).toEqual(1n);
    });

    it('2. creates a lock on jetton notification', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('1.3') },
            makeJettonNotification(1n, 1_000_000_000n, user.address,
                makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt)));

        expect(res.transactions).toHaveTransaction({
            from: fakeJettonWallet.address, to: factory.address, success: true,
        });
        expect(await factory.getNextLockId()).toEqual(2n);
        expect(await factory.getFeeOf(jettonMaster.address)).toEqual(5_000_000n);
        expect(await factory.getTonFees()).toEqual(toNano('1'));
    });

    it('3. unapproved jetton -> rejected', async () => {
        const unknownJetton = await blockchain.treasury('unknownJetton');
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

        const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('1.3') },
            makeJettonNotification(1n, 1_000_000_000n, user.address,
                makeLockPayload(1n, unknownJetton.address, beneficiary.address, unlockAt)));

        expect(res.transactions).toHaveTransaction({
            from: fakeJettonWallet.address, to: factory.address, success: false,
        });
    });

    it('4. wrong sender (not whitelisted wallet) -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

        const res = await factory.send(attacker.getSender(), { value: toNano('1.3') },
            makeJettonNotification(1n, 1_000_000_000n, user.address,
                makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt)));

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: factory.address, success: false,
        });
    });

    it('5. claim before unlock_at -> rejected', async () => {
        blockchain.now = Math.floor(Date.now() / 1000) + 60;
        const unlockAt = BigInt(blockchain.now + 3600);
        const wallet = await createLock(unlockAt);
        await verifyWallet(wallet);

        const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') },
            { $$type: 'Claim', query_id: 0n });

        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address, to: wallet.address, success: false,
        });
    });

    it('6. claim without wallet verification -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 100);
        const wallet = await createLock(unlockAt);
        blockchain.now = Number(unlockAt) + 10;

        const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') },
            { $$type: 'Claim', query_id: 0n });

        expect(res.transactions).toHaveTransaction({
            from: beneficiary.address, to: wallet.address, success: false,
        });
    });

    it('7. claim after unlock_at with verification -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 100);
        const wallet = await createLock(unlockAt);
        await verifyWallet(wallet);
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

    it('8. claim by non-beneficiary -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 100);
        const wallet = await createLock(unlockAt);
        await verifyWallet(wallet);
        blockchain.now = Number(unlockAt) + 10;

        const res = await wallet.send(attacker.getSender(), { value: toNano('0.5') },
            { $$type: 'Claim', query_id: 0n });

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: wallet.address, success: false,
        });
    });

    it('9. extend forward by creator -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const wallet = await createLock(unlockAt);

        const newUnlock = unlockAt + 7200n;
        const res = await wallet.send(user.getSender(), { value: toNano('0.5') },
            { $$type: 'Extend', query_id: 0n, new_unlock_at: newUnlock });

        expect(res.transactions).toHaveTransaction({
            from: user.address, to: wallet.address, success: true,
        });
        expect(await wallet.getUnlockAt()).toEqual(newUnlock);
    });

    it('10. extend into the past -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 7200);
        const wallet = await createLock(unlockAt);

        const newUnlock = unlockAt - 1800n;
        const res = await wallet.send(user.getSender(), { value: toNano('0.5') },
            { $$type: 'Extend', query_id: 0n, new_unlock_at: newUnlock });

        expect(res.transactions).toHaveTransaction({
            from: user.address, to: wallet.address, success: false,
        });
    });

    it('11. extend by non-creator -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const wallet = await createLock(unlockAt);

        const res = await wallet.send(attacker.getSender(), { value: toNano('0.5') },
            { $$type: 'Extend', query_id: 0n, new_unlock_at: unlockAt + 3600n });

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: wallet.address, success: false,
        });
    });

    it('12. withdraw fees by treasury -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        await createLock(unlockAt);
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

    it('13. withdraw fees by non-treasury -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        await createLock(unlockAt);

        const res = await factory.send(attacker.getSender(), { value: toNano('0.5') },
            { $$type: 'WithdrawFees', query_id: 0n,
              jetton_master: jettonMaster.address,
              destination_wallet: attacker.address,
              amount: 5_000_000n });

        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: factory.address, success: false,
        });
    });

    it('14. lock without 1.25 TON attach -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('0.5') },
            makeJettonNotification(1n, 1_000_000_000n, user.address,
                makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt)));
        expect(res.transactions).toHaveTransaction({
            from: fakeJettonWallet.address, to: factory.address, success: false,
        });
    });

    it('15. withdraw ton fees by treasury -> ok', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        await createLock(unlockAt);
        expect(await factory.getTonFees()).toEqual(toNano('1'));
        const res = await factory.send(treasury.getSender(), { value: toNano('0.2') },
            { $$type: 'WithdrawTonFees', query_id: 0n, amount: toNano('1'), destination: treasury.address });
        expect(res.transactions).toHaveTransaction({
            from: factory.address, to: treasury.address, success: true,
        });
        expect(await factory.getTonFees()).toEqual(0n);
    });

    it('16. withdraw ton fees by non-treasury -> rejected', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        await createLock(unlockAt);
        const res = await factory.send(attacker.getSender(), { value: toNano('0.2') },
            { $$type: 'WithdrawTonFees', query_id: 0n, amount: toNano('1'), destination: attacker.address });
        expect(res.transactions).toHaveTransaction({
            from: attacker.address, to: factory.address, success: false,
        });
    });
    it('17. withdraw bounce restores fee balance', async () => {
        const unlockAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const wallet = await createLock(unlockAt);
        await factory.send(treasury.getSender(), { value: toNano('0.5') },
            { $$type: 'SetJettonWallet', query_id: 0n,
              jetton_master: jettonMaster.address, jetton_wallet: wallet.address });
        const before = await factory.getFeeOf(jettonMaster.address);
        await factory.send(treasury.getSender(), { value: toNano('0.5') },
            { $$type: 'WithdrawFees', query_id: 77n,
              jetton_master: jettonMaster.address,
              destination_wallet: treasury.address, amount: 5_000_000n });
        expect(await factory.getFeeOf(jettonMaster.address)).toEqual(before);
    });
});
