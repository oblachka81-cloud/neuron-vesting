// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupFactory v2.6.0 (Final)
// ═══════════════════════════════════════════════════════════════════════════
//
// Treasury-controlled mutable platform fees (fee_bps, fee_ton).
// Correct parsing of TEP-74 forward_payload (Either handled by Tact).
// Bounce-safe refunds for both TON-fee and jetton-fee.
// Monotonic query_id registry with separate space for create-transfers.
//
// Invariants:
//   F1.  next_id strictly increases, never reused
//   F2.  own_wallets[m] set  <=>  treasury approved master m
//   F3.  wallet_to_master[w] = m  <=>  own_wallets[m] = w  (bijection)
//   F4.  fees[m] = sum of cuts for master m minus withdrawals (modulo rollbacks)
//   F5.  pending_withdraw[qid] and pending_jetton[qid] set/cleared together
//   F6.  used_qids monotonic for treasury-initiated ops
//   F7.  pending_create[id] and create_*[id] set together, cleared on bounce
//   F8.  ton_fees tracks platform TON income
//
// Query_id spaces:
//   create-transfers: id | (1 << 63)   (high bit set)
//   treasury ops:     msg.query_id     (high bit MUST be clear)
//
// Known behaviour:
//   LB1. LockCreated is emitted before the jetton transfer confirms.
//        If it bounces, CreateBounced + LockCreationFailed follow.
//        Frontends MUST treat a lock as canonical only after N blocks
//        without LockCreationFailed for the same id.
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./messages";
import "./lockup_wallet";

// ─── Control messages ──────────────────────────────────────────────────────

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

message(0x23) RescueTon {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
}

message(0x24) RescueJetton {
    query_id: Int as uint64;
    jetton_master: Address;
    amount: Int as coins;
    destination: Address;
}

message(0x25) SetFeeBps {
    query_id: Int as uint64;
    fee_bps: Int as uint16;
}

message(0x26) SetFeeTon {
    query_id: Int as uint64;
    fee_ton: Int as coins;
}

// ─── Events ─────────────────────────────────────────────────────────────────

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

message(0x113) FeeBpsChanged {
    old_fee_bps: Int as uint16;
    new_fee_bps: Int as uint16;
}

