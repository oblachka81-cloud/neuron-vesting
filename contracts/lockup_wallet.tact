// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupWallet v4.1.0
// ───────────────────────────────────────────────────────────────────────────
// One LockupWallet per lock. Holds jettons after the factory forwards them
// into the wallet's deterministic jetton wallet, enforces the unlock
// schedule, and releases jettons to the beneficiary on claim.
//
// Jetton wallet discovery:
//   The wallet does not compute its jetton wallet address via StateInit.
//   Instead, it asks the jetton master using TEP-89 `provide_wallet_address`
//   and caches the response. This avoids assumptions about the internal
//   storage layout (c4) of arbitrary TEP-74 jetton wallet implementations.
//
// Funding:
//   The factory sends a JettonTransfer directly to this contract's
//   deterministic jetton wallet. The wallet receives a JettonNotification
//   from that jetton wallet and records `funded = true` if and only if the
//   notified amount matches the expected `total_amount`.
//
// Claim:
//   1. Beneficiary sends `Claim` (after `unlock_at`).
//   2. Wallet asks the master for the beneficiary's jetton wallet (TEP-89).
//   3. Wallet sends JettonTransfer from its own jetton wallet to the
//      beneficiary's jetton wallet.
//   4. The jetton wallet responds with JettonExcesses on success, or the
//      transfer bounces on failure. In both cases `pending_claim` is reset,
//      and on bounce `claimed` is rolled back.
//
// Invariants:
//   I1. `claimed <= total_amount`
//   I2. `pending_amount > 0` iff `pending_claim == true`
//   I3. `funded == true` only after a JettonNotification with
//       `amount == total_amount` from the discovered jetton wallet
//   I4. `jetton_wallet` is set at most once (discovery is idempotent)
//   I5. Claims are atomic: at most one pending claim per wallet
//
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./messages";

// ─── External messages ─────────────────────────────────────────────────────

/// Beneficiary initiates a claim. `amount == 0` claims the full available
/// balance; a non-zero amount performs a partial claim.
message(0x10) Claim {
    query_id: Int as uint64;
    amount: Int as coins;
}

/// Sent by the factory right after deploying this wallet. The wallet then
/// asks the jetton master (via TEP-89) for its own jetton wallet address.
message(0x31) StartDiscovery {
    query_id: Int as uint64;
}

// ─── Events ────────────────────────────────────────────────────────────────

/// Emitted when the wallet receives the exact expected amount.
message(0x124) LockFunded {
    lock_id: Int as uint64;
    amount: Int as coins;
}

/// Emitted when a claim JettonTransfer is sent. Final settlement is
/// confirmed either by JettonExcesses (success) or by bounce (rollback).
message(0x125) Claimed {
    lock_id: Int as uint64;
    amount: Int as coins;
    beneficiary: Address;
    beneficiary_wallet: Address;
}

