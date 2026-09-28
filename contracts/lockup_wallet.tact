// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupWallet v5.1.1
// ───────────────────────────────────────────────────────────────────────────
// One LockupWallet per lock. Holds jettons after the factory forwards them
// into the wallet's deterministic jetton wallet, enforces the unlock
// schedule, and releases jettons to the beneficiary on claim.
//
// Changelog v5.1.1:
//   - OBSERVABILITY FIX: added ClaimSettled (0x128), emitted ONLY when a claim
//     is confirmed by JettonExcesses. Claimed (0x125) remains dispatch-only.
//     Indexers/UIs must use ClaimSettled as "paid", not Claimed.
//   - ClaimSettled is emitted before clearing pending_* and before possible
//     self-destruct, so settlement is observable even on final claim.
//
// Changelog v5.1.0:
//   - SECURITY FIX (W4): `claimed` is now incremented ONLY on confirmed
//     settlement (JettonExcesses), not optimistically on dispatch (flow 2).
//     This makes the new ResetPendingClaim safe: a reset clears the in-flight
//     claim without touching accounting, because nothing was pre-booked.
//     The jetton wallet physically caps double-spend regardless of reset.
//   - ADDED: ResetPendingClaim (beneficiary-only, after RESET_TIMEOUT) —
//     on-chain escape hatch for a stuck pending_claim when settlement never
//     arrives in a recognized form (foreign masters, lost callbacks).
//     Closes W4: a stuck claim is no longer irreversible.
//   - ADDED: pending_set_at field + ClaimReset event (0x127) for indexer
//     visibility of resets.
//   - bounced no longer rolls back `claimed` (nothing was pre-booked).
//
// Changelog v5.0.3:
//   - SECURITY FIX (Finding #4): replay guard for TakeWalletAddress flow 2
//     (consumed_claim map). Mirrors consumed_forward in LockupFactory v5.0.3.
//   - DEFENSE-IN-DEPTH: sender check in bounced handler.
//
// Changelog v5.0.2:
//   - Static-analysis cleanup (Misti --all-detectors). No functional change.
//
// Changelog v5.0.1:
//   - FIXED (mainnet K1, exit 36235): JettonExcesses accepts the success
//     callback from EITHER jetton wallet of the TEP-74 transfer chain.
//   - ADDED: beneficiary_wallet state field, cached during claim flow 2.
//
// Changelog v5.0.0:
//   - ADDED: sweep of remaining TON to beneficiary + self-destruct on final
//     confirmed claim.
//
// Jetton wallet discovery: via TEP-89 provide_wallet_address (no StateInit/c4
// assumptions).
//
// Funding: JettonNotification from the discovered jetton wallet marks
// `funded = true` iff amount == total_amount.
//
// Claim lifecycle (v5.1.1):
//   1. Beneficiary sends Claim (after unlock_at). pending_* set, pending_set_at=now.
//   2. Wallet asks master for beneficiary's jetton wallet (TEP-89).
//   3. Flow 2 dispatches JettonTransfer from own JW. `claimed` NOT yet moved.
//      Emits Claimed (0x125) = DISPATCH, not payout.
//   4. Settlement:
//        - JettonExcesses (match) -> emit ClaimSettled (0x128); claimed += pending_amount;
//          clear pending; clear guard; if claimed>=total -> sweep + self-destruct.
//        - bounced (match) -> clear pending; clear guard; claimed untouched.
//        - ResetPendingClaim (after timeout) -> clear pending; clear guard;
//          claimed untouched. Late settlement after reset is ignored because
//          pending_query_id is already 0.
//
// Invariants:
//   I1. claimed <= total_amount
//   I2. pending_amount > 0 iff pending_claim == true
//   I3. funded == true only after JettonNotification amount==total from JW
//   I4. jetton_wallet set at most once
//   I5. at most one pending claim per wallet
//   I6. after confirmed final claim, all TON swept + self-destruct
//   I7. at most one JettonTransfer dispatch per pending_claim lifecycle
//   I8. [v5.1.0] claimed reflects ONLY confirmed settlements; reset never
//       mutates claimed; double-spend impossible (JW caps balance).
//   I9. [v5.1.1] every confirmed settlement emits ClaimSettled before clearing
//       pending state and before possible self-destruct.
//
// Known residual limitation (accepted, documented in SPEC):
//   R1. If a dispatch succeeded but its excesses was lost forever (α), a reset
//       leaves claimed=0 with an empty JW: no funds lost, no double-spend, but
//       accounting understates and self-destruct does not fire. Inherent to
//       lost-delivery settlement; mitigated for COGNIQ by wide excesses guard
//       (v5.0.1). Reset is the safety net for foreign masters.
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