message(0x114) FeeTonChanged {
    old_fee_ton: Int as coins;
    new_fee_ton: Int as coins;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const GAS_BUFFER_TON: Int = ton("0.25");
const DEPLOY_GAS: Int = ton("0.15");
const TRANSFER_GAS: Int = ton("0.15");
const REFUND_GAS: Int = ton("0.08");
const RESCUE_GAS: Int = ton("0.1");
const MAX_LOCK_DURATION: Int = 315360000;   // 10 years
const CREATE_LOCK_OP: Int = 0x1;
const CREATE_QID_HIGH_BIT: Int = 1 << 63;
const MAX_FEE_BPS: Int = 1000;               // 10%

// ─── Contract ───────────────────────────────────────────────────────────────

contract LockupFactory {
    next_id: Int as uint64;
    treasury: Address;
    salt: Int as uint64;

    // mutable platform fees
    fee_bps: Int as uint16;
    fee_ton: Int as coins;

    own_wallets: map<Address, Address>;
    wallet_to_master: map<Address, Address>;

    fees: map<Address, Int>;
    ton_fees: Int as coins;

    pending_withdraw: map<Int, Int>;
    pending_jetton: map<Int, Address>;
    used_qids: map<Int, Bool>;

    pending_create: map<Int, Address>;
    create_creator: map<Int, Address>;
    create_amount: map<Int, Int>;
    create_beneficiary: map<Int, Address>;
    create_jetton: map<Int, Address>;
    create_fee_ton: map<Int, Int>;
    create_fee_jetton: map<Int, Int>;

    init(treasury: Address, salt: Int, fee_bps: Int, fee_ton: Int) {
        self.next_id = 1;
        self.treasury = treasury;
        self.salt = salt;
        self.fee_bps = fee_bps;
        self.fee_ton = fee_ton;
        self.ton_fees = 0;
    }

    // ── Treasury: whitelist jetton master ──────────────────────────────

    receive(msg: SetJettonWallet) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");

        let cur: Address? = self.own_wallets.get(msg.jetton_master);
        require(cur == null || cur!! == msg.jetton_wallet, "already set");

        self.own_wallets.set(msg.jetton_master, msg.jetton_wallet);
        self.wallet_to_master.set(msg.jetton_wallet, msg.jetton_master);

        emit(JettonWalletSet{
            jetton_master: msg.jetton_master,
            jetton_wallet: msg.jetton_wallet
        }.toCell());
    }

    // ── Treasury: mutable fees ─────────────────────────────────────────

    receive(msg: SetFeeBps) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.fee_bps <= MAX_FEE_BPS, "max 10%");
        let old: Int = self.fee_bps;
        self.fee_bps = msg.fee_bps;
        emit(FeeBpsChanged{ old_fee_bps: old, new_fee_bps: msg.fee_bps }.toCell());
    }

    receive(msg: SetFeeTon) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.fee_ton >= 0, "negative fee");
        let old: Int = self.fee_ton;
        self.fee_ton = msg.fee_ton;
        emit(FeeTonChanged{ old_fee_ton: old, new_fee_ton: msg.fee_ton }.toCell());
    }

    // ── User: create lock via jetton transfer + forward payload ────────

    receive(msg: JettonNotification) {
        let jm: Address? = self.wallet_to_master.get(sender());
        require(jm != null, "unknown jetton wallet");
        let jetton_master: Address = jm!!;

        let factoryWallet: Address? = self.own_wallets.get(jetton_master);
        require(factoryWallet != null, "jetton not whitelisted");

        require(context().value >= self.fee_ton + GAS_BUFFER_TON, "attach fee + buffer");

        // Tact does NOT strip Either for `Slice as remaining`.
        // Slice carries marker bit + ref. Unwrap manually.
        let sc: Slice = msg.forward_payload;
        let parsed: Bool = false;
        if (!sc.empty()) {
            if (sc.loadBit()) {
                sc = sc.loadRef().beginParse();
            }
            // Full CreateLock body = 32+64+267+267+64 = 694 bits
            if (sc.bits() >= 694 && sc.preloadUint(32) == CREATE_LOCK_OP) {
                parsed = true;
            }
        }
        if (!parsed) {
            // Bad/empty/truncated payload -> refund jettons + TON, never exit 9
            send(SendParameters{
                to: factoryWallet!!,
                value: TRANSFER_GAS,
                mode: SendPayGasSeparately,
                body: JettonTransfer{
                    query_id: 0,
                    amount: msg.amount,
                    destination: msg.sender,
                    response_destination: msg.sender,
                    custom_payload: null,
                    forward_ton_amount: 0,
                    forward_payload: emptySlice()
                }.toCell()
            });
            let back: Int = context().value - TRANSFER_GAS;
            if (back > 0) {
                send(SendParameters{
                    to: msg.sender,
                    value: back,
                    mode: SendPayGasSeparately,
                    body: emptyCell()
                });
            }
            emit(LockCreationFailed{
                lock_id: 0,
                creator: msg.sender,
                beneficiary: msg.sender,
                jetton: jetton_master,
                amount: msg.amount
            }.toCell());
            return;
        }
        sc.skipBits(32); // consume CREATE_LOCK_OP (already verified by preload)
        let qid: Int = sc.loadUint(64);
        let jm_in_payload: Address = sc.loadAddress();
        let ben: Address = sc.loadAddress();
        let unlock_at: Int = sc.loadUint(64);

        require(jm_in_payload == jetton_master, "jm mismatch");
        require(unlock_at > now(), "past date");
        require(unlock_at <= now() + MAX_LOCK_DURATION, "unlock too far");
        require(qid > 0, "query_id must be > 0");

        let overpay: Int = context().value - self.fee_ton - GAS_BUFFER_TON;
        self.ton_fees = self.ton_fees + self.fee_ton;

        if (overpay > 0) {
            send(SendParameters{
                to: msg.sender,
                value: overpay,
                mode: SendPayGasSeparately,
                body: emptyCell()
            });
            emit(OverpayRefunded{ creator: msg.sender, amount: overpay }.toCell());
        }

        let fee: Int = (msg.amount * self.fee_bps) / 10000;
        require(fee >= 0, "fee < 0");
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");

        let creator: Address = msg.sender;
        require(creator != myAddress(), "creator cannot be factory");

        let currentFee: Int? = self.fees.get(jetton_master);
        self.fees.set(jetton_master, (currentFee != null ? currentFee!! : 0) + fee);

        let id: Int = self.next_id;
        self.next_id = id + 1;

        self.create_fee_ton.set(id, self.fee_ton);
        self.create_fee_jetton.set(id, fee);

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

        self.pending_create.set(id, childAddr);
        self.create_creator.set(id, creator);
        self.create_amount.set(id, lock_amount);
        self.create_beneficiary.set(id, ben);
        self.create_jetton.set(id, jetton_master);

        send(SendParameters{
            to: childAddr,
            value: DEPLOY_GAS,
            mode: SendPayGasSeparately,
            code: childInit.code,
            data: childInit.data,
            body: emptyCell()
        });

        send(SendParameters{
            to: factoryWallet!!,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: id | CREATE_QID_HIGH_BIT,
                amount: lock_amount,
                destination: childAddr,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });

        // NOTE: LockCreated = attempt, not confirmation. See LB1.
        emit(LockCreated{
            lock_id: id,
            creator: creator,
            beneficiary: ben,
            jetton: jetton_master,
            amount: lock_amount,
            unlock_at: unlock_at
        }.toCell());

        emit(TonFeeCollected{ lock_id: id, amount: self.fee_ton }.toCell());
    }

    // ── Treasury: withdraw jetton fees ─────────────────────────────────

    receive(msg: WithdrawFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.query_id < CREATE_QID_HIGH_BIT, "qid reserved space");
        require(msg.amount > 0, "zero amount");
        require(self.used_qids.get(msg.query_id) == null, "query_id reused");

        let cur: Int? = self.fees.get(msg.jetton_master);
        require(cur != null, "no fees yet");
        require(cur!! >= msg.amount, "not enough fees");

        self.used_qids.set(msg.query_id, true);
        self.pending_withdraw.set(msg.query_id, msg.amount);
        self.pending_jetton.set(msg.query_id, msg.jetton_master);
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

    // ── Bounce handler ─────────────────────────────────────────────────

    bounced(msg: bounced<JettonTransfer>) {
        let qid: Int = msg.query_id;
        let isCreate: Bool = (qid & CREATE_QID_HIGH_BIT) != 0;

        if (isCreate) {
            let lock_id: Int = qid & (CREATE_QID_HIGH_BIT - 1);
            let child: Address? = self.pending_create.get(lock_id);
            if (child != null) {
                let jm: Address? = self.create_jetton.get(lock_id);

                if (jm != null) {
                    let jw: Address = self.own_wallets.get(jm!!)!!;
                    require(sender() == jw, "create bounce from wrong wallet");
                }

                let creator: Address = self.create_creator.get(lock_id)!!;
                let amount: Int = self.create_amount.get(lock_id)!!;
                let ben: Address = self.create_beneficiary.get(lock_id)!!;
                let charged_ton: Int = self.create_fee_ton.get(lock_id)!!;
                let charged_jetton: Int = self.create_fee_jetton.get(lock_id)!!;

                if (jm != null) {
    let jw: Address = self.own_wallets.get(jm!!)!!;
    let total_refund: Int = amount + charged_jetton;
    send(SendParameters{
        to: jw,
        value: REFUND_GAS,
        mode: SendPayGasSeparately,
        body: JettonTransfer{
            query_id: lock_id,
            amount: total_refund,
            destination: creator,
            response_destination: myAddress(),
            custom_payload: null,
            forward_ton_amount: 0,
            forward_payload: emptySlice()
        }.toCell()
    });

    // Roll back charged jetton fee without underflow.
    // fees[jm] should never be < charged_jetton; if it is,
    // saturate at 0 instead of throwing — a bounce handler
    // must not revert, or the refund would be stuck forever.
    let curJettonFeeOpt: Int? = self.fees.get(jm!!);
    let curJettonFee: Int = curJettonFeeOpt != null ? curJettonFeeOpt!! : 0;
    let newJettonFee: Int = curJettonFee > charged_jetton
        ? curJettonFee - charged_jetton
        : 0;
    self.fees.set(jm!!, newJettonFee);
}

                if (self.ton_fees >= charged_ton) {
                    self.ton_fees = self.ton_fees - charged_ton;
                    send(SendParameters{
                        to: creator,
                        value: charged_ton,
                        mode: SendPayGasSeparately,
                        body: emptyCell()
                    });
                }

                emit(CreateBounced{ lock_id: lock_id, amount: amount }.toCell());

                emit(LockCreationFailed{
                    lock_id: lock_id,
                    creator: creator,
                    beneficiary: ben,
                    jetton: jm != null ? jm!! : myAddress(),
                    amount: amount
                }.toCell());

                self.pending_create.set(lock_id, null);
                self.create_creator.set(lock_id, null);
                self.create_amount.set(lock_id, null);
                self.create_beneficiary.set(lock_id, null);
                self.create_jetton.set(lock_id, null);
                self.create_fee_ton.set(lock_id, null);
                self.create_fee_jetton.set(lock_id, null);
            }
            return;
        }

        // Case B: fee-withdrawal bounce
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

    // ── Treasury: withdraw TON fees ────────────────────────────────────

    receive(msg: WithdrawTonFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.query_id < CREATE_QID_HIGH_BIT, "qid reserved space");
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

    // ── Treasury: rescue TON ───────────────────────────────────────────

    receive(msg: RescueTon) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.query_id < CREATE_QID_HIGH_BIT, "qid reserved space");
        require(msg.amount > 0, "zero amount");
        require(self.used_qids.get(msg.query_id) == null, "query_id reused");

        let reserve: Int = ton("0.05");
        require(myBalance() >= msg.amount + reserve, "not enough ton");

        self.used_qids.set(msg.query_id, true);

        send(SendParameters{
            to: msg.destination,
            value: msg.amount,
            mode: SendPayGasSeparately,
            body: emptyCell()
        });
    }

    // ── Treasury: rescue stuck jettons ─────────────────────────────────

    receive(msg: RescueJetton) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "query_id must be > 0");
        require(msg.query_id < CREATE_QID_HIGH_BIT, "qid reserved space");
        require(msg.amount > 0, "zero amount");
        require(self.used_qids.get(msg.query_id) == null, "query_id reused");

        let jw: Address? = self.own_wallets.get(msg.jetton_master);
        require(jw != null, "jetton not whitelisted");

        self.used_qids.set(msg.query_id, true);

        send(SendParameters{
            to: jw!!,
            value: RESCUE_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: msg.amount,
                destination: msg.destination,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });
    }

    receive() { }

    // ── Getters ────────────────────────────────────────────────────────

    get fun nextLockId(): Int { return self.next_id; }
    get fun treasuryAddress(): Address { return self.treasury; }
    get fun saltGet(): Int { return self.salt; }
    get fun feeBps(): Int { return self.fee_bps; }
    get fun feeTon(): Int { return self.fee_ton; }

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
