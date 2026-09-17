// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupFactory v2.5.1 (Final)
// ───────────────────────────────────────────────────────────────────────────
// Singleton factory. Receives jetton transfers with CreateLock payload,
// deploys per-lock LockupWallet instances, forwards locked jettons.
// Also accumulates and lets treasury withdraw jetton & TON platform fees.
//
// Treasury-provided jetton wallet addresses (no deterministic computation).
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
//     CANNOT steal locked tokens. DoS mitigation: off-chain verifier + multi-sig.
//   - any user: can create a lock by sending jettons to the factory.
//   - creator:  taken from JettonNotification.sender (original owner).
//
// Known limitations:
//   L1. Lost fee-withdrawal bounce leaves pending_withdraw[qid] set forever.
//       No funds lost; treasury simply uses a new query_id.
//   L2. Overpay refund goes to msg.sender (original owner), not sender().
//   L3. If a create-transfer bounces, factory refunds to creator and emits
//       LockCreationFailed. The LockupWallet stays deployed but empty.
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./messages";
import "./lockup_wallet";

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
// Events (factory range 0x100-0x11F)
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
    next_id: Int as uint64;
    treasury: Address;

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
        let jm: Address? = self.wallet_to_master.get(sender());
        require(jm != null, "unknown jetton wallet");
        let jetton_master: Address = jm!!;

        let factoryWallet: Address? = self.own_wallets.get(jetton_master);
        require(factoryWallet != null, "jetton not whitelisted");

        require(context().value >= PLATFORM_FEE_TON + GAS_BUFFER_TON, "attach 1.25 TON");

        let sc: Slice = msg.forward_payload;
        if (sc.loadBit()) {
            sc = sc.loadRef().beginParse();
        }
        require(sc.loadUint(32) == CREATE_LOCK_OP, "wrong op");
        let qid: Int = sc.loadUint(64);
        let jm_in_payload: Address = sc.loadAddress();
        let ben: Address = sc.loadAddress();
        let unlock_at: Int = sc.loadUint(64);

        require(jm_in_payload == jetton_master, "jm mismatch");
        require(unlock_at > now(), "past date");
        require(unlock_at <= now() + MAX_LOCK_DURATION, "unlock too far");
        require(qid > 0, "query_id must be > 0");

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

        let fee: Int = (msg.amount * 50) / 10000;
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");

        let creator: Address = msg.sender;
        require(creator != myAddress(), "creator cannot be factory");

        let currentFee: Int? = self.fees.get(jetton_master);
        self.fees.set(jetton_master, (currentFee != null ? currentFee!! : 0) + fee);

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

    // ═══════════════════════════════════════════════════════════════════════
    // Bounce handler
    // ═══════════════════════════════════════════════════════════════════════

    bounced(msg: bounced<JettonTransfer>) {
        let qid: Int = msg.query_id;

        // Case A: create-transfer bounce
        let child: Address? = self.pending_create.get(qid);
        if (child != null) {
            let jm: Address? = self.create_jetton.get(qid);

            if (jm != null) {
                let jw: Address = self.own_wallets.get(jm!!)!!;
                require(sender() == jw, "create bounce from wrong wallet");
            }

            let creator: Address = self.create_creator.get(qid)!!;
            let amount: Int = self.create_amount.get(qid)!!;
            let ben: Address = self.create_beneficiary.get(qid)!!;

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

            emit(CreateBounced{ lock_id: qid, amount: amount }.toCell());

            emit(LockCreationFailed{
                lock_id: qid,
                creator: creator,
                beneficiary: ben,
                jetton: jm != null ? jm!! : myAddress(),
                amount: amount
            }.toCell());

            self.pending_create.set(qid, null);
            self.create_creator.set(qid, null);
            self.create_amount.set(qid, null);
            self.create_beneficiary.set(qid, null);
            self.create_jetton.set(qid, null);
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
