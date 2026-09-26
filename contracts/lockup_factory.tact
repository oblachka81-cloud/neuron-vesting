// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupFactory v5.0.0
// ───────────────────────────────────────────────────────────────────────────
// Singleton factory. Accepts jetton transfers with a `CreateLock` payload,
// deploys one LockupWallet per lock, and forwards the locked jettons to the
// corresponding wallet. Also accumulates and lets the treasury withdraw
// platform fees (TON and jettons).
//
// Changelog v5.0.0:
//   - Optimized DEPLOY_GAS from 0.15 to 0.12 TON based on mainnet empirical data.
//   - Fixed bounce refund: now refunds both fee_ton AND GAS_BUFFER_TON to the 
//     creator if deployment fails, ensuring no funds are unfairly retained.
//
// Trust model:
//   - treasury: whitelists jetton masters and withdraws fees.
//     Cannot withdraw locked jettons (they live inside LockupWallet).
//   - any user: can create a lock by sending jettons to the factory.
//   - creator: derived from the original owner of the jetton transfer.
//
// Query ID namespaces (F1):
//   - Create transfers:  qid = lock_id | HIGH_BIT
//   - Treasury ops:      qid = msg.query_id (HIGH_BIT must be clear)
//
// Invariants:
//   F1.  next_id strictly increases, never reused
//   F2.  own_wallets[m] set  <=>  treasury approved master m
//   F3.  wallet_to_master[w] = m  <=>  own_wallets[m] = w  (bijection)
//   F4.  fees[m] = cumulative platform fee for master m, minus withdrawals
//   F5.  pending_withdraw[qid] and pending_withdraw_jetton[qid] are set together;
//        cleared_withdraw[qid] is set to false while in-flight, true after a
//        bounce has been processed, so a duplicated bounce cannot double-credit
//   F6.  used_qids is monotonic: once true, never false
//   F7.  pending_create[id] and create_*[id] are set together, cleared on bounce
//
// Known limitations:
//   L1. LockCreated is emitted before the jetton transfer confirms. If the
//       transfer bounces, CreateBounced + RefundRequired follow. Frontends
//       should treat a lock as canonical only after N blocks without a
//       matching CreateBounced for the same lock_id.
//   L2. If a create-transfer bounce is lost, the pending_create entry for
//       that lock_id remains set. The entry is small and can be cleaned up
//       by a future migration.
//
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./messages";
import "./lockup_wallet";

// ─── Control messages ──────────────────────────────────────────────────────

/// Treasury-only: withdraw accumulated jetton fees for a given master.
message(0x20) WithdrawFees {
    query_id: Int as uint64;
    jetton_master: Address;
    destination_wallet: Address;
    amount: Int as coins;
}

/// Treasury-only: whitelist a jetton master and record the factory's
/// jetton wallet for that master.
message(0x21) SetJettonWallet {
    query_id: Int as uint64;
    jetton_master: Address;
    jetton_wallet: Address;
}

/// Treasury-only: withdraw accumulated TON platform fees.
message(0x22) WithdrawTonFees {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
}

/// Treasury-only: emergency TON rescue. Never withdraws fees reserved for
/// other pending operations.
message(0x23) RescueTon {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
}

/// Treasury-only: emergency jetton rescue for a whitelisted master.
message(0x24) RescueJetton {
    query_id: Int as uint64;
    jetton_master: Address;
    amount: Int as coins;
    destination: Address;
}

/// Treasury-only: update the per-lock jetton fee (basis points, max 10%).
message(0x25) SetFeeBps {
    query_id: Int as uint64;
    fee_bps: Int as uint16;
}

/// Treasury-only: update the fixed TON fee per lock.
message(0x26) SetFeeTon {
    query_id: Int as uint64;
    fee_ton: Int as coins;
}

// ─── Events ────────────────────────────────────────────────────────────────

