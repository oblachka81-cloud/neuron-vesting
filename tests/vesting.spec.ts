import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, beginCell, Address, Cell } from '@ton/core';
import { LockupFactory } from '../build/LockupFactory_LockupFactory';
import { LockupWallet } from '../build/LockupFactory_LockupWallet';
import '@ton/test-utils';

// ── Helpers ────────────────────────────────────────────────────────────────

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
    // owner_address теперь Cell? (Maybe ^MsgAddress).
    // Собираем Cell с адресом внутри и передаём как Cell — Tact сериализует его как Maybe ref.
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

// ── Suite ──────────────────────────────────────────────────────────────────

describe('NEURON Vesting — v4 (isolated + TEP-89)', () => {
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
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: create lock', () => {
        it('7. happy path creates lock', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await sendCreateLock(unlockAt);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: true });
            expect(await factory.getNextLockId()).toEqual(2n);
            expect(await factory.getFeeOf(jettonMaster.address)).toEqual(FEE_JETTON);
            expect(await factory.getTonFees()).toEqual(FEE_TON);
        });

        it('8. unknown sender -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
            const res = await factory.send(attacker.getSender(), { value: ATTACH_TON },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('9. jm mismatch -> rejected', async () => {
            const other = await blockchain.treasury('other');
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, other.address, beneficiary.address, unlockAt);
            const res = await factory.send(fakeJettonWallet.getSender(), { value: ATTACH_TON },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('10. unlock_at in past -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! - 100);
            const res = await sendCreateLock(unlockAt);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('11. unlock_at > 10 years -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 315360001);
            const res = await sendCreateLock(unlockAt);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('12. qid = 0 -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const res = await sendCreateLock(unlockAt, 0n);
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('13. insufficient TON -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
            const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('0.5') },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: false });
        });

        it('14. malformed payload -> LockCreationFailed, next_id unchanged', async () => {
            const bad = beginCell().storeBit(0).storeUint(0xbad, 32).endCell();
            const res = await factory.send(fakeJettonWallet.getSender(), { value: ATTACH_TON },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, bad));
            expect(res.transactions).toHaveTransaction({ from: fakeJettonWallet.address, to: factory.address, success: true });
            expect(await factory.getNextLockId()).toEqual(1n);
            expect(await factory.getTonFees()).toEqual(0n);
        });

        it('15. overpay refunded to creator', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            const payload = makeLockPayload(1n, jettonMaster.address, beneficiary.address, unlockAt);
            const res = await factory.send(fakeJettonWallet.getSender(), { value: toNano('3') },
                makeJettonNotify(1n, JETTON_AMOUNT, user.address, payload));
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: user.address, success: true });
            expect(await factory.getTonFees()).toEqual(FEE_TON);
        });

        it('16. multiple locks increment next_id', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            for (let i = 0; i < 3; i++) {
                await sendCreateLock(unlockAt, BigInt(i + 1));
            }
            expect(await factory.getNextLockId()).toEqual(4n);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: TakeWalletAddress', () => {
        it('17. qid without HIGH_BIT -> silently ignored', async () => {
            const res = await factory.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n, attacker.address, attacker.address));
            expect(res.transactions).toHaveTransaction({ from: jettonMaster.address, to: factory.address, success: true });
        });

        it('18. wrong master -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const childAddr = await factory.getPendingCreateOf(1n);
            const res = await factory.send(attacker.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(1n | HIGH_BIT, attacker.address, childAddr!));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    describe('Factory: WithdrawFees', () => {
        it('19. withdraw by treasury -> ok', async () => {
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

        it('20. withdraw by non-treasury -> rejected', async () => {
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

        it('21. withdraw more than available -> rejected', async () => {
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

        it('22. qid reuse -> rejected', async () => {
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

        it('23. zero amount -> rejected', async () => {
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
        it('24. withdraw by treasury -> ok', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON, destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: treasury.address, success: true });
            expect(await factory.getTonFees()).toEqual(0n);
        });

        it('25. withdraw by non-treasury -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON, destination: attacker.address,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('26. more than available -> rejected', async () => {
            const unlockAt = BigInt(blockchain.now! + 3600);
            await sendCreateLock(unlockAt);
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'WithdrawTonFees', query_id: 200n,
                amount: FEE_TON + toNano('1'), destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('27. qid reuse -> rejected', async () => {
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
        it('28. RescueTon by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'RescueTon', query_id: 300n,
                amount: toNano('1'), destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: treasury.address, success: true });
        });

        it('29. RescueTon by non-treasury -> rejected', async () => {
            const res = await factory.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'RescueTon', query_id: 300n,
                amount: toNano('1'), destination: attacker.address,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('30. RescueJetton by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.5') }, {
                $$type: 'RescueJetton', query_id: 301n,
                jetton_master: jettonMaster.address,
                amount: 100n, destination: treasury.address,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
        });

        it('31. RescueJetton qid reuse -> rejected', async () => {
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
        it('32. SetFeeBps by treasury -> ok', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeBps', query_id: 400n, fee_bps: 100n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: true });
            expect(await factory.getFeeBps()).toEqual(100n);
        });

        it('33. SetFeeBps above 10% -> rejected', async () => {
            const res = await factory.send(treasury.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeBps', query_id: 400n, fee_bps: 2000n,
            });
            expect(res.transactions).toHaveTransaction({ from: treasury.address, to: factory.address, success: false });
        });

        it('34. SetFeeBps by non-treasury -> rejected', async () => {
            const res = await factory.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'SetFeeBps', query_id: 400n, fee_bps: 100n,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: factory.address, success: false });
        });

        it('35. SetFeeTon by treasury -> ok', async () => {
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
            // Fund wallet's gas
            await wallet.send(treasury.getSender(), { value: toNano('2') }, null);
        });

        it('36. StartDiscovery only from factory', async () => {
            const res = await wallet.send(attacker.getSender(), { value: toNano('0.2') }, {
                $$type: 'StartDiscovery', query_id: 1n,
            });
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('37. TakeWalletAddress only from master', async () => {
            const res = await wallet.send(attacker.getSender(), { value: toNano('0.1') }, 
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('38. discovery sets jetton_wallet', async () => {
            const res = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(0n, fakeJettonWallet.address, wallet.address));
            expect(res.transactions).toHaveTransaction({ from: jettonMaster.address, to: wallet.address, success: true });
            expect(await wallet.getJettonWallet()).toEqualAddress(fakeJettonWallet.address);
        });

        it('39. JettonNotification from correct wallet funds', async () => {
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

        it('40. JettonNotification from wrong wallet -> rejected', async () => {
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

        it('41. Claim before unlock -> rejected', async () => {
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

        it('42. Claim by non-beneficiary -> rejected', async () => {
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

        it('43. Claim with qid = 0 -> rejected', async () => {
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

        it('44. JettonExcesses with wrong sender -> rejected', async () => {
            const res = await wallet.send(attacker.getSender(), { value: toNano('0.1') }, makeExcesses(0n));
            expect(res.transactions).toHaveTransaction({ from: attacker.address, to: wallet.address, success: false });
        });

        it('45. availableClaimable = 0 before unlock', async () => {
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

        it('46. availableClaimable = LOCK_AMOUNT after unlock', async () => {
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

        it('47. getters reflect state', async () => {
            expect(await wallet.getLockId()).toEqual(1n);
            expect(await wallet.getBeneficiaryGet()).toEqualAddress(beneficiary.address);
            expect(await wallet.getClaimedAmount()).toEqual(0n);
            expect(await wallet.getIsFunded()).toEqual(false);
            expect(await wallet.getIsPendingClaim()).toEqual(false);
        });
    });

        // ═══════════════════════════════════════════════════════════════════════
    describe('LockupWallet: happy-path claim + Excesses', () => {
        it('48. claim after unlock → TakeWalletAddress → Excesses clears pending', async () => {
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
            const resClaim = await wallet.send(beneficiary.getSender(), { value: toNano('0.5') }, {
                $$type: 'Claim', query_id: claimQid, amount: 0n,
            });
            expect(resClaim.transactions).toHaveTransaction({
                from: beneficiary.address, to: wallet.address, success: true,
            });
            expect(await wallet.getIsPendingClaim()).toEqual(true);
            expect(await wallet.getClaimedAmount()).toEqual(0n);

            const benJettonWallet = await blockchain.treasury('benJettonWallet');
            const resTake = await wallet.send(jettonMaster.getSender(), { value: toNano('0.1') },
                makeTakeWalletAddress(claimQid, benJettonWallet.address, beneficiary.address));
            expect(resTake.transactions).toHaveTransaction({
                from: jettonMaster.address, to: wallet.address, success: true,
            });
            expect(await wallet.getClaimedAmount()).toEqual(LOCK_AMOUNT);
            expect(resTake.transactions).toHaveTransaction({
                from: wallet.address, to: fakeJettonWallet.address, op: 0x0f8a7ea5,
            });

            await wallet.send(fakeJettonWallet.getSender(), { value: toNano('0.05') },
                makeExcesses(claimQid));
            expect(await wallet.getIsPendingClaim()).toEqual(false);
            expect(await wallet.getAvailableClaimable()).toEqual(0n);
        });

        it('49. second claim while first pending → rejected', async () => {
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

        it('50. wrong amount deposit does NOT mark funded', async () => {
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

        it('51. notify arrives before discovery → fund_sender → discovery marks funded', async () => {
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
});