/// [v5.1.0] Beneficiary-only escape hatch for a stuck pending_claim.
/// Allowed only after RESET_TIMEOUT since the claim was initiated. Clears
/// in-flight state and the dispatch guard WITHOUT touching `claimed`.
message(0x11) ResetPendingClaim {
    query_id: Int as uint64;
}

// ─── Events ───────────────────────────────────────────────────────────────

/// Emitted when the wallet receives the exact expected amount.
message(0x124) LockFunded {
    lock_id: Int as uint64;
    amount: Int as coins;
}

/// Emitted when a claim JettonTransfer is dispatched (NOT yet confirmed).
/// Confirmation is the subsequent ClaimSettled event via JettonExcesses.
message(0x125) Claimed {
    lock_id: Int as uint64;
    amount: Int as coins;
    beneficiary: Address;
    beneficiary_wallet: Address;
}

/// Emitted when the claim JettonTransfer bounced. `claimed` untouched (v5.1.0).
message(0x126) ClaimBounced {
    lock_id: Int as uint64;
    amount: Int as coins;
}

/// [v5.1.0] Emitted when a stuck pending_claim is reset by the beneficiary.
message(0x127) ClaimReset {
    lock_id: Int as uint64;
    query_id: Int as uint64;
}

/// [v5.1.1] Emitted when a claim is CONFIRMED by JettonExcesses (settlement).
/// This is the only wallet event that should drive "paid" state in indexers/UI.
message(0x128) ClaimSettled {
    lock_id: Int as uint64;
    amount: Int as coins;
    query_id: Int as uint64;
}

// ─── Constants ────────────────────────────────────────────────────────────

/// Gas attached to a `provide_wallet_address` request to the jetton master.
const WALLET_DISCOVERY_GAS: Int = ton("0.05");

/// Gas attached to the outgoing JettonTransfer when claiming.
const CLAIM_GAS: Int = ton("0.05");

/// `forward_ton_amount` for the claim JettonTransfer.
const CLAIM_FORWARD: Int = ton("0.01");

/// [v5.1.0] Minimum seconds a pending_claim must age before ResetPendingClaim
/// is allowed. Legit settlement arrives within blocks (seconds–minutes); 1 hour
/// is conservative and never races a real in-flight delivery.
const RESET_TIMEOUT: Int = 3600;

// ─── Contract ─────────────────────────────────────────────────────────────