/// A lock was requested. Final confirmation requires either the child
/// LockupWallet to report LockFunded, or the absence of CreateBounced (L1).
message(0x100) LockCreated {
    lock_id: Int as uint64;
    creator: Address;
    beneficiary: Address;
    jetton: Address;
    amount: Int as coins;
    unlock_at: Int as uint64;
}

/// TON platform fee collected from a lock.
message(0x106) TonFeeCollected {
    lock_id: Int as uint64;
    amount: Int as coins;
}

/// Jetton fees withdrawn by the treasury.
message(0x107) FeesWithdrawn {
    query_id: Int as uint64;
    jetton_master: Address;
    amount: Int as coins;
    destination: Address;
}

/// Jetton master successfully whitelisted.
message(0x109) JettonWalletSet {
    jetton_master: Address;
    jetton_wallet: Address;
}

/// A CreateLock payload was malformed. No state was modified.
message(0x111) LockCreationFailed {
    lock_id: Int as uint64;
    creator: Address;
    jetton: Address;
    amount: Int as coins;
}

/// The create-transfer to a LockupWallet bounced. Refund is pending.
message(0x112) CreateBounced {
    lock_id: Int as uint64;
    amount: Int as coins;
}

/// Instructs off-chain tooling to refund the creator manually (used when the
/// factory cannot complete the transfer itself).
message(0x115) RefundRequired {
    creator: Address;
    jetton: Address;
    amount: Int as coins;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/// Extra TON the caller must attach on top of `fee_ton` to cover the cost
/// of deploying the LockupWallet and forwarding jettons.
const GAS_BUFFER_TON: Int = ton("0.1");

/// Gas attached when deploying a LockupWallet.
/// AUDIT: Reduced from 0.15 to 0.12 in v5 based on mainnet empirical measurements.
const DEPLOY_GAS: Int = ton("0.12");

/// Gas attached to the jetton transfer that funds the LockupWallet.
const TRANSFER_GAS: Int = ton("0.05");

/// `forward_ton_amount` for jettons forwarded to the LockupWallet. TEP-74
/// jetton wallets require a non-zero value to emit a notification.
const TRANSFER_FORWARD: Int = ton("0.01");

/// Gas attached to a TEP-89 `provide_wallet_address` request.
const DISCOVERY_GAS: Int = ton("0.05");

/// Gas attached when rescuing jettons from the factory's jetton wallet.
const RESCUE_GAS: Int = ton("0.05");

/// Maximum allowed lock duration: 10 years.
const MAX_LOCK_DURATION: Int = 315360000;

/// Opcode of the `CreateLock` payload carried in a `forward_payload`.
const CREATE_LOCK_OP: Int = 0x1;

/// High bit used to separate create-transfer query IDs from treasury ones.
const HIGH_BIT: Int = 1 << 63;

/// Maximum platform fee in basis points (10%).
const MAX_FEE_BPS: Int = 1000;

/// Minimal payload size in bits: op (32) + qid (64) + 2 addresses (2×267) +
/// unlock_at (64). Used to reject malformed payloads before parsing.
const CREATE_LOCK_PAYLOAD_BITS: Int = 694;

// ─── Contract ──────────────────────────────────────────────────────────────

contract LockupFactory {
    // ── Identity ───────────────────────────────────────────────────────
    next_id: Int as uint64;
    treasury: Address;
    salt: Int as uint64;
    fee_bps: Int as uint16;
    fee_ton: Int as coins;

    // ── Whitelist (F2, F3) ─────────────────────────────────────────────
    own_wallets: map<Address, Address>;       // master -> factory jetton wallet
    wallet_to_master: map<Address, Address>;  // factory jetton wallet -> master

    // ── Fee accounting (F4) ────────────────────────────────────────────
    fees: map<Address, Int>;                  // master -> cumulative jetton fee
    ton_fees: Int as coins;

    // ── Query ID registry (F6) ─────────────────────────────────────────
    used_qids: map<Int, Bool>;

    // ── In-flight create tracking (F7) ─────────────────────────────────
    pending_create: map<Int, Address>;
    create_creator: map<Int, Address>;
    create_amount: map<Int, Int>;
    create_jetton: map<Int, Address>;
    create_fee_jetton: map<Int, Int>;
    create_fee_ton: map<Int, Int>;

    // ── In-flight withdraw tracking (F5) ───────────────────────────────
    // NOTE: Tact does not support optional value types inside maps.
    // We use a parallel "cleared" flag instead of set(null) for cleanup.
    pending_withdraw: map<Int, Int>;
    pending_withdraw_jetton: map<Int, Address>;
    cleared_withdraw: map<Int, Bool>;

    init(treasury: Address, salt: Int, fee_bps: Int, fee_ton: Int) {
        self.next_id = 1;
        self.treasury = treasury;
        self.salt = salt;
        self.fee_bps = fee_bps;
        self.fee_ton = fee_ton;
        self.ton_fees = 0;
    }

    /// Ignore Jetton Transfer Excess messages (gas refunds from internal transfers).
    /// AUDIT: Without this handler, receiving an excess causes exit code 130 
    /// and aborts state cleanup. This is a no-op by design.
    receive(msg: JettonExcesses) { }

    // ═══════════════════════════════════════════════════════════════════
    // Treasury: whitelist management
    // ═══════════════════════════════════════════════════════════════════

    /// Register a jetton master and the factory's jetton wallet for that
    /// master (F2, F3). Re-setting with the same wallet is allowed; setting
    /// a different wallet for an already registered master is rejected.
    receive(msg: SetJettonWallet) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");

        let cur: Address? = self.own_wallets.get(msg.jetton_master);
        require(cur == null || cur!! == msg.jetton_wallet, "already set");

        self.own_wallets.set(msg.jetton_master, msg.jetton_wallet);
        self.wallet_to_master.set(msg.jetton_wallet, msg.jetton_master);

        emit(JettonWalletSet{
            jetton_master: msg.jetton_master,
            jetton_wallet: msg.jetton_wallet
        }.toCell());
    }

    /// Update the per-lock jetton fee. Capped at MAX_FEE_BPS.
    receive(msg: SetFeeBps) {
        require(sender() == self.treasury, "not treasury");
        require(msg.fee_bps <= MAX_FEE_BPS, "max 10%");
        self.fee_bps = msg.fee_bps;
    }

    /// Update the fixed TON fee per lock.
    receive(msg: SetFeeTon) {
        require(sender() == self.treasury, "not treasury");
        self.fee_ton = msg.fee_ton;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Create lock
    // ═══════════════════════════════════════════════════════════════════

    /// Entry point for lock creation. The user sends jettons to the factory
    /// with a `CreateLock` payload. The factory:
    ///   1. Validates the sender is the factory's jetton wallet for a whitelisted master.
    ///   2. Validates the attached TON covers the platform fee + gas buffer.
    ///   3. Parses and validates the CreateLock payload.
    ///   4. Deducts the platform jetton fee and deploys a LockupWallet.
    ///   5. Forwards the locked jettons to the wallet and asks the master for its address.
    receive(msg: JettonNotification) {
        // F2, F3: identify master via reverse map before parsing the payload.
        let jm: Address? = self.wallet_to_master.get(sender());
        require(jm != null, "unknown wallet");
        let jetton_master: Address = jm!!;

        require(self.own_wallets.get(jetton_master) != null, "jetton not whitelisted");
        require(context().value >= self.fee_ton + GAS_BUFFER_TON, "attach fee+buffer");

        // TEP-74 serialises `forward_payload` as `Either Cell ^Cell`. Tact
        // leaves the Either bit intact for `Slice as remaining`, so the
        // first bit must be consumed manually.
        let sc: Slice = msg.forward_payload;
        if (sc.bits() > 0 && sc.loadBit()) {
            sc = sc.loadRef().beginParse();
        }

        // Reject malformed payloads without changing state.
        if (sc.bits() < CREATE_LOCK_PAYLOAD_BITS || sc.preloadUint(32) != CREATE_LOCK_OP) {
            emit(LockCreationFailed{
                lock_id: 0,
                creator: msg.sender,
                jetton: jetton_master,
                amount: msg.amount
            }.toCell());
            emit(RefundRequired{
                creator: msg.sender,
                jetton: jetton_master,
                amount: msg.amount
            }.toCell());
            return;
        }

        sc.loadUint(32);                              // op
        let qid: Int = sc.loadUint(64);               // client-side query id
        let jm_in: Address = sc.loadAddress();        // jetton master
        let ben: Address = sc.loadAddress();          // beneficiary
        let unlock_at: Int = sc.loadUint(64);

        require(jm_in == jetton_master, "jm mismatch");
        require(unlock_at > now() && unlock_at <= now() + MAX_LOCK_DURATION, "bad date");
        require(qid > 0, "qid 0");

        // F4: accumulate platform jetton fee.
        let fee: Int = (msg.amount * self.fee_bps) / 10000;
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");

        let creator: Address = msg.sender;

        // AUDIT: Overpay is refunded immediately to prevent the factory from 
        // hoarding user funds. Only fee_ton + GAS_BUFFER_TON are retained.
        let overpay: Int = context().value - self.fee_ton - GAS_BUFFER_TON;
        self.ton_fees = self.ton_fees + self.fee_ton;
        if (overpay > 0) {
            send(SendParameters{
                to: creator,
                value: overpay,
                mode: SendPayGasSeparately,
                body: emptyCell()
            });
        }

        let curFee: Int? = self.fees.get(jetton_master);
        self.fees.set(jetton_master, (curFee != null ? curFee!! : 0) + fee);

        let id: Int = self.next_id;
        self.next_id = id + 1;

        // Deploy the child wallet.
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

        // F7: record pending create state for bounce recovery.
        self.pending_create.set(id, childAddr);
        self.create_creator.set(id, creator);
        self.create_amount.set(id, lock_amount);
        self.create_jetton.set(id, jetton_master);
        self.create_fee_jetton.set(id, fee);
        self.create_fee_ton.set(id, self.fee_ton);

        // Send StartDiscovery so the wallet asks the master for its own
        // jetton wallet address (TEP-89).
        send(SendParameters{
            to: childAddr,
            value: DEPLOY_GAS,
            mode: SendPayGasSeparately,
            code: childInit.code,
            data: childInit.data,
            body: StartDiscovery{ query_id: id }.toCell()
        });

        // Ask the jetton master for the child wallet's jetton address.
        // The response is handled in `receive(TakeWalletAddress)` below.
        send(SendParameters{
            to: jetton_master,
            value: DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: id | HIGH_BIT,
                owner_address: childAddr,
                include_address: true
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
        emit(TonFeeCollected{ lock_id: id, amount: self.fee_ton }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEP-89 discovery response (for the child wallet)
    // ═══════════════════════════════════════════════════════════════════

    /// Called by the jetton master in response to the factory's
    /// `ProvideWalletAddress`. The factory then forwards the jettons to the
    /// discovered jetton wallet of the child LockupWallet.
    receive(msg: TakeWalletAddress) {
        let qid: Int = msg.query_id;

        // Only handle responses matching our create-transfer namespace.
        if ((qid & HIGH_BIT) == 0) { return; }

        let id: Int = qid & (HIGH_BIT - 1);
        let child: Address? = self.pending_create.get(id);
        if (child == null) { return; }

        // TEP-89 serialises `owner_address` as `Maybe ^MsgAddress`.
        let ownerOpt: Cell? = msg.owner_address;
        require(ownerOpt != null, "no owner");
        let owner: Address = ownerOpt!!.beginParse().loadAddress();
        require(owner == child!!, "wrong owner");

        let jmOpt: Address? = self.create_jetton.get(id);
        require(jmOpt != null && sender() == jmOpt!!, "not master");

        let amountOpt: Int? = self.create_amount.get(id);
        require(amountOpt != null, "no amount");

        let jwOpt: Address? = self.own_wallets.get(jmOpt!!);
        require(jwOpt != null, "no factory wallet");

        send(SendParameters{
            to: jwOpt!!,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: qid,
                amount: amountOpt!!,
                destination: child!!,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: TRANSFER_FORWARD,
                forward_payload: beginCell().storeBit(false).endCell().asSlice()
            }.toCell()
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Treasury: jetton fee withdrawal
    // ═══════════════════════════════════════════════════════════════════

    /// Withdraw accumulated jetton fees for a master (F4, F5, F6).
    receive(msg: WithdrawFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        require(msg.amount > 0, "zero");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        let curOpt: Int? = self.fees.get(msg.jetton_master);
        let cur: Int = curOpt != null ? curOpt!! : 0;
        require(cur >= msg.amount, "not enough fees");

        let jw: Address? = self.own_wallets.get(msg.jetton_master);
        require(jw != null, "not whitelisted");

        self.used_qids.set(msg.query_id, true);
        self.fees.set(msg.jetton_master, cur - msg.amount);
        self.pending_withdraw.set(msg.query_id, msg.amount);
        self.pending_withdraw_jetton.set(msg.query_id, msg.jetton_master);
        self.cleared_withdraw.set(msg.query_id, false); // in-flight

        send(SendParameters{
            to: jw!!,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: msg.amount,
                destination: msg.destination_wallet,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: TRANSFER_FORWARD,
                forward_payload: beginCell().storeBit(false).endCell().asSlice()
            }.toCell()
        });

        emit(FeesWithdrawn{
            query_id: msg.query_id,
            jetton_master: msg.jetton_master,
            amount: msg.amount,
            destination: msg.destination_wallet
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════
    // Bounce handling
    // ═══════════════════════════════════════════════════════════════════

    /// Two cases share the JettonTransfer opcode:
    ///   - Case A: Create-transfer bounce: refund jettons and fees (F7).
    ///   - Case B: Fee-withdrawal bounce: restore `fees[m]` (F5).
    bounced(msg: bounced<JettonTransfer>) {
        let qid: Int = msg.query_id;

        // ── Case A: create-transfer bounce ─────────────────────────────
        if ((qid & HIGH_BIT) != 0) {
            let id: Int = qid & (HIGH_BIT - 1);
            let child: Address? = self.pending_create.get(id);
            if (child == null) { return; }

            let jmOpt: Address? = self.create_jetton.get(id);
            let creatorOpt: Address? = self.create_creator.get(id);
            let amountOpt: Int? = self.create_amount.get(id);
            let feeOpt: Int? = self.create_fee_jetton.get(id);
            let tonOpt: Int? = self.create_fee_ton.get(id);

            require(
                jmOpt != null && creatorOpt != null && amountOpt != null
                && feeOpt != null && tonOpt != null,
                "inconsistent create state"
            );

            let jm: Address = jmOpt!!;
            let creator: Address = creatorOpt!!;
            let amount: Int = amountOpt!!;
            let fee: Int = feeOpt!!;
            let charged_ton: Int = tonOpt!!;

            let jwOpt: Address? = self.own_wallets.get(jm);
            require(jwOpt != null, "no factory wallet");
            require(sender() == jwOpt!!, "bounce from wrong wallet");

            // Roll back the jetton fee accounting (saturated at 0).
            let curFeeOpt: Int? = self.fees.get(jm);
            let curFee: Int = curFeeOpt != null ? curFeeOpt!! : 0;
            self.fees.set(jm, curFee > fee ? curFee - fee : 0);

            // AUDIT v5 FIX: Refund BOTH the platform fee and the gas buffer.
            // Since the deployment failed, the factory should not retain GAS_BUFFER_TON.
            let refund_amount: Int = charged_ton + GAS_BUFFER_TON;
            if (self.ton_fees >= charged_ton) {
                self.ton_fees = self.ton_fees - charged_ton;
                send(SendParameters{
                    to: creator,
                    value: refund_amount,
                    mode: SendPayGasSeparately,
                    body: emptyCell()
                });
            }

            emit(CreateBounced{ lock_id: id, amount: amount }.toCell());
            emit(RefundRequired{
                creator: creator,
                jetton: jm,
                amount: amount + fee
            }.toCell());

            self.pending_create.set(id, null);
            self.create_creator.set(id, null);
            self.create_amount.set(id, null);
            self.create_jetton.set(id, null);
            self.create_fee_jetton.set(id, null);
            self.create_fee_ton.set(id, null);
            return;
        }

        // ── Case B: fee-withdrawal bounce ──────────────────────────────
        let amtOpt: Int? = self.pending_withdraw.get(qid);
        let jmOpt2: Address? = self.pending_withdraw_jetton.get(qid);
        let clearedOpt: Bool? = self.cleared_withdraw.get(qid);

        // Skip if not tracked, or already cleared (duplicated bounce).
        if (amtOpt != null && jmOpt2 != null
            && clearedOpt != null && !clearedOpt!!) {

            let jm: Address = jmOpt2!!;
            let jwOpt: Address? = self.own_wallets.get(jm);
            require(jwOpt != null, "no factory wallet");
            require(sender() == jwOpt!!, "withdraw bounce from wrong wallet");

            let opt: Int? = self.fees.get(jm);
            let cur: Int = opt != null ? opt!! : 0;
            self.fees.set(jm, cur + amtOpt!!);

            // Mark cleared so a duplicated bounce cannot double-credit.
            self.cleared_withdraw.set(qid, true);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Treasury: TON fees & rescue
    // ═══════════════════════════════════════════════════════════════════

    /// Withdraw accumulated TON platform fees.
    receive(msg: WithdrawTonFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0 && msg.amount > 0, "bad args");
        require(self.ton_fees >= msg.amount, "not enough");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        self.used_qids.set(msg.query_id, true);
        self.ton_fees = self.ton_fees - msg.amount;

        send(SendParameters{
            to: msg.destination,
            value: msg.amount,
            mode: SendPayGasSeparately,
            body: emptyCell()
        });
    }

    /// Emergency TON rescue. Never touches funds reserved for fee payout.
    receive(msg: RescueTon) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        require(msg.amount > 0, "zero");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        let reserved: Int = self.ton_fees + ton("0.05");
        let available: Int = myBalance() - reserved;
        require(available >= msg.amount, "not enough after reserving fees");

        self.used_qids.set(msg.query_id, true);

        send(SendParameters{
            to: msg.destination,
            value: msg.amount,
            mode: SendPayGasSeparately,
            body: emptyCell()
        });
    }

    /// Emergency jetton rescue from a whitelisted master.
    receive(msg: RescueJetton) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        require(msg.amount > 0, "zero");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        let jw: Address? = self.own_wallets.get(msg.jetton_master);
        require(jw != null, "not whitelisted");

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
                forward_ton_amount: TRANSFER_FORWARD,
                forward_payload: beginCell().storeBit(false).endCell().asSlice()
            }.toCell()
        });
    }

    /// Plain TON top-ups (gas).
    receive() { }

    // ═══════════════════════════════════════════════════════════════════
    // Getters
    // ═══════════════════════════════════════════════════════════════════

    get fun nextLockId(): Int { return self.next_id; }
    get fun feeBps(): Int { return self.fee_bps; }
    get fun feeTon(): Int { return self.fee_ton; }
    get fun tonFees(): Int { return self.ton_fees; }
    get fun feeOf(jetton: Address): Int {
        let opt: Int? = self.fees.get(jetton);
        return opt != null ? opt!! : 0;
    }
    get fun isWalletSet(jetton: Address): Bool { return self.own_wallets.get(jetton) != null; }
    get fun walletOf(jetton: Address): Address? { return self.own_wallets.get(jetton); }
    get fun pendingCreateOf(lockId: Int): Address? { return self.pending_create.get(lockId); }
}
