// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupFactory v2.5.1 (Final)
// ───────────────────────────────────────────────────────────────────────────
// Singleton factory. Receives jetton transfers with CreateLock payload,
// deploys per-lock LockupWallet instances, forwards locked jettons.
// Also accumulates and lets treasury withdraw jetton & TON platform fees.
//
// Treasury-provided jetton wallet addresses (no deterministic computation).
// See docs/SPEC.md for trust model and known limitations.
//
// Invariants:
//   F1.  next_id strictly increases, never reused
//   F2.  own_wallets[m] set  <=>  treasury approved master m
//   F3.  wallet_to_master[w] = m  <=>  own_wallets[m] = w  (bijection)
//   F4.  fees[m] = sum of all 0.5% cuts for master m, minus withdrawals
//   F5.  pending_withdraw[qid] and pending_jetton[qid] set/cleared together
//   F6.  used_qids monotonic: once true, never false
//   F7.  pending_create[qid] set at create, cleared on success or bounce
//   F8.  create_jetton[qid] tracks master for refund on create bounce
//   F9.  ton_fees >= 0 at all times
//
// Trust model:
//   - treasury: trusted for whitelisting jettons and withdrawing fees.
//     CANNOT steal locked tokens (they live in LockupWallet instances).
//     A compromised treasury can DoS new lock creation by registering bad
//     addresses — mitigated by off-chain verifier in CI and multi-sig.
//   - any user: can create a lock by sending jettons to the factory.
//   - creator:  taken from JettonNotification.sender (original owner).
//
// Known limitations:
//   L1. Lost fee-withdrawal bounce leaves pending_withdraw[qid] set forever.
//       No funds lost; treasury simply uses a new query_id.
//   L2. Overpay refund goes to msg.sender (original owner), not sender().
//   L3. If a create-transfer to LockupWallet bounces, factory refunds the
//       jettons to the creator and emits LockCreationFailed. The LockupWallet
//       instance itself remains deployed but empty — it cannot be destroyed
//       on-chain. Frontends should filter locks whose lock_id appears in a
//       LockCreationFailed event.
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./lockup_wallet";

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
    query_id: Int as uint64;
    jetton_master: Address;
    destination_wallet: Address;
    amount: Int as coins;
}