contract LockupWallet {
    // ── Immutable identity ─────────────────────────────────────────────
    lock_id: Int as uint64;
    factory: Address;
    jetton_master: Address;
    beneficiary: Address;
    creator: Address;

    // ── Schedule & accounting ──────────────────────────────────────────
    total_amount: Int as coins;
    claimed: Int as coins;          // confirmed settlements only (v5.1.0)
    unlock_at: Int as uint64;

    // ── Discovery & funding state ─────────────────────────────────────
    jetton_wallet: Address?;
    beneficiary_wallet: Address?;
    fund_sender: Address?;
    funded: Bool;

    // ── In-flight claim state (I5) ─────────────────────────────────────
    pending_claim: Bool;
    pending_amount: Int as coins;
    pending_query_id: Int as uint64;
    pending_set_at: Int as uint64;   // [v5.1.0] age anchor for reset timeout

    // ── Replay guard for claim dispatch (I7) ───────────────────────────
    consumed_claim: map<Int, Bool>;

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
        self.beneficiary_wallet = null;
        self.fund_sender = null;
        self.funded = false;
        self.pending_claim = false;
        self.pending_amount = 0;
        self.pending_query_id = 0;
        self.pending_set_at = 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Discovery
    // ══════════════════════════════════════════════════════════════════

    receive(msg: StartDiscovery) {
        require(sender() == self.factory, "not factory");
        message(MessageParameters{
            to: self.jetton_master,
            value: WALLET_DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: self.lock_id,
                owner_address: myAddress(),
                include_address: true
            }.toCell()
        });
    }

    receive(msg: TakeWalletAddress) {
        require(sender() == self.jetton_master, "not master");

        let ownerOpt: Cell? = msg.owner_address;
        require(ownerOpt != null, "no owner");
        let owner: Address = ownerOpt!!.beginParse().loadAddress();

        // ── Flow 2: dispatch pending claim (NO accounting move) ────────
        if (self.pending_claim
            && owner == self.beneficiary
            && msg.query_id == self.pending_query_id) {

            require(self.jetton_wallet != null, "no wallet");

            // [v5.0.3 FIX #4] replay guard: one dispatch per pending lifecycle.
            if (self.consumed_claim.get(self.pending_query_id) != null) { return; }
            self.consumed_claim.set(self.pending_query_id, true);

            self.beneficiary_wallet = msg.wallet_address;

            // v5.1.0: claimed is NOT incremented here. Dispatch only.
            message(MessageParameters{
                to: self.jetton_wallet!!,
                value: CLAIM_GAS,
                mode: SendPayGasSeparately,
                body: JettonTransfer{
                    query_id: self.pending_query_id,
                    amount: self.pending_amount,
                    destination: self.beneficiary,
                    response_destination: myAddress(),
                    custom_payload: null,
                    forward_ton_amount: CLAIM_FORWARD,
                    forward_payload: beginCell().storeBit(false).endCell().asSlice()
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
    // ══════════════════════════════════════════════════════════════════

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
        self.pending_set_at = now();   // [v5.1.0]

        message(MessageParameters{
            to: self.jetton_master,
            value: WALLET_DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: msg.query_id,
                owner_address: self.beneficiary,
                include_address: true
            }.toCell()
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // [v5.1.0] Reset — on-chain escape hatch for stuck pending_claim
    // ═══════════════════════════════════════════════════════════════════

    receive(msg: ResetPendingClaim) {
        require(sender() == self.beneficiary, "not beneficiary");
        require(self.pending_claim, "no pending claim");
        require(now() >= self.pending_set_at + RESET_TIMEOUT, "timeout not reached");

        let qid: Int = self.pending_query_id;
        self.pending_claim = false;
        self.pending_amount = 0;
        self.pending_query_id = 0;
        self.pending_set_at = 0;
        self.consumed_claim.set(qid, null);   // clear guard so qid is reusable

        // claimed intentionally NOT touched (I8): nothing was pre-booked.
        emit(ClaimReset{ lock_id: self.lock_id, query_id: qid }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════
    // Claim settlement
    // ═══════════════════════════════════════════════════════════════════

    receive(msg: JettonExcesses) {
        let jw: Address? = self.jetton_wallet;
        let bw: Address? = self.beneficiary_wallet;
        let s: Address = sender();
        require(
            jw != null && (s == jw!! || (bw != null && s == bw!!)),
            "not our wallet"
        );

        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            let settle_amount: Int = self.pending_amount;
            let settle_qid: Int = msg.query_id;

            // v5.1.0: confirm payment HERE.
            self.claimed = self.claimed + settle_amount;

            // v5.1.1: observable confirmation. Emit BEFORE clearing/destroy.
            emit(ClaimSettled{
                lock_id: self.lock_id,
                amount: settle_amount,
                query_id: settle_qid
            }.toCell());

            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
            self.pending_set_at = 0;
            self.consumed_claim.set(settle_qid, null);

            if (self.claimed >= self.total_amount) {
                message(MessageParameters{
                    to: self.beneficiary,
                    value: 0,
                    mode: SendRemainingBalance | SendIgnoreErrors | 32,
                    body: emptyCell()
                });
            }
        }
        // Late excesses after a reset: pending_claim==false -> ignored (I8).
    }

    bounced(msg: bounced<JettonTransfer>) {
        require(sender() == self.jetton_wallet, "bounce from wrong wallet");

        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            // v5.1.0: claimed untouched (was never pre-booked on dispatch).
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
            self.pending_set_at = 0;
            self.consumed_claim.set(msg.query_id, null);

            emit(ClaimBounced{
                lock_id: self.lock_id,
                amount: msg.amount
            }.toCell());
        }
    }

    receive() { }

    // ═══════════════════════════════════════════════════════════════════
    // Getters
    // ═══════════════════════════════════════════════════════════════════

    get fun lockId(): Int { return self.lock_id; }
    get fun isFunded(): Bool { return self.funded; }
    get fun jettonWallet(): Address? { return self.jetton_wallet; }
    get fun beneficiaryWallet(): Address? { return self.beneficiary_wallet; }
    get fun unlockAt(): Int { return self.unlock_at; }
    get fun beneficiaryGet(): Address { return self.beneficiary; }
    get fun claimedAmount(): Int { return self.claimed; }
    get fun isPendingClaim(): Bool { return self.pending_claim; }
    get fun pendingSetAt(): Int { return self.pending_set_at; }
    get fun availableClaimable(): Int {
        if (!self.funded || self.pending_claim || now() < self.unlock_at) {
            return 0;
        }
        return self.total_amount - self.claimed;
    }
    get fun isClaimConsumed(qid: Int): Bool {
        let val: Bool? = self.consumed_claim.get(qid);
        return val != null && val!!;
    }
}
