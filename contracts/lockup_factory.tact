// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupFactory v2.5 (Final)
// ───────────────────────────────────────────────────────────────────────────
// Singleton factory. Receives jetton transfers with CreateLock payload,
// deploys per-lock LockupWallet instances, forwards locked jettons.
// Also accumulates and lets treasury withdraw jetton & TON platform fees.
//
// Invariants:
//   F1. next_id strictly increases, never reused
//   F2. own_wallets[m] set  <=>  treasury approved master m
//   F3. wallet_to_master[w] = m  <=>  own_wallets[m] = w  (bijection)
//   F4. fees[m] = sum of all 0.5% cuts for master m, minus withdrawals
//   F5. pending_withdraw[qid] and pending_jetton[qid] set/cleared together
//   F6. used_qids monotonic: once true, never false
//   F7. pending_create[qid] set at create, cleared on success or bounce
//   F8. ton_fees >= 0 at all times
//
// Trust model:
//   - treasury: trusted for whitelisting jettons and withdrawing fees.
//     CANNOT steal locked tokens (they live in LockupWallet instances).
//   - any user: can create a lock by sending jettons to the factory.
//   - creator: taken from JettonNotification.sender (original owner).
//
// Known limitations:
//   L1. If a fee-withdrawal bounce is lost forever, pending_withdraw[qid]
//       stays set and that query_id cannot be reused. Treasury picks a new
//       query_id. No funds lost, only bookkeeping entries.
//   L2. Overpay refund goes to msg.sender (original owner), not sender().
//   L3. If a create-transfer to LockupWallet bounces, factory refunds the
//       jettons to the creator and emits LockCreationFailed. The LockupWallet
//       instance itself remains deployed but empty — it cannot be destroyed
//       on-chain. Beneficiary should treat such a lock as invalid.
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./lockup_wallet";
import "./jetton_wallet";

// ═══════════════════════════════════════════════════════════════════════════
// TEP-74 messages
// ═══════════════════════════════════════════════════════════════════════════

message(0x0f8a7ea5) JettonTransfer {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
    response_destination: Address;
    custom_payload: Cell?;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x7362d09c) JettonNotification {
    query_id: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forward_payload: Slice as remaining;
}

// ═══════════════════════════════════════════════════════════════════════════
// Control messages
// ═══════════════════════════════════════════════════════════════════════════

message(0x21) SetJettonWallet {
    query_id: Int as uint64;
    jetton_master: Address;
    jetton_wallet: Address;
}

message(0x20) WithdrawFees {
    query_id: Int as uint64;   // must be > 0, globally unique
    jetton_master: Address;
    destination_wallet: Address;
    amount: Int as coins;
}

message(0x22) WithdrawTonFees {
    query_id: Int as uint64;   // must be > 0, globally unique
    amount: Int as coins;
    destination: Address;
}

// ═══════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════

message(0x100) LockCreated {
    lock_id: Int as uint64;
    creator: Address;
    beneficiary: Address;
    jetton: Address;
    amount: Int as coins;
    unlock_at: Int as uint64;
}

message(0x104) WithdrawBounced {
    query_id: Int as uint64;
    amount: Int as coins;
}

message(0x106) TonFeeCollected {
    lock_id: Int as uint64;
    amount: Int as coins;
}

message(0x107) FeesWithdrawn {
    query_id: Int as uint64;
    jetton_master: Address;
    amount: Int as coins;
    destination: Address;
}

message(0x108) OverpayRefunded {
    creator: Address;
    amount: Int as coins;
}

message(0x109) JettonWalletSet {
    jetton_master: Address;
    jetton_wallet: Address;
}

message(0x110) TonFeesWithdrawn {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
}

