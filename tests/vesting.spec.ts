import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, beginCell, Address, Cell } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';
import { LockupWallet } from '../build/LockupFactory_LockupWallet';
import '@ton/test-utils';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeLockPayload(qid: bigint, jm: Address, ben: Address, unlockAt: bigint): Cell {
    const inner = beginCell()
        .storeUint(0x1, 32)
        .storeUint(qid, 64)
        .storeAddress(jm)
        .storeAddress(ben)
        .storeUint(unlockAt, 64)
        .endCell();
    return beginCell().storeBit(1).storeRef(inner).endCell();
}

function makeJettonNotify(
    queryId: bigint,
    amount: bigint,
    sender: Address,
    payload: Cell,
) {
    return {
        $$type: 'JettonNotification' as const,
        query_id: queryId,
        amount: amount,
        sender: sender,
        forward_payload: payload.asSlice(),
    };
}

function makeTakeWalletAddress(qid: bigint, wallet: Address, owner: Address) {
    const ownerCell = beginCell().storeAddress(owner).endCell();
    return {
        $$type: 'TakeWalletAddress' as const,
        query_id: qid,
        wallet_address: wallet,
        owner_address: ownerCell,
    };
}

function makeExcesses(queryId: bigint) {
    return {
        $$type: 'JettonExcesses' as const,
        query_id: queryId,
    };
}


// ── Suite ─────────────────────────────────────────────────────────────────