message(0x22) WithdrawTonFees {
    query_id: Int as uint64;
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

message(0x112) CreateBounced {
    lock_id: Int as uint64;
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

    // Fee accounting (F4, F9)
    fees: map<Address, Int>;                  // jetton_master -> accumulated fee
    ton_fees: Int as coins;

    // Pending fee-withdrawal tracking (F5, F6)
    pending_withdraw: map<Int, Int>;          // query_id -> amount
    pending_jetton: map<Int, Address>;        // query_id -> jetton_master
    used_qids: map<Int, Bool>;                // query_id -> ever used

    // Pending create-transfer tracking (F7, F8)
    pending_create: map<Int, Address>;        // lock_id -> child_addr
    create_creator: map<Int, Address>;        // lock_id -> creator
    create_amount: map<Int, Int>;             // lock_id -> lock_amount
    create_beneficiary: map<Int, Address>;    // lock_id -> beneficiary
    create_jetton: map<Int, Address>;         // lock_id -> jetton_master

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

        // Idempotent: allow setting once, or re-setting to the same value.
        let cur: Address? = self.own_wallets.get(msg.jetton_master);
        require(cur == null || cur!! == msg.jetton_wallet, "already set to different wallet");

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
        let jm: Address? = self.wallet_to_master.get(sender());
        require(jm != null, "unknown jetton wallet");
        let jetton_master: Address = jm!!;

        // Step 2: explicit whitelist guard (F2).
        let factoryWallet: Address? = self.own_wallets.get(jetton_master);
        require(factoryWallet != null, "jetton not whitelisted");

        // Step 3: enforce platform fee BEFORE parsing payload.
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

        // Step 6: TON fee accounting + overpay refund to original owner (L2).
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

        // Step 9: accumulate platform fee (F4).
        let currentFee: Int? = self.fees.get(jetton_master);
        self.fees.set(jetton_master, (currentFee != null ? currentFee!! : 0) + fee);

        // Step 10: deploy child and forward jettons.
        let id: Int = self.next_id;
        self.next_id = id + 1;

        let childInit: StateInit = initOf LockupWallet(
            id,
            myAddress(),
            jetton_master,
            factoryWallet!!,
            ben,
            creator,
            lock_amount,
            unlock_at
        );
        let childAddr: Address = contractAddress(childInit);

        // Record pending create for bounce handling (F7, F8).
        self.pending_create.set(id, childAddr);
        self.create_creator.set(id, creator);
        self.create_amount.set(id, lock_amount);
        self.create_beneficiary.set(id, ben);
        self.create_jetton.set(id, jetton_master);

        // Deploy child.
        send(SendParameters{
            to: childAddr,
            value: DEPLOY_GAS,
            mode: SendPayGasSeparately,
            code: childInit.code,
            data: childInit.data,
            body: emptyCell()
        });

        // Forward jettons to child. lock_id as query_id correlates a bounce.
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

        // Monotonic query_id namespace (F6).
        require(self.used_qids.get(msg.query_id) == null, "query_id reused");

        let cur: Int? = self.fees.get(msg.jetton_master);
        require(cur != null, "no fees yet");
        require(cur!! >= msg.amount, "not enough fees");

        // Reserve qid BEFORE any send (F5).
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

    bounced(msg: bounced<JettonTransfer>) {
        let qid: Int = msg.query_id;

        // Case A: bounce of a create-transfer.
        let child: Address? = self.pending_create.get(qid);
        if (child != null) {
            let jm: Address? = self.create_jetton.get(qid);

            // Verify bounce came from the expected jetton wallet.
            if (jm != null) {
                let jw: Address = self.own_wallets.get(jm!!)!!;
                require(sender() == jw, "create bounce from wrong wallet");
            }

            let creator: Address = self.create_creator.get(qid)!!;
            let amount: Int = self.create_amount.get(qid)!!;
            let ben: Address = self.create_beneficiary.get(qid)!!;

            // Refund jettons to creator. They are already on our wallet
            // (returned by the bounce), so we just send them out.
            if (jm != null) {
                let jw: Address = self.own_wallets.get(jm!!)!!;
                send(SendParameters{
                    to: jw,
                    value: REFUND_GAS,
                    mode: SendPayGasSeparately,
                    body: JettonTransfer{
                        query_id: qid,
                        amount: amount,
                        destination: creator,
                        response_destination: myAddress(),
                        custom_payload: null,
                        forward_ton_amount: 0,
                        forward_payload: emptySlice()
                    }.toCell()
                });
            }

            emit(CreateBounced{
                lock_id: qid,
                amount: amount
            }.toCell());

            emit(LockCreationFailed{
                lock_id: qid,
                creator: creator,
                beneficiary: ben,
                jetton: jm != null ? jm!! : myAddress(),
                amount: amount
            }.toCell());

            // Cleanup.
            self.pending_create.set(qid, null);
            self.create_creator.set(qid, null);
            self.create_amount.set(qid, null);
            self.create_beneficiary.set(qid, null);
            self.create_jetton.set(qid, null);
            return;
        }

        // Case B: bounce of a fee-withdrawal.
        let amt: Int? = self.pending_withdraw.get(qid);
        let jm2: Address? = self.pending_jetton.get(qid);
        if (amt != null && jm2 != null) {
            let jw: Address = self.own_wallets.get(jm2!!)!!;
            require(sender() == jw, "withdraw bounce from wrong wallet");

            let cur: Int? = self.fees.get(jm2!!);
            self.fees.set(jm2!!, (cur != null ? cur!! : 0) + amt!!);

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
    get fun createJettonOf(lockId: Int): Address? { return self.create_jetton.get(lockId); }
}