/// Emitted when the claim JettonTransfer bounced. `claimed` is rolled back.
message(0x126) ClaimBounced {
    lock_id: Int as uint64;
    amount: Int as coins;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/// Gas attached to a `provide_wallet_address` request to the jetton master.
const DISCOVERY_GAS: Int = ton("0.05");

/// Gas attached to the outgoing JettonTransfer when claiming.
const CLAIM_GAS: Int = ton("0.05");

/// `forward_ton_amount` for the claim JettonTransfer. A non-zero value is
/// required by TEP-74 jetton wallets to emit a JettonNotification to the
/// destination's owner; 1 nanoton is the canonical minimum.
const CLAIM_FORWARD: Int = ton("0.01");

/// Non-empty forward payload. Some TEP-74 implementations (e.g. COGNIQ)
/// enforce `forward_payload.bits() >= 1` and revert with exit code 708 on
/// an empty slice. A single zero bit is the minimal valid payload.
const EMPTY_FORWARD_PAYLOAD: Slice = beginCell().storeBit(0).endCell().asSlice();

// ─── Contract ──────────────────────────────────────────────────────────────

contract LockupWallet {
    // ── Immutable identity ─────────────────────────────────────────────
    lock_id: Int as uint64;
    factory: Address;
    jetton_master: Address;
    beneficiary: Address;
    creator: Address;

    // ── Schedule & accounting ──────────────────────────────────────────
    total_amount: Int as coins;
    claimed: Int as coins;
    unlock_at: Int as uint64;

    // ── Discovery & funding state ──────────────────────────────────────
    /// This wallet's jetton wallet address, resolved via TEP-89.
    jetton_wallet: Address?;
    /// Notification sender observed before discovery completed.
    /// Used to mark `funded` if the discovered wallet matches.
    fund_sender: Address?;
    /// True once the wallet has received the exact expected amount.
    funded: Bool;

    // ── In-flight claim state (I5) ─────────────────────────────────────
    pending_claim: Bool;
    pending_amount: Int as coins;
    pending_query_id: Int as uint64;

    init(
        lock_id: Int,
        factory: Address,
        jetton_master: Address,
        beneficiary: Address,
        creator: Address,
        total_amount: Int,
        unlock_at: Int
    ) {
        self.lock_id = lock_id;
        self.factory = factory;
        self.jetton_master = jetton_master;
        self.beneficiary = beneficiary;
        self.creator = creator;
        self.total_amount = total_amount;
        self.claimed = 0;
        self.unlock_at = unlock_at;
        self.jetton_wallet = null;
        self.fund_sender = null;
        self.funded = false;
        self.pending_claim = false;
        self.pending_amount = 0;
        self.pending_query_id = 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Discovery
    // ═══════════════════════════════════════════════════════════════════

    /// Factory-only entry point: kick off TEP-89 discovery.
    receive(msg: StartDiscovery) {
        require(sender() == self.factory, "not factory");
        send(SendParameters{
            to: self.jetton_master,
            value: DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: self.lock_id,
                owner_address: myAddress(),
                include_address: true
            }.toCell()
        });
    }

    /// Response from the jetton master. Reached for two distinct flows:
    ///   1) Discovery of our own jetton wallet (owner == myAddress()).
    ///   2) Discovery of the beneficiary's jetton wallet (owner == beneficiary),
    ///      used to complete an in-flight claim.
    receive(msg: TakeWalletAddress) {
        require(sender() == self.jetton_master, "not master");

        // TEP-89 serialises the owner as `Maybe ^MsgAddress`.
        let ownerOpt: Cell? = msg.owner_address;
        require(ownerOpt != null, "no owner");
        let owner: Address = ownerOpt!!.beginParse().loadAddress();

        // ── Flow 2: complete pending claim ─────────────────────────────
        if (self.pending_claim
            && owner == self.beneficiary
            && msg.query_id == self.pending_query_id) {

            require(self.jetton_wallet != null, "no wallet");

            self.claimed = self.claimed + self.pending_amount;

            send(SendParameters{
                to: self.jetton_wallet!!,
                value: CLAIM_GAS,
                mode: SendPayGasSeparately,
                body: JettonTransfer{
                    query_id: self.pending_query_id,
                    amount: self.pending_amount,
                    destination: msg.wallet_address,
                    response_destination: myAddress(),
                    custom_payload: null,
                    forward_ton_amount: CLAIM_FORWARD,
                    forward_payload: EMPTY_FORWARD_PAYLOAD
                }.toCell()
            });

            emit(Claimed{
                lock_id: self.lock_id,
                amount: self.pending_amount,
                beneficiary: self.beneficiary,
                beneficiary_wallet: msg.wallet_address
            }.toCell());

            return;
        }

        // ── Flow 1: discover our own jetton wallet ─────────────────────
        if (owner == myAddress() && self.jetton_wallet == null) {
            self.jetton_wallet = msg.wallet_address;

            // If a notification was already observed before discovery
            // completed, reconcile now (I4).
            let fs: Address? = self.fund_sender;
            if (fs != null && fs!! == msg.wallet_address && !self.funded) {
                self.funded = true;
                self.fund_sender = null;
                emit(LockFunded{
                    lock_id: self.lock_id,
                    amount: self.total_amount
                }.toCell());
            }
            return;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Funding
    // ═══════════════════════════════════════════════════════════════════

    /// Accept deposits exclusively from the discovered jetton wallet (I3).
    /// Notifications arriving before discovery are buffered in `fund_sender`
    /// and reconciled in `TakeWalletAddress`.
    receive(msg: JettonNotification) {
        let jw: Address? = self.jetton_wallet;
        if (jw == null) {
            if (msg.amount == self.total_amount) {
                self.fund_sender = sender();
            }
            return;
        }
        require(sender() == jw!!, "not our wallet");
        require(!self.funded, "already funded");
        require(msg.amount == self.total_amount, "wrong amount");
        self.funded = true;
        emit(LockFunded{ lock_id: self.lock_id, amount: msg.amount }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════
    // Claim
    // ═══════════════════════════════════════════════════════════════════

    /// Beneficiary initiates a claim. The wallet then asks the master for
    /// the beneficiary's jetton wallet (TEP-89) and, on response, sends the
    /// jettons.
    receive(msg: Claim) {
        require(sender() == self.beneficiary, "not beneficiary");
        require(self.funded, "not funded");
        require(now() >= self.unlock_at, "still locked");
        require(!self.pending_claim, "claim in flight");
        require(msg.query_id > 0, "qid 0");

        let available: Int = self.total_amount - self.claimed;
        require(available > 0, "nothing to claim");

        let want: Int = msg.amount == 0 ? available : msg.amount;
        require(want > 0 && want <= available, "bad amount");

        self.pending_claim = true;
        self.pending_amount = want;
        self.pending_query_id = msg.query_id;

        send(SendParameters{
            to: self.jetton_master,
            value: DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: msg.query_id,
                owner_address: self.beneficiary,
                include_address: true
            }.toCell()
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Claim settlement
    // ═══════════════════════════════════════════════════════════════════

    /// Jetton wallet's success callback. Resets `pending_claim` so future
    /// claims can proceed.
    receive(msg: JettonExcesses) {
        let jw: Address? = self.jetton_wallet;
        require(jw != null && sender() == jw!!, "not our wallet");
        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
        }
    }

    /// Jetton transfer failed: roll back `claimed` and clear pending state.
    bounced(msg: bounced<JettonTransfer>) {
        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            self.claimed = self.claimed - self.pending_amount;
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
            emit(ClaimBounced{
                lock_id: self.lock_id,
                amount: msg.amount
            }.toCell());
        }
    }

    /// Plain TON top-ups (gas).
    receive() { }

    // ═══════════════════════════════════════════════════════════════════
    // Getters
    // ═══════════════════════════════════════════════════════════════════

    get fun lockId(): Int { return self.lock_id; }
    get fun isFunded(): Bool { return self.funded; }
    get fun jettonWallet(): Address? { return self.jetton_wallet; }
    get fun unlockAt(): Int { return self.unlock_at; }
    get fun beneficiaryGet(): Address { return self.beneficiary; }
    get fun claimedAmount(): Int { return self.claimed; }
    get fun isPendingClaim(): Bool { return self.pending_claim; }
    get fun availableClaimable(): Int {
        if (!self.funded || self.pending_claim || now() < self.unlock_at) {
            return 0;
        }
        return self.total_amount - self.claimed;
    }
}
