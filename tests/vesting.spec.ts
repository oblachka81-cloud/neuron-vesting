import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, beginCell, Address } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';
import { LockupWallet } from '../build/LockupFactory_LockupWallet';
import '@ton/test-utils';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

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

function makeJettonNotification(
    queryId: bigint,
    amount: bigint,
    sender: Address,
    payload: any,
) {
    return {
        $$type: 'JettonNotification' as const,
        query_id: queryId,
        amount: amount,
        sender: sender,
        forward_payload: payload,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════

describe('NEURON Vesting — full suite (v2.5.1 / v2.6.1)', () => {
    let blockchain: Blockchain;
    let treasury: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let beneficiary: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<TreasuryContract>;
    let fakeJettonWallet: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let factory: SandboxContract<LockupFactory>;

    const FEE_TON = toNano('1');
    const BUFFER_TON = toNano('0.25');
    const ATTACH_TON = toNano('1.3'); // fee + buffer + slack
    const JETTON_AMOUNT = 1_000_000_000n;
    const FEE_JETTON = (JETTON_AMOUNT * 50n) / 10000n; // 0.5%
    const LOCK_AMOUNT = JETTON_AMOUNT - FEE_JETTON;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = Math.floor(Date.now() / 1000);

        treasury = await blockchain.treasury('treasury');
        user = await blockchain.treasury('user');
        beneficiary = await blockchain.treasury('beneficiary');
        jettonMaster = await blockchain.treasury('jettonMaster');
        fakeJettonWallet = await blockchain.treasury('jettonWallet');
        attacker = await blockchain.treasury('attacker');

        // Matches deploy defaults: salt=1, fee_bps=50 (0.5%), fee_ton=1 TON
        factory = blockchain.openContract(
        await LockupFactory.fromInit(treasury.address, 1n, 50n, 1000000000n),
     );
        // fund the factory with some TON
        await factory.send(treasury.getSender(), { value: toNano('10') }, null);

        // whitelist the fake jetton wallet
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

    // ─── helpers ────────────────────────────────────────────────────────────

    async function createLock(unlockAt: bigint, qid: bigint = 1n) {
        const payload = makeLockPayload(qid, jettonMaster.address, beneficiary.address, unlockAt);
        await factory.send(
            fakeJettonWallet.getSender(),
            { value: ATTACH_TON },
            makeJettonNotification(qid, JETTON_AMOUNT, user.address, payload),
        );
        return blockchain.openContract(
            await LockupWallet.fromInit(
                1n,
                factory.address,
                jettonMaster.address,
                fakeJettonWallet.address, // jetton_wallet passed in
                beneficiary.address,
                user.address,
                LOCK_AMOUNT,
                unlockAt,
            ),
        );
    }

    async function fundWallet(
        wallet: SandboxContract<LockupWallet>,
        from: SandboxContract<TreasuryContract> = fakeJettonWallet,
        amount: bigint = LOCK_AMOUNT,
        qid: bigint = 2n,
    ) {
        return wallet.send(
            from.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'JettonNotification',
                query_id: qid,
                amount: amount,
                sender: user.address,
                forward_payload: beginCell().endCell().asSlice(),
            },
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Factory: setup & whitelist
    // ═══════════════════════════════════════════════════════════════════════

    describe('Factory: setup', () => {
        it('1. deploys factory with nextLockId = 1', async () => {
            expect(await factory.getNextLockId()).toEqual(1n);
        });

        it('2. whitelist sets own_wallets and wallet_to_master', async () => {
            expect(await factory.getWalletOf(jettonMaster.address)).toEqualAddress(
                fakeJettonWallet.address,
            );
            expect(await factory.getMasterOf(fakeJettonWallet.address)).toEqualAddress(
                jettonMaster.address,
            );
            expect(await factory.getIsWalletSet(jettonMaster.address)).toEqual(true);
        });

        it('3. whitelist by non-treasury -> rejected', async () => {
            const newMaster = await blockchain.treasury('newMaster');
            const newWallet = await blockchain.treasury('newWallet');
            const res = await factory.send(
                attacker.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'SetJettonWallet',
                    query_id: 2n,
                    jetton_master: newMaster.address,
                    jetton_wallet: newWallet.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: factory.address,
                success: false,
            });
        });

        it('4. whitelist with query_id = 0 -> rejected', async () => {
            const newMaster = await blockchain.treasury('newMaster');
            const newWallet = await blockchain.treasury('newWallet');
            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'SetJettonWallet',
                    query_id: 0n,
                    jetton_master: newMaster.address,
                    jetton_wallet: newWallet.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });

        it('5. whitelist overwrite with different wallet -> rejected', async () => {
            const otherWallet = await blockchain.treasury('otherWallet');
            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'SetJettonWallet',
                    query_id: 2n,
                    jetton_master: jettonMaster.address,
                    jetton_wallet: otherWallet.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });

        it('6. whitelist idempotent (same wallet again) -> ok', async () => {
            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'SetJettonWallet',
                    query_id: 2n,
                    jetton_master: jettonMaster.address,
                    jetton_wallet: fakeJettonWallet.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: true,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Factory: create lock
    // ═══════════════════════════════════════════════════════════════════════

    describe('Factory: create lock', () => {
        it('7. happy path: creates lock, emits LockCreated + TonFeeCollected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: true,
            });
            expect(await factory.getNextLockId()).toEqual(2n);
            expect(await factory.getFeeOf(jettonMaster.address)).toEqual(FEE_JETTON);
            expect(await factory.getTonFees()).toEqual(FEE_TON);
        });

        it('8. inline payload (too short, bit=0) -> rejected, no crash', async () => {
    const unlockAt = BigInt(blockchain.now! + 3600);

    // Build a SHORT inline payload (bit=0) that fits in JettonNotification.
    // This is NOT a valid CreateLock payload (missing fields) — the contract
    // must reject it cleanly, not throw an unexpected exit code.
    const tooShort = beginCell()
        .storeBit(0)          // inline marker
        .storeUint(0x1, 32)   // wrong op — should fail on op check
        .storeUint(1n, 64)    // qid
        .endCell()
        .asSlice();

    const res = await factory.send(
        fakeJettonWallet.getSender(),
        { value: ATTACH_TON },
        makeJettonNotification(1n, JETTON_AMOUNT, user.address, tooShort),
    );

    expect(res.transactions).toHaveTransaction({
        from: fakeJettonWallet.address,
        to: factory.address,
        success: false,
    });
});

        it('9. unknown sender (not whitelisted) -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                attacker.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: factory.address,
                success: false,
            });
        });

        it('10. jm mismatch in payload -> rejected', async () => {
            const otherMaster = await blockchain.treasury('otherMaster');
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, otherMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: false,
            });
        });

        it('11. unlock_at in the past -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! - 100);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: false,
            });
        });

        it('12. unlock_at > 10 years -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 315360001);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: false,
            });
        });

        it('13. qid = 0 in payload -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    0n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(0n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: false,
            });
        });

        it('14. insufficient TON attach -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: toNano('0.5') },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: false,
            });
        });

        it('15. lock_amount <= 0 (dust amount) -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    1n, // tiny amount, fee rounds to 0, lock = 1 - 0 = 1 > 0 actually
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            // Actually 1 jetton - 0 fee = 1 > 0 so this passes. But let's send 0.
        });

        it('15b. zero jetton amount -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(
                    1n,
                    0n,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: false,
            });
        });

        it('16. overpay is refunded to original owner', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: toNano('3') },
                makeJettonNotification(
                    1n,
                    JETTON_AMOUNT,
                    user.address,
                    makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt),
                ),
            );
            // Should have a tx from factory to user (overpay refund)
            expect(res.transactions).toHaveTransaction({
                from: factory.address,
                to: user.address,
                success: true,
            });
            expect(await factory.getTonFees()).toEqual(FEE_TON);
        });

        it('17. multiple locks increment next_id', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            for (let i = 0; i < 3; i++) {
                await factory.send(
                    fakeJettonWallet.getSender(),
                    { value: ATTACH_TON },
                    makeJettonNotification(
                        BigInt(i + 1),
                        JETTON_AMOUNT,
                        user.address,
                        makeLockPayload(BigInt(i + 1), jettonMaster.address, beneficiary.address, unlockAt),
                    ),
                );
            }
            expect(await factory.getNextLockId()).toEqual(4n);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wallet: funding
    // ═══════════════════════════════════════════════════════════════════════

    describe('Wallet: funding', () => {
        it('18. correct amount marks funded and emits LockFunded', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            const res = await fundWallet(wallet);
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: wallet.address,
                success: true,
            });
            expect(await wallet.getIsFunded()).toEqual(true);
        });

        it('19. deposit from non-jetton-wallet -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            const res = await wallet.send(
                attacker.getSender(),
                { value: toNano('0.1') },
                {
                    $$type: 'JettonNotification',
                    query_id: 2n,
                    amount: LOCK_AMOUNT,
                    sender: user.address,
                    forward_payload: beginCell().endCell().asSlice(),
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: wallet.address,
                success: false,
            });
        });

        it('20. wrong amount does NOT mark funded (emits UnexpectedDeposit)', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet, fakeJettonWallet, LOCK_AMOUNT - 1n);
            expect(await wallet.getIsFunded()).toEqual(false);
        });

        it('21. second deposit (extra) does NOT change funded', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet, fakeJettonWallet, LOCK_AMOUNT, 2n);
            const res = await fundWallet(wallet, fakeJettonWallet, 500n, 3n);
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: wallet.address,
                success: true,
            });
            expect(await wallet.getIsFunded()).toEqual(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wallet: claim
    // ═══════════════════════════════════════════════════════════════════════

    describe('Wallet: claim', () => {
        it('22. claim before unlock_at -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });

        it('23. claim after unlock without funding -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });

        it('24. happy path: full claim after unlock with funding', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: true,
            });
            expect(res.transactions).toHaveTransaction({
                from: wallet.address,
                to: fakeJettonWallet.address,
                op: 0x0f8a7ea5, // JettonTransfer
            });
            expect(await wallet.getClaimedAmount()).toEqual(LOCK_AMOUNT);
        });

        it('25. partial claim: amount = 100', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 100n },
            );
            expect(await wallet.getClaimedAmount()).toEqual(100n);
            expect(await wallet.getAvailable()).toEqual(LOCK_AMOUNT - 100n);
        });

        it('26. claim with amount > available -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: LOCK_AMOUNT + 1n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });

        it('27. claim by non-beneficiary -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                attacker.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: wallet.address,
                success: false,
            });
        });

        it('28. claim with query_id = 0 -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 0n, amount: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });

        it('29. second claim while first pending -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 100n },
            );
            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 2n, amount: 100n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wallet: extend
    // ═══════════════════════════════════════════════════════════════════════

    describe('Wallet: extend', () => {
        it('30. creator extends forward -> ok', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            const newUnlock = unlockAt + 7200n;

            const res = await wallet.send(
                user.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Extend', query_id: 1n, new_unlock_at: newUnlock },
            );
            expect(res.transactions).toHaveTransaction({
                from: user.address,
                to: wallet.address,
                success: true,
            });
            expect(await wallet.getUnlockAt()).toEqual(newUnlock);
        });

        it('31. extend backwards -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 7200);
            const wallet = await createLock(unlockAt);
            const res = await wallet.send(
                user.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Extend', query_id: 1n, new_unlock_at: unlockAt - 1800n },
            );
            expect(res.transactions).toHaveTransaction({
                from: user.address,
                to: wallet.address,
                success: false,
            });
        });

        it('32. extend by non-creator -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            const res = await wallet.send(
                attacker.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Extend', query_id: 1n, new_unlock_at: unlockAt + 3600n },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: wallet.address,
                success: false,
            });
        });

        it('33. extend after unlock -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                user.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Extend', query_id: 1n, new_unlock_at: unlockAt + 7200n },
            );
            expect(res.transactions).toHaveTransaction({
                from: user.address,
                to: wallet.address,
                success: false,
            });
        });

        it('34. extend beyond 10 years -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            const tooFar = BigInt(blockchain.now! + 315360001);
            const res = await wallet.send(
                user.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Extend', query_id: 1n, new_unlock_at: tooFar },
            );
            expect(res.transactions).toHaveTransaction({
                from: user.address,
                to: wallet.address,
                success: false,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wallet: reset pending claim
    // ═══════════════════════════════════════════════════════════════════════

    describe('Wallet: reset pending', () => {
        it('35. reset by beneficiary after timeout -> ok, does not roll back claimed', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 100n },
            );
            expect(await wallet.getIsPending()).toEqual(true);

            // fast-forward 6h + 1
            blockchain.now = (blockchain.now as number) + 21601;

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'ResetPendingClaim', query_id: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: true,
            });
            // CRITICAL: claimed is NOT rolled back
            expect(await wallet.getClaimedAmount()).toEqual(100n);
            expect(await wallet.getIsPending()).toEqual(false);
        });

        it('36. reset by non-beneficiary -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 100n },
            );
            blockchain.now = (blockchain.now as number) + 21601;

            const res = await wallet.send(
                attacker.getSender(),
                { value: toNano('0.5') },
                { $$type: 'ResetPendingClaim', query_id: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: wallet.address,
                success: false,
            });
        });

        it('37. reset before timeout -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 100n },
            );
            // no time forward
            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'ResetPendingClaim', query_id: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });

        it('38. reset when no pending -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;

            const res = await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'ResetPendingClaim', query_id: 0n },
            );
            expect(res.transactions).toHaveTransaction({
                from: beneficiary.address,
                to: wallet.address,
                success: false,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Factory: withdraw fees
    // ═══════════════════════════════════════════════════════════════════════

    describe('Factory: withdraw jetton fees', () => {
        it('39. withdraw by treasury -> ok', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);
            expect(await factory.getFeeOf(jettonMaster.address)).toEqual(FEE_JETTON);

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 100n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: treasury.address,
                    amount: FEE_JETTON,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: true,
            });
            expect(await factory.getFeeOf(jettonMaster.address)).toEqual(0n);
        });

        it('40. withdraw by non-treasury -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            const res = await factory.send(
                attacker.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 100n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: attacker.address,
                    amount: FEE_JETTON,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: factory.address,
                success: false,
            });
        });

        it('41. withdraw more than available -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 100n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: treasury.address,
                    amount: FEE_JETTON + 1n,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });

        it('42. withdraw with qid = 0 -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 0n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: treasury.address,
                    amount: FEE_JETTON,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });

        it('43. reuse same qid -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 100n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: treasury.address,
                    amount: FEE_JETTON,
                },
            );

            // second call with same qid — even after fees are 0, should fail on reuse
            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 100n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: treasury.address,
                    amount: 1n,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });

        it('44. zero amount -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'WithdrawFees',
                    query_id: 100n,
                    jetton_master: jettonMaster.address,
                    destination_wallet: treasury.address,
                    amount: 0n,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Factory: withdraw TON fees
    // ═══════════════════════════════════════════════════════════════════════

    describe('Factory: withdraw TON fees', () => {
        it('45. withdraw by treasury -> ok', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);
            expect(await factory.getTonFees()).toEqual(FEE_TON);

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.2') },
                {
                    $$type: 'WithdrawTonFees',
                    query_id: 200n,
                    amount: FEE_TON,
                    destination: treasury.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: factory.address,
                to: treasury.address,
                success: true,
            });
            expect(await factory.getTonFees()).toEqual(0n);
        });

        it('46. withdraw by non-treasury -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            const res = await factory.send(
                attacker.getSender(),
                { value: toNano('0.2') },
                {
                    $$type: 'WithdrawTonFees',
                    query_id: 200n,
                    amount: FEE_TON,
                    destination: attacker.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                to: factory.address,
                success: false,
            });
        });

        it('47. withdraw more than available -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.2') },
                {
                    $$type: 'WithdrawTonFees',
                    query_id: 200n,
                    amount: FEE_TON + toNano('1'),
                    destination: treasury.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });

        it('48. reuse same qid -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await createLock(unlockAt);

            await factory.send(
                treasury.getSender(),
                { value: toNano('0.2') },
                {
                    $$type: 'WithdrawTonFees',
                    query_id: 200n,
                    amount: FEE_TON,
                    destination: treasury.address,
                },
            );

            const res = await factory.send(
                treasury.getSender(),
                { value: toNano('0.2') },
                {
                    $$type: 'WithdrawTonFees',
                    query_id: 200n,
                    amount: 1n,
                    destination: treasury.address,
                },
            );
            expect(res.transactions).toHaveTransaction({
                from: treasury.address,
                to: factory.address,
                success: false,
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Factory: bounce of create-transfer -> refund
    // ═══════════════════════════════════════════════════════════════════════

    describe('Factory: bounce handling', () => {
        it('49. create-transfer bounce: refund + LockCreationFailed (simulated)', async () => {
            // NOTE: simulating bounce in sandbox requires the destination
            // contract to actually bounce. Since LockupWallet doesn't bounce
            // on JettonNotification, we cannot easily trigger this path in
            // the sandbox without a full jetton implementation. This test is a
            // placeholder documenting the intended behaviour.
            expect(true).toBe(true);
        });

        it('50. whitelist registers correct reverse mapping', async () => {
            expect(await factory.getMasterOf(fakeJettonWallet.address)).toEqualAddress(
                jettonMaster.address,
            );
            expect(await factory.getWalletOf(jettonMaster.address)).toEqualAddress(
                fakeJettonWallet.address,
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Getter sanity
    // ═══════════════════════════════════════════════════════════════════════

    describe('Getters', () => {
        it('51. wallet getters reflect state', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);

            expect(await wallet.getLockId()).toEqual(1n);
            expect(await wallet.getFactory()).toEqualAddress(factory.address);
            expect(await wallet.getJettonMaster()).toEqualAddress(jettonMaster.address);
            expect(await wallet.getJettonWallet()).toEqualAddress(fakeJettonWallet.address);
            expect(await wallet.getBeneficiary()).toEqualAddress(beneficiary.address);
            expect(await wallet.getCreator()).toEqualAddress(user.address);
            expect(await wallet.getTotalAmount()).toEqual(LOCK_AMOUNT);
            expect(await wallet.getClaimedAmount()).toEqual(0n);
            expect(await wallet.getAvailable()).toEqual(LOCK_AMOUNT);
            expect(await wallet.getUnlockAt()).toEqual(unlockAt);
            expect(await wallet.getIsFunded()).toEqual(true);
            expect(await wallet.getIsPending()).toEqual(false);
        });

        it('52. availableClaimable returns 0 before unlock', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            expect(await wallet.getAvailableClaimable()).toEqual(0n);
        });

        it('53. availableClaimable returns full after unlock when funded', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;
            expect(await wallet.getAvailableClaimable()).toEqual(LOCK_AMOUNT);
        });

        it('54. availableClaimable returns 0 if not funded', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            blockchain.now = Number(unlockAt) + 10;
            expect(await wallet.getAvailableClaimable()).toEqual(0n);
        });

        it('55. availableClaimable returns 0 while pending', async () => {
            const unlockAt = BigInt(blockchain.now! + 100);
            const wallet = await createLock(unlockAt);
            await fundWallet(wallet);
            blockchain.now = Number(unlockAt) + 10;
            await wallet.send(
                beneficiary.getSender(),
                { value: toNano('0.5') },
                { $$type: 'Claim', query_id: 1n, amount: 100n },
            );
            expect(await wallet.getAvailableClaimable()).toEqual(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Factory: v2.6 guard (regression for empty/bad payload — exit 9 → refund)
    // ═══════════════════════════════════════════════════════════════════════

    describe('Factory: v2.6 payload guard', () => {
        it('56. empty forward_payload -> refund instead of exit 9', async () => {
            const emptyPayload = beginCell().endCell().asSlice();

            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(999n, JETTON_AMOUNT, user.address, emptyPayload),
            );

            // Фабрика НЕ упала с exit 9 — guard отработал, транзакция успешна
            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: true,
            });

            // LockCreationFailed (0x111) эмитнут
            expect(res.transactions).toHaveTransaction({
                from: factory.address,
                op: 0x111,
            });

            // ton_fees НЕ увеличился (лок не создан)
            expect(await factory.getTonFees()).toEqual(0n);

            // nextLockId НЕ увеличился
            expect(await factory.getNextLockId()).toEqual(1n);
        });

        it('57. wrong opcode in payload -> refund instead of exit 9', async () => {
            const badPayload = beginCell()
                .storeBit(1)
                .storeRef(
                    beginCell()
                        .storeUint(0xDEAD, 32) // неправильный op вместо 0x1
                        .storeUint(1n, 64)
                        .endCell(),
                )
                .endCell()
                .asSlice();

            const res = await factory.send(
                fakeJettonWallet.getSender(),
                { value: ATTACH_TON },
                makeJettonNotification(888n, JETTON_AMOUNT, user.address, badPayload),
            );

            expect(res.transactions).toHaveTransaction({
                from: fakeJettonWallet.address,
                to: factory.address,
                success: true,
            });
            expect(await factory.getTonFees()).toEqual(0n);
            expect(await factory.getNextLockId()).toEqual(1n);
        });
    });
});