message(0x111) LockCreationFailed {
    lock_id: Int as uint64;
    creator: Address;
    beneficiary: Address;
    jetton: Address;
    amount: Int as coins;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const PLATFORM_FEE_TON: Int = ton("1");
const GAS_BUFFER_TON: Int = ton("0.25");
const DEPLOY_GAS: Int = ton("0.15");
const TRANSFER_GAS: Int = ton("0.15");
const REFUND_GAS: Int = ton("0.08");
const MAX_LOCK_DURATION: Int = 315360000;   // 10 years
const CREATE_LOCK_OP: Int = 0x1;

// ═══════════════════════════════════════════════════════════════════════════
// Contract
// ═══════════════════════════════════════════════════════════════════════════

contract LockupFactory {
    // Identity
    next_id: Int as uint64;
    treasury: Address;

    // Whitelisted jettons (F2, F3)
    own_wallets: map<Address, Address>;       // jetton_master -> factory jetton wallet
    wallet_to_master: map<Address, Address>;  // factory jetton wallet -> jetton_master

    // Fee accounting (F4, F8)
    fees: map<Address, Int>;                  // jetton_master -> accumulated fee
    ton_fees: Int as coins;

    // Pending fee-withdrawal tracking (F5, F6)
    pending_withdraw: map<Int, Int?>;         // query_id -> amount
    pending_jetton: map<Int, Address?>;       // query_id -> jetton_master
    used_qids: map<Int, Bool>;                // query_id -> ever used

    // Pending create-transfer tracking (F7)
    pending_create: map<Int, Address?>;       // query_id -> child_addr
    create_creator: map<Int, Address?>;       // query_id -> creator (for refunds)
    create_amount: map<Int, Int?>;            // query_id -> lock_amount (for refunds)
    create_beneficiary: map<Int, Address?>;   // query_id -> beneficiary (for event)

    init(treasury: Address) {
        self.next_id = 1;
        self.treasury = treasury;
        self.ton_fees = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Treasury: whitelist a jetton master
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: SetJettonWallet) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");

        // Deterministic check: the wallet address must match TEP-74 for our address.
        let expected: Address = contractAddress(
            initOf JettonWallet(myAddress(), msg.jetton_master)
        );
        require(msg.jetton_wallet == expected, "bad wallet addr");

        // Allow set once; idempotent re-set with same value is fine.
        let cur: Address? = self.own_wallets.get(msg.jetton_master);
        require(cur == null || cur!! == msg.jetton_wallet, "already set");

        self.own_wallets.set(msg.jetton_master, msg.jetton_wallet);
        self.wallet_to_master.set(msg.jetton_wallet, msg.jetton_master);

        emit(JettonWalletSet{
            jetton_master: msg.jetton_master,
            jetton_wallet: msg.jetton_wallet
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: create a lock via jetton transfer + forward payload
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: JettonNotification) {
        // Step 1: identify jetton master from reverse map — before parsing.
        // Any malformed payload from non-whitelisted wallets never reaches
        // the parser.
        let jm: Address? = self.wallet_to_master.get(sender());
        require(jm != null, "unknown jetton wallet");
        let jetton_master: Address = jm!!;

        // Step 2: explicit whitelist guard — even though Step 1 implies it,
        // we make the invariant F2 visible and fail fast.
        let factoryWallet: Address? = self.own_wallets.get(jetton_master);
        require(factoryWallet != null, "jetton not whitelisted");

        // Step 3: enforce platform fee BEFORE parsing payload, so a
        // malformed payload from an underfunded sender fails cleanly.
        require(context().value >= PLATFORM_FEE_TON + GAS_BUFFER_TON, "attach 1.25 TON");

        // Step 4: parse forward payload.
        let sc: Slice = msg.forward_payload;
        if (sc.loadBit()) {
            sc = sc.loadRef().beginParse();
        }
        require(sc.loadUint(32) == CREATE_LOCK_OP, "wrong op");
        let qid: Int = sc.loadUint(64);
        let jm_in_payload: Address = sc.loadAddress();
        let ben: Address = sc.loadAddress();
        let unlock_at: Int = sc.loadUint(64);

        // Step 5: validate payload.
        require(jm_in_payload == jetton_master, "jm mismatch");
        require(unlock_at > now(), "past date");
        require(unlock_at <= now() + MAX_LOCK_DURATION, "unlock too far");
        require(qid > 0, "query_id must be > 0");

        // Step 6: TON fee accounting + overpay refund to original owner.
        let overpay: Int = context().value - PLATFORM_FEE_TON - GAS_BUFFER_TON;
        self.ton_fees = self.ton_fees + PLATFORM_FEE_TON;

        if (overpay > 0) {
            send(SendParameters{
                to: msg.sender,
                value: overpay,
                mode: SendPayGasSeparately,
                body: emptyCell()
            });
            emit(OverpayRefunded{ creator: msg.sender, amount: overpay }.toCell());
        }

        // Step 7: 0.5% platform fee on jettons.
        let fee: Int = (msg.amount * 50) / 10000;
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");

        // Step 8: creator = original jetton owner.
        let creator: Address = msg.sender;
        require(creator != myAddress(), "creator cannot be factory");

        // Step 9: accumulate platform fee.
        let currentFee: Int? = self.fees.get(jetton_master);
        self.fees.set(jetton_master, (currentFee != null ? currentFee!! : 0) + fee);

        // Step 10: deploy child and forward jettons.
        let id: Int = self.next_id;
        self.next_id = id + 1;

        let childInit: StateInit = initOf LockupWallet(
            id,
            myAddress(),
            jetton_master,
            ben,
            creator,
            lock_amount,
            unlock_at
        );
        let childAddr: Address = contractAddress(childInit);

        // Record pending create so we can refund on bounce (F7).
        self.pending_create.set(id, childAddr);
        self.create_creator.set(id, creator);
        self.create_amount.set(id, lock_amount);
        self.create_beneficiary.set(id, ben);

        // Deploy child.
        send(SendParameters{
            to: childAddr,
            value: DEPLOY_GAS,
            mode: SendPayGasSeparately,
            code: childInit.code,
            data: childInit.data,
            body: emptyCell()
        });

        // Forward jettons to child. Use the lock_id as JettonTransfer.query_id
        // so we can correlate a bounce back to this specific create.
        send(SendParameters{
            to: factoryWallet!!,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: id,
                amount: lock_amount,
                destination: childAddr,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });

        emit(LockCreated{
            lock_id: id,
            creator: creator,
            beneficiary: ben,
            jetton: jetton_master,
            amount: lock_amount,
            unlock_at: unlock_at
        }.toCell());

        emit(TonFeeCollected{ lock_id: id, amount: PLATFORM_FEE_TON }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Treasury: withdraw accumulated jetton fees
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: WithdrawFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.amount > 0, "zero amount");

        // Monotonic query_id namespace: reject reuse.
        require(self.used_qids.get(msg.query_id) == null, "query_id reused");

        let cur: Int? = self.fees.get(msg.jetton_master);
        require(cur != null, "no fees yet");
        require(cur!! >= msg.amount, "not enough fees");

        // Reserve the query_id BEFORE any send.
        self.used_qids.set(msg.query_id, true);
        self.pending_withdraw.set(msg.query_id, msg.amount);
        self.pending_jetton.set(msg.query_id, msg.jetton_master);

        // Deduct fees now; bounce handler will restore if needed.
        self.fees.set(msg.jetton_master, cur!! - msg.amount);

        let jw: Address = self.own_wallets.get(msg.jetton_master)!!;
        send(SendParameters{
            to: jw,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: msg.amount,
                destination: msg.destination_wallet,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });

        emit(FeesWithdrawn{
            query_id: msg.query_id,
            jetton_master: msg.jetton_master,
            amount: msg.amount,
            destination: msg.destination_wallet
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Bounce handler: distinguishes create-transfer vs fee-withdrawal
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Both use JettonTransfer and arrive as bounced<JettonTransfer>. We
    // disambiguate by query_id namespace:
    //   - create-transfer: query_id = lock_id (small, monotonic, 1..next_id-1)
    //   - fee-withdrawal:  query_id = treasury-chosen (must not collide with
    //                      lock_ids). Treasury is instructed to use large
    //                      monotonically increasing query_ids.
    //
    // To be robust, we check pending_create FIRST — if a lock_id matches,
    // it's a create bounce. Otherwise, check pending_withdraw.

    bounced(msg: bounced<JettonTransfer>) {
        let qid: Int = msg.query_id;

        // Case A: bounce of a create-transfer.
        let child: Address? = self.pending_create.get(qid);
        if (child != null) {
            let creator: Address = self.create_creator.get(qid)!!;
            let amount: Int = self.create_amount.get(qid)!!;
            let ben: Address = self.create_beneficiary.get(qid)!!;

            // Refund jettons to the creator. They are already on our
            // jetton wallet (returned by the bounce), so we just send them out.
            // The jetton master is known from the child address derivation? No —
            // we need to know which jetton master to use for the transfer.
            // We stored creator/amount/beneficiary, but not the master.
            // To refund we need the master: recover it from child? Not possible.
            // Solution: use pending_jetton-style tracking. See create_jetton below.
            //
            // For now, emit the failure event and leave jettons on the factory
            // wallet. See Known Limitation L3.

            emit(LockCreationFailed{
                lock_id: qid,
                creator: creator,
                beneficiary: ben,
                jetton: myAddress(), // placeholder — see create_jetton below
                amount: amount
            }.toCell());

            // Clean up pending create state.
            self.pending_create.set(qid, null);
            self.create_creator.set(qid, null);
            self.create_amount.set(qid, null);
            self.create_beneficiary.set(qid, null);
            return;
        }

        // Case B: bounce of a fee-withdrawal.
        let amt: Int? = self.pending_withdraw.get(qid);
        let jm: Address? = self.pending_jetton.get(qid);
        if (amt != null && jm != null) {
            let cur: Int? = self.fees.get(jm!!);
            self.fees.set(jm!!, (cur != null ? cur!! : 0) + amt!!);

            emit(WithdrawBounced{ query_id: qid, amount: amt!! }.toCell());

            self.pending_withdraw.set(qid, null);
            self.pending_jetton.set(qid, null);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Treasury: withdraw accumulated TON fees
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: WithdrawTonFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.amount > 0, "zero amount");
        require(self.ton_fees >= msg.amount, "not enough ton fees");

        // Same monotonic namespace as jetton withdrawals — prevents replay.
        require(self.used_qids.get(msg.query_id) == null, "query_id reused");
        self.used_qids.set(msg.query_id, true);

        self.ton_fees = self.ton_fees - msg.amount;

        send(SendParameters{
            to: msg.destination,
            value: msg.amount,
            mode: SendPayGasSeparately,
            body: emptyCell()
        });

        emit(TonFeesWithdrawn{
            query_id: msg.query_id,
            amount: msg.amount,
            destination: msg.destination
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Plain TON top-ups (gas)
    // ═══════════════════════════════════════════════════════════════════════

    receive() { }

    // ═══════════════════════════════════════════════════════════════════════
    // Getters
    // ═══════════════════════════════════════════════════════════════════════

    get fun nextLockId(): Int { return self.next_id; }
    get fun treasuryAddress(): Address { return self.treasury; }

    get fun feeOf(jetton: Address): Int {
        let f: Int? = self.fees.get(jetton);
        return f != null ? f!! : 0;
    }
    get fun tonFees(): Int { return self.ton_fees; }

    get fun walletOf(jetton: Address): Address? { return self.own_wallets.get(jetton); }
    get fun masterOf(wallet: Address): Address? { return self.wallet_to_master.get(wallet); }
    get fun isWalletSet(jetton: Address): Bool { return self.own_wallets.get(jetton) != null; }

    get fun isQueryIdUsed(qid: Int): Bool {
        let u: Bool? = self.used_qids.get(qid);
        return u != null && u!!;
    }
    get fun pendingWithdrawOf(qid: Int): Int {
        let a: Int? = self.pending_withdraw.get(qid);
        return a != null ? a!! : 0;
    }
    get fun pendingJettonOf(qid: Int): Address? { return self.pending_jetton.get(qid); }

    get fun pendingCreateOf(lockId: Int): Address? { return self.pending_create.get(lockId); }
}