describe('NEURON Vesting — v5.1.0 (isolated + TEP-89)', () => {
    let blockchain: Blockchain;
    let treasury: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let beneficiary: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<TreasuryContract>;
    let fakeJettonWallet: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let factory: SandboxContract<LockupFactory>;

    const FEE_TON = toNano('1');
    const ATTACH_TON = toNano('1.65');
    const JETTON_AMOUNT = 1_000_000_000n;
    const FEE_BPS = 50n;
    const FEE_JETTON = (JETTON_AMOUNT * FEE_BPS) / 10000n;
    const LOCK_AMOUNT = JETTON_AMOUNT - FEE_JETTON;
    const HIGH_BIT = 1n << 63n;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = Math.floor(Date.now() / 1000);

        treasury = await blockchain.treasury('treasury');
        user = await blockchain.treasury('user');
        beneficiary = await blockchain.treasury('beneficiary');
        jettonMaster = await blockchain.treasury('jettonMaster');
        fakeJettonWallet = await blockchain.treasury('jettonWallet');
        attacker = await blockchain.treasury('attacker');

        factory = blockchain.openContract(
            await LockupFactory.fromInit(treasury.address, 3n, 50n, 1000000000n),
        );
        await factory.send(treasury.getSender(), { value: toNano('10') }, null);

        await factory.send(
            treasury.getSender(),
            { value: toNano('0.5') },
            {
                $$type: 'SetJettonWallet',
                query_id: 1n,
                jetton_master: jettonMaster.address,
                jetton_wallet: fakeJettonWallet.address,
            },
        );
    });

    async function sendCreateLock(unlockAt: bigint, qid: bigint = 1n) {
        const payload = makeLockPayload(qid, jettonMaster.address, beneficiary.address, unlockAt);
        return factory.send(
            fakeJettonWallet.getSender(),
            { value: ATTACH_TON },
            makeJettonNotify(qid, JETTON_AMOUNT, user.address, payload),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: setup', () => {
        it('1. nextLockId = 1 after init', async () => {
            expect(await factory.getNextLockId()).toEqual(1n);
        });

        it('2. whitelist sets own_wallets', async () => {
            expect(await factory.getWalletOf(jettonMaster.address)).toEqualAddress(fakeJettonWallet.address);
            expect(await factory.getIsWalletSet(jettonMaster.address)).toEqual(true);
        });

        it('3. whitelist by non-treasury -> rejected', async () => {
            const m = await blockchain.treasury('m');
            const w = await blockchain.treasury('w');
            const res = await factory.send(attacker.getSender(), { value: toNano('0.5') }, {
                $$type: 'SetJettonWallet',
                query_id: 2n,
                jetton_master: m.address,
                jetton_wallet: w.address,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('4. whitelist with qid=0 -> rejected', async () => {
            const m = await blockchain.treasury('m');
            const w = await blockchain.treasury('w');
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'SetJettonWallet',
                query_id: 0n,
                jetton_master: m.address,
                jetton_wallet: w.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('5. whitelist overwrite with different wallet -> rejected', async () => {
            const other = await blockchain.treasury('other');
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'SetJettonWallet',
                query_id: 2n,
                jetton_master: jettonMaster.address,
                jetton_wallet: other.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('6. whitelist idempotent (same wallet) -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'SetJettonWallet',
                query_id: 2n,
                jetton_master: jettonMaster.address,
                jetton_wallet: fakeJettonWallet.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
        });

        it('7. whitelist cross-master wallet reuse -> rejected (CHECK2, bijection F3)', async () => {
            const otherMaster = await blockchain.treasury('otherMaster');
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'SetJettonWallet',
                query_id: 2n,
                jetton_master: otherMaster.address,
                jetton_wallet: fakeJettonWallet.address,
            });
            expect(res.transactions).toHaveTransaction({
                from: treasury.address, to: factory.address, success: false,
            });
            expect(await factory.getWalletOf(jettonMaster.address)).toEqualAddress(fakeJettonWallet.address);
            expect(await factory.getWalletOf(otherMaster.address)).toEqual(null);
            expect(await factory.getIsWalletSet(otherMaster.address)).toEqual(false);
        });

        it('8. whitelist second independent pair -> ok (F3 holds both ways)', async () => {
            const otherMaster = await blockchain.treasury('otherMaster');
            const otherWallet = await blockchain.treasury('otherWallet');
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'SetJettonWallet',
                query_id: 2n,
                jetton_master: otherMaster.address,
                jetton_wallet: otherWallet.address,
            });
            expect(res.transactions).toHaveTransaction({
                from: treasury.address, to: factory.address, success: true,
            });
            expect(await factory.getWalletOf(jettonMaster.address)).toEqualAddress(fakeJettonWallet.address);
            expect(await factory.getWalletOf(otherMaster.address)).toEqualAddress(otherWallet.address);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: create lock', () => {
        it('9. happy path creates lock', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await sendCreateLock(unlockAt);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: true });
            expect(await factory.getNextLockId()).toEqual(2n);
            expect(await factory.getFeeOf(jettonMaster.address)).toEqual(FEE_JETTON);
            expect(await factory.getTonFees()).toEqual(FEE_TON);
        });

        it('10. unknown sender -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
            const res = await factory.send(attacker.getSender(), { value: ATTACH_TON },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('11. jm mismatch -> rejected', async () => {
            const other = await blockchain.treasury('other');
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, other.address, beneficiary.address, unlockAt);
            const res = await factory.send(fakeJettonWallet.getSender(), { value: ATTACH_TON },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('12. unlock_at in past -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! - 100);
            const res = await sendCreateLock(unlockAt);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('13. unlock_at > 10 years -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 315360001);
            const res = await sendCreateLock(unlockAt);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('14. qid = 0 -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await sendCreateLock(unlockAt, 0n);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('15. insufficient TON -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
            const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('0.5') },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('16. malformed payload -> LockCreationFailed, next_id unchanged', async () => {
            const bad = beginCell().storeBit(0).storeUint(0xbad, 32).endCell();
            const res = await factory.send(fakeJettonWallet.getSender(), { value: ATTACH_TON },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, bad));
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: true });
            expect(await factory.getNextLockId()).toEqual(1n);
            expect(await factory.getTonFees()).toEqual(0n);
        });

        it('17. overpay refunded to creator', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
            const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('3') },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: user.address, success: true });
            expect(await factory.getTonFees()).toEqual(FEE_TON);
        });

        it('18. multiple locks increment next_id', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            for (let i = 0; i < 3; i++) {
                await sendCreateLock(unlockAt, BigInt(i + 1));
            }
            expect(await factory.getNextLockId()).toEqual(4n);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: TakeWalletAddress', () => {
        it('19. qid without HIGH_BIT -> silently ignored', async () => {
            const res = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n, attacker.address, attacker.address));
            expect(res.transactions).toHaveTransaction({ from: jettonMaster.address, to: factory.address, success: true });
        });

        it('20. wrong master -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const childAddr = await factory.getPendingCreateOf(1n);
            const res = await factory.send(attacker.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, attacker.address, childAddr!));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('21. duplicate TakeWalletAddress -> silently dropped, no second transfer (F8)', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const childAddr = await factory.getPendingCreateOf(1n);
            const childJw = await blockchain.treasury('childJw21');

            const res1 = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, childJw.address, childAddr!));
            expect(res1.transactions).toHaveTransaction({
                from: jettonMaster.address, to: factory.address, success: true,
            });
            expect(res1.transactions).toHaveTransaction({
                from: factory.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await factory.getIsForwardConsumed(1n)).toEqual(true);

            const res2 = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, childJw.address, childAddr!));
            expect(res2.transactions).toHaveTransaction({
                from: jettonMaster.address, to: factory.address, success: true,
            });
            expect(res2.transactions).not.toHaveTransaction({
                from: factory.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await factory.getPendingCreateOf(1n)).toEqualAddress(childAddr!);
            expect(await factory.getIsForwardConsumed(1n)).toEqual(true);
        });

        it('22. wrong-owner TWA rejected AND does not consume forward (atomicity)', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const childAddr = await factory.getPendingCreateOf(1n);
            const childJw = await blockchain.treasury('childJw22');
            const wrongOwner = await blockchain.treasury('wrongOwner22');

            const resBad = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, childJw.address, wrongOwner.address));
            expect(resBad.transactions).toHaveTransaction({
                from: jettonMaster.address, to: factory.address, success: false,
            });
            expect(await factory.getIsForwardConsumed(1n)).toEqual(false);

            const resOk = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, childJw.address, childAddr!));
            expect(resOk.transactions).toHaveTransaction({
                from: factory.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await factory.getIsForwardConsumed(1n)).toEqual(true);
        });

        it('23. forward consumed for id=1 does not block id=2 (per-id isolation)', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt, 1n);
            await sendCreateLock(unlockAt, 2n);
            const child1 = await factory.getPendingCreateOf(1n);
            const child2 = await factory.getPendingCreateOf(2n);
            const jw1 = await blockchain.treasury('jw1_23');
            const jw2 = await blockchain.treasury('jw2_23');

            await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, jw1.address, child1!));
            expect(await factory.getIsForwardConsumed(1n)).toEqual(true);
            expect(await factory.getIsForwardConsumed(2n)).toEqual(false);

            const res2 = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(2n | HIGH_BIT, jw2.address, child2!));
            expect(res2.transactions).toHaveTransaction({
                from: factory.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await factory.getIsForwardConsumed(2n)).toEqual(true);
            expect(await factory.getIsForwardConsumed(1n)).toEqual(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: WithdrawFees', () => {
        it('24. withdraw by treasury -> ok', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'WithdrawFees',
                query_id: 100n,
                jetton_master: jettonMaster.address,
                destination_wallet: treasury.address,
                amount: FEE_JETTON,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
            expect(await factory.getFeeOf(jettonMaster.address)).toEqual(0n);
        });

        it('25. withdraw by non-treasury -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(attacker.getSender(), { value: toNano('0.5') }, {
                $$type: 'WithdrawFees',
                query_id: 100n,
                jetton_master: jettonMaster.address,
                destination_wallet: attacker.address,
                amount: FEE_JETTON,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('26. withdraw more than available -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'WithdrawFees',
                query_id: 100n,
                jetton_master: jettonMaster.address,
                destination_wallet: treasury.address,
                amount: FEE_JETTON + 1n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('27. qid reuse -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'WithdrawFees', query_id: 100n,
                jetton_master: jettonMaster.address,
                destination_wallet: treasury.address, amount: FEE_JETTON,
            });
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'WithdrawFees', query_id: 100n,
                jetton_master: jettonMaster.address,
                destination_wallet: treasury.address, amount: 1n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('28. zero amount -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'WithdrawFees', query_id: 100n,
                jetton_master: jettonMaster.address,
                destination_wallet: treasury.address, amount: 0n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: WithdrawTonFees', () => {
        it('29. withdraw by treasury -> ok', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON, destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: treasury.address, success: true });
            expect(await factory.getTonFees()).toEqual(0n);
        });

        it('30. withdraw by non-treasury -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON, destination: attacker.address,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('31. more than available -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON + toNano('1'), destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('32. qid reuse -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON, destination: treasury.address,
            });
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: 1n, destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: Rescue', () => {
        it('33. RescueTon by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'RescueTon', query_id: 300n,
                amount: toNano('1'), destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: treasury.address, success: true });
        });

        it('34. RescueTon by non-treasury -> rejected', async () => {
            const res = await factory.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'RescueTon', query_id: 300n,
                amount: toNano('1'), destination: attacker.address,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('35. RescueJetton by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'RescueJetton', query_id: 301n,
                jetton_master: jettonMaster.address,
                amount: 100n, destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
        });

        it('36. RescueJetton qid reuse -> rejected', async () => {
            await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'RescueJetton', query_id: 301n,
                jetton_master: jettonMaster.address,
                amount: 100n, destination: treasury.address,
            });
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'RescueJetton', query_id: 301n,
                jetton_master: jettonMaster.address,
                amount: 100n, destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: fee management', () => {
        it('37. SetFeeBps by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeBps', query_id: 400n, fee_bps: 100n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
            expect(await factory.getFeeBps()).toEqual(100n);
        });

        it('38. SetFeeBps above 10% -> rejected', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeBps', query_id: 400n, fee_bps: 2000n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('39. SetFeeBps by non-treasury -> rejected', async () => {
            const res = await factory.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeBps', query_id: 400n, fee_bps: 100n,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('40. SetFeeTon by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeTon', query_id: 401n, fee_ton: toNano('2'),
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
            expect(await factory.getFeeTon()).toEqual(toNano('2'));
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: direct', () => {
        let wallet: SandboxContract<LockupWallet>;

        beforeEach(async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    1n,
                    factory.address,
                    jettonMaster.address,
                    beneficiary.address,
                    user.address,
                    LOCK_AMOUNT,
                    unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
        });

        it('41. StartDiscovery only from factory', async () => {
            const res = await wallet.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'StartDiscovery', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('42. TakeWalletAddress only from master', async () => {
            const res = await wallet.send(attacker.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('43. discovery sets jetton_wallet', async () => {
            const res = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            expect(res.transactions).toHaveTransaction({ from: jettonMaster.address, to: wallet.address, success: true });
            expect(await wallet.getJettonWallet()).toEqualAddress(fakeJettonWallet.address);
        });

        it('44. JettonNotification from correct wallet funds', async () => {
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));

            const res = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: wallet.address, success: true });
            expect(await wallet.getIsFunded()).toEqual(true);
        });

        it('45. JettonNotification from wrong wallet -> rejected', async () => {
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));

            const res = await wallet.send(attacker.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('46. Claim before unlock -> rejected', async () => {
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });

            const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 1n, amount: 0n,
            });
            expect(res.transactions).toHaveTransaction({ from: beneficiary.address, to: wallet.address, success: false });
        });

        it('47. Claim by non-beneficiary -> rejected', async () => {
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });

            const res = await wallet.send(attacker.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 1n, amount: 0n,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('48. Claim with qid = 0 -> rejected', async () => {
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });

            const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 0n, amount: 0n,
            });
            expect(res.transactions).toHaveTransaction({ from: beneficiary.address, to: wallet.address, success: false });
        });

        it('49. foreign JettonExcesses -> rejected with not-our-wallet', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    500n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 1n, amount: 0n,
            });

            const foreign = await blockchain.treasury('foreign');
            const res = await wallet.send(foreign.getSender(), { value: toNano('0.05') }, {
                $$type: 'JettonExcesses', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({
                from: foreign.address, to: wallet.address, success: false,
            });
        });

        it('50. availableClaimable = 0 before unlock', async () => {
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            expect(await wallet.getAvailableClaimable()).toEqual(0n);
        });

        it('51. availableClaimable = LOCK_AMOUNT after unlock', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    2n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });

            blockchain.now = Number(unlockAt) + 10;
            expect(await wallet.getAvailableClaimable()).toEqual(LOCK_AMOUNT);
        });

        it('52. getters reflect state', async () => {
            expect(await wallet.getLockId()).toEqual(1n);
            expect(await wallet.getBeneficiaryGet()).toEqualAddress(beneficiary.address);
            expect(await wallet.getClaimedAmount()).toEqual(0n);
            expect(await wallet.getIsFunded()).toEqual(false);
            expect(await wallet.getIsPendingClaim()).toEqual(false);
            expect(await wallet.getPendingSetAt()).toEqual(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: v5.1.0 claim lifecycle', () => {
        it('53. claim after unlock -> flow2 dispatch (claimed=0) -> Excesses confirms + self-destruct', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    99n,
                    factory.address,
                    jettonMaster.address,
                    beneficiary.address,
                    user.address,
                    LOCK_AMOUNT,
                    unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);

            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            expect(await wallet.getJettonWallet()).toEqualAddress(fakeJettonWallet.address);

            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            expect(await wallet.getIsFunded()).toEqual(true);

            blockchain.now = Number(unlockAt) + 10;

            const claimQid = 777n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 0n,
            });
            expect(await wallet.getIsPendingClaim()).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const benJettonWallet = await blockchain.treasury('benJettonWallet');
            const resTake = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJettonWallet.address, beneficiary.address));
            expect(resTake.transactions).toHaveTransaction({
                from: jettonMaster.address, to: wallet.address, success: true,
            });
            expect(resTake.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const resExcess = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') },
                makeExcesses(claimQid));
            expect(resExcess.transactions).toHaveTransaction({
                from: wallet.address, to: beneficiary.address, success: true,
            });

            const contractState = await blockchain.getContract(wallet.address);
            expect(contractState.balance).toBe(0n);
        });

        it('54. second claim while first pending -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    100n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });

            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 1n, amount: 0n,
            });
            expect(await wallet.getIsPendingClaim()).toEqual(true);

            const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 2n, amount: 0n,
            });
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address, to: wallet.address, success: false,
            });
        });

        it('55. wrong amount deposit does NOT mark funded', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    101n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));

            const res = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n,
                amount: LOCK_AMOUNT - 1n,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address, to: wallet.address, success: false,
            });
            expect(await wallet.getIsFunded()).toEqual(false);
        });

        it('56. notify arrives before discovery -> fund_sender -> discovery marks funded', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    102n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);

            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            expect(await wallet.getIsFunded()).toEqual(false);

            const res = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            expect(res.transactions).toHaveTransaction({
                from: jettonMaster.address, to: wallet.address, success: true,
            });
            expect(await wallet.getJettonWallet()).toEqualAddress(fakeJettonWallet.address);
            expect(await wallet.getIsFunded()).toEqual(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: v5.0.1 Excesses from either side', () => {
        it('57. Excesses from beneficiary_wallet settles claim + sweeps + self-destructs', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    501n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);

            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const claimQid = 502n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 0n,
            });

            const benJW = await blockchain.treasury('benJW57');
            const resTake = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW.address, beneficiary.address));
            expect(resTake.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await wallet.getBeneficiaryWallet()).toEqualAddress(benJW.address);
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const res = await wallet.send(benJW.getSender(), { value: toNano('0.05') }, {
                $$type: 'JettonExcesses', query_id: claimQid,
            });
            expect(res.transactions).toHaveTransaction({
                from: benJW.address, to: wallet.address, success: true,
            });
            expect(res.transactions).toHaveTransaction({
                from: wallet.address, to: beneficiary.address, success: true,
            });

            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBe(0n);
        });

        it('58. Excesses from jetton_wallet after claim also settles (sending-side path)', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    502n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const claimQid = 503n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 0n,
            });

            const benJW = await blockchain.treasury('benJW58');
            const resTake = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW.address, beneficiary.address));
            expect(resTake.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const res = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') }, {
                $$type: 'JettonExcesses', query_id: claimQid,
            });
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address, to: wallet.address, success: true,
            });
            expect(res.transactions).toHaveTransaction({
                from: wallet.address, to: beneficiary.address, success: true,
            });

            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBe(0n);
        });

        it('59. foreign Excesses (neither jw nor bw) -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    503n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const claimQid = 504n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 0n,
            });
            const benJW = await blockchain.treasury('benJW59');
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW.address, beneficiary.address));

            const foreign = await blockchain.treasury('foreign59');
            const res = await wallet.send(foreign.getSender(), { value: toNano('0.05') }, {
                $$type: 'JettonExcesses', query_id: claimQid,
            });
            expect(res.transactions).toHaveTransaction({
                from: foreign.address, to: wallet.address, success: false,
            });
            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBeGreaterThan(0n);
        });

        it('60. Excesses before any claim -> success, no sweep (pending_claim = false)', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    504n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });

            const res = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') }, {
                $$type: 'JettonExcesses', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address, to: wallet.address, success: true,
            });
            expect(res.transactions).not.toHaveTransaction({
                from: wallet.address, to: beneficiary.address, success: true,
            });
            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBeGreaterThan(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: v5.0.3 Replay Guard (Finding #4)', () => {
        it('61. Duplicate TakeWalletAddress flow 2 -> silently dropped, no second transfer', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    601n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);

            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const claimQid = 602n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 0n,
            });

            const benJW = await blockchain.treasury('benJW61');

            const res1 = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW.address, beneficiary.address));
            expect(res1.transactions).toHaveTransaction({
                from: jettonMaster.address, to: wallet.address, success: true,
            });
            expect(res1.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await wallet.getIsClaimConsumed(claimQid)).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const res2 = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW.address, beneficiary.address));
            expect(res2.transactions).toHaveTransaction({
                from: jettonMaster.address, to: wallet.address, success: true,
            });
            expect(res2.transactions).not.toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await wallet.getClaimedAmount()).toEqual(0n);
        });

        it('62. Settlement clears consumed_claim -> same qid reusable (no DoS)', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    603n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const claimQid = 604n;
            const HALF = 500n;

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: HALF,
            });
            const benJW = await blockchain.treasury('benJW62');
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW.address, beneficiary.address));
            expect(await wallet.getIsClaimConsumed(claimQid)).toEqual(true);

            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') },
                makeExcesses(claimQid));
            expect(await wallet.getClaimedAmount()).toEqual(HALF);
            expect(await wallet.getIsClaimConsumed(claimQid)).toEqual(false);
            expect(await wallet.getIsPendingClaim()).toEqual(false);

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 1n,
            });
            const benJW2 = await blockchain.treasury('benJW62b');
            const res2 = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJW2.address, beneficiary.address));
            expect(res2.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });
            expect(await wallet.getIsClaimConsumed(claimQid)).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(HALF);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: v5.1.0 Reset (W4 closed)', () => {
        it('63. Reset after timeout recovers a stuck claim (W4 closed)', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    701n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const qid = 702n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: qid, amount: 0n,
            });
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(qid, fakeJettonWallet.address, beneficiary.address));
            expect(await wallet.getIsPendingClaim()).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(0n);
            expect(await wallet.getIsClaimConsumed(qid)).toEqual(true);

            const setAt = await wallet.getPendingSetAt();
            blockchain.now = Number(setAt) + 3601;

            const resReset = await wallet.send(beneficiary.getSender(), { value: toNano('0.3') }, {
                $$type: 'ResetPendingClaim', query_id: 1n,
            });
            expect(resReset.transactions).toHaveTransaction({
                from: beneficiary.address, to: wallet.address, success: true,
            });
            expect(await wallet.getIsPendingClaim()).toEqual(false);
            expect(await wallet.getIsClaimConsumed(qid)).toEqual(false);
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: qid, amount: 0n,
            });
            const resRecoverTake = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(qid, fakeJettonWallet.address, beneficiary.address));
            expect(resRecoverTake.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });

            const resRecoverExcess = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') },
                makeExcesses(qid));
            expect(resRecoverExcess.transactions).toHaveTransaction({
                from: wallet.address, to: beneficiary.address, success: true,
            });

            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBe(0n);
        });

        it('64. Reset before timeout -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    703n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 704n, amount: 0n,
            });

            const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.3') }, {
                $$type: 'ResetPendingClaim', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address, to: wallet.address, success: false,
            });
        });

        it('65. Late Excesses after reset is ignored (no double-book, no destroy)', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    705n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const qid = 706n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: qid, amount: 0n,
            });
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(qid, fakeJettonWallet.address, beneficiary.address));

            const setAt = await wallet.getPendingSetAt();
            blockchain.now = Number(setAt) + 3601;

            await wallet.send(beneficiary.getSender(), { value: toNano('0.3') }, {
                $$type: 'ResetPendingClaim', query_id: 1n,
            });

            const resLate = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') },
                makeExcesses(qid));
            expect(resLate.transactions).toHaveTransaction({
                from: fakeJettonWallet.address, to: wallet.address, success: true,
            });
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBeGreaterThan(0n);
        });

        it('66. Reset by non-beneficiary -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    707n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: 708n, amount: 0n,
            });

            const setAt = await wallet.getPendingSetAt();
            blockchain.now = Number(setAt) + 3601;

            const res = await wallet.send(attacker.getSender(), { value: toNano('0.3') }, {
                $$type: 'ResetPendingClaim', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({
                from: attacker.address, to: wallet.address, success: false,
            });
        });

                        it('67. Reset with no pending claim -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    709n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(beneficiary.getSender(), { value: toNano('0.3') }, {
                $$type: 'ResetPendingClaim', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address, to: wallet.address, success: false,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: v5.1.0 bounce handling', () => {
        it('68. bounce from own JW after dispatch -> clears pending without touching claimed', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    801n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const qid = 802n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: qid, amount: 0n,
            });

            const benJW = await blockchain.treasury('benJW68');
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(qid, benJW.address, beneficiary.address));

            // Pre-state: pending active, dispatch consumed, claimed = 0
            expect(await wallet.getIsPendingClaim()).toEqual(true);
            expect(await wallet.getIsClaimConsumed(qid)).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            // Simulate bounce: send bounced<JettonTransfer> from own JW
            const bouncedBody = beginCell()
              .storeUint(0xFFFFFFFF, 32)               // bounce prefix
              .storeUint(0x0f8a7ea5, 32)               // original opcode
              .storeUint(qid, 64)                      // query_id
              .storeCoins(LOCK_AMOUNT)                 // amount
              .storeAddress(beneficiary.address)       // destination
              .storeAddress(wallet.address)            // response_destination
              .storeBit(0)                             // custom_payload = null
              .storeCoins(0n)                          // forward_ton_amount
              .storeBit(0)                             // forward_payload Either=0
              .endCell();

            await blockchain.sendMessage({
                info: {
                    type: 'internal',
                    ihrDisabled: true,
                    bounce: false,
                    bounced: true,
                    src: fakeJettonWallet.address,
                    dest: wallet.address,
                    value: { coins: toNano('0.05') },
                    ihrFee: 0n,
                    forwardFee: 0n,
                    createdLt: 0n,
                    createdAt: 0,
                },
                body: bouncedBody,
            });

            // Post-state: pending cleared, consumed cleared, claimed unchanged
            expect(await wallet.getIsPendingClaim()).toEqual(false);
            expect(await wallet.getIsClaimConsumed(qid)).toEqual(false);
            expect(await wallet.getClaimedAmount()).toEqual(0n);
            expect(await wallet.getAvailableClaimable()).toEqual(LOCK_AMOUNT);

            // Wallet still alive (did NOT self-destruct)
            const state = await blockchain.getContract(wallet.address);
            expect(state.balance).toBeGreaterThan(0n);
        });

        it('69. bounce from foreign sender -> rejected (pending intact)', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    803n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const qid = 804n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: qid, amount: 0n,
            });
            const benJW = await blockchain.treasury('benJW69');
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(qid, benJW.address, beneficiary.address));

            expect(await wallet.getIsPendingClaim()).toEqual(true);

            // Bounce from a foreign sender (not the JW, not the beneficiary)
            const bouncedBody = beginCell()
                .storeUint(0xFFFFFFFF, 32)
                .storeUint(0x0f8a7ea5, 32)
                .storeUint(qid, 64)
                .endCell();

            const foreign = await blockchain.treasury('foreign69');

            let threw = false;
            try {
                await blockchain.sendMessage({
                    info: {
                        type: 'internal',
                        ihrDisabled: true,
                        bounce: false,
                        bounced: true,
                        src: foreign.address,
                        dest: wallet.address,
                        value: { coins: toNano('0.05') },
                        ihrFee: 0n,
                        forwardFee: 0n,
                        createdLt: 0n,
                        createdAt: 0,
                    },
                    body: bouncedBody,
                });
            } catch (e) {
                threw = true;
            }

            // Either way (throw or success:false), pending must remain intact
                        expect(await wallet.getIsPendingClaim()).toEqual(true);
            expect(await wallet.getIsClaimConsumed(qid)).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(0n);
        });

        it('70. JettonExcesses emits ClaimSettled event (v5.1.1 observability)', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = blockchain.openContract(
                await LockupWallet.fromInit(
                    901n, factory.address, jettonMaster.address,
                    beneficiary.address, user.address, LOCK_AMOUNT, unlockAt,
                ),
            );
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonNotification',
                query_id: 1n, amount: LOCK_AMOUNT, sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            });
            blockchain.now = Number(unlockAt) + 10;

            const qid = 902n;
            await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: qid, amount: 0n,
            });
            const benJW = await blockchain.treasury('benJW70');
            await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(qid, benJW.address, beneficiary.address));

            const resExcess = await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') },
                makeExcesses(qid));

            // Verify ClaimSettled (0x128) was emitted as external-out
            const settledOp = 0x128;
            const hasSettled = resExcess.transactions.some(tx =>
                Array.from(tx.outMessages.values()).some(msg => {
                    if (msg.info.type !== 'external-out' || !msg.body) return false;
                    try { return msg.body.beginParse().loadUint(32) === settledOp; }
                    catch { return false; }
                })
            );
            expect(hasSettled).toBe(true);
        });
    });
});
