// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupWallet v5.0.3
// ───────────────────────────────────────────────────────────────────────────
// One LockupWallet per lock. Holds jettons after the factory forwards them
// into the wallet's deterministic jetton wallet, enforces the unlock
// schedule, and releases jettons to the beneficiary on claim.
//
// Changelog v5.0.3:
//   - SECURITY FIX (Finding #4): Added replay guard for TakeWalletAddress flow 2.
//     Prevents malicious/broken masters from triggering multiple JettonTransfer
//     dispatches for a single pending_claim via repeated TEP-89 replies.
//     Mirrors the consumed_forward fix in LockupFactory v5.0.3.
//   - DEFENSE-IN-DEPTH: Added sender check in bounced handler for consistency
//     with factory bounce logic (though TVM guarantees origin binding).
//
// Changelog v5.0.2:
//   - Static-analysis cleanup (Misti --all-detectors): replaced raw integer
//     mode flags with symbolic constants, replaced `send(SendParameters{})`
//     with `message()` where applicable. No functional change.
//
// Changelog v5.0.1:
//   - FIXED (mainnet K1, exit 36235): JettonExcesses now accepts the success
//     callback from EITHER jetton wallet of the TEP-74 transfer chain — our
//     own jetton wallet OR the beneficiary's jetton wallet. Per TEP-74 the
//     receiving-side wallet also returns excesses to response_destination
//     (it is copied into internal_transfer), and COGNIQ's sending-side wallet
//     sends none. The old `sender() == jetton_wallet` guard reverted the only
//     excess that ever arrived, leaving pending_claim stuck and ~0.25 TON of
//     dust per completed lock.
//   - ADDED: `beneficiary_wallet` state field, cached from the TEP-89
//     TakeWalletAddress response during claim flow 2.
//
// Changelog v5.0.0:
//   - ADDED: Automatic sweep of all remaining TON balance to beneficiary after
//     successful claim completion (mode: SendRemainingBalance | DestroyIfZero | SendIgnoreErrors).
//   - ADDED: Contract self-destruct after final claim to reclaim storage deposit.
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
//   I6. After successful claim completion, all remaining TON balance is
//       returned to beneficiary and contract self-destructs (no dust left)
//   I7. [V5.0.3] At most one JettonTransfer dispatch per pending_claim lifecycle
//       (replay guard against duplicate TakeWalletAddress from master)
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

// ─── Events ───────────────────────────────────────────────────────────────

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
const WALLET_DISCOVERY_GAS: Int = ton("0.05");

/// Gas attached to the outgoing JettonTransfer when claiming.
const CLAIM_GAS: Int = ton("0.05");

/// `forward_ton_amount` for the claim JettonTransfer. A non-zero value is
/// required by TEP-74 jetton wallets to emit a notification. 1 nanoton is
/// the canonical minimum.
const CLAIM_FORWARD: Int = ton("0.01");

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
    claimed: Int as coins;
    unlock_at: Int as uint64;

    // ── Discovery & funding state ─────────────────────────────────────
    /// This wallet's jetton wallet address, resolved via TEP-89.
    jetton_wallet: Address?;
    /// The beneficiary's jetton wallet address, resolved via TEP-89 during
    /// claim flow 2. v5.0.1: excesses from this address also settle claims,
    /// because TEP-74 copies response_destination into internal_transfer and
    /// the receiving-side wallet returns excesses to it.
    beneficiary_wallet: Address?;
    /// Notification sender observed before discovery completed.
    /// Used to mark `funded` if the discovered wallet matches.
    fund_sender: Address?;
    /// True once the wallet has received the exact expected amount.
    funded: Bool;

    // ── In-flight claim state (I5) ─────────────────────────────────────
    pending_claim: Bool;
    pending_amount: Int as coins;
    pending_query_id: Int as uint64;

    // ── Replay guard for claim dispatch (I7 / V5.0.3 FIX #4) ───────────
    /// Tracks which pending_query_ids have already had their JettonTransfer
    /// dispatched. Prevents duplicate dispatches from repeated TakeWalletAddress
    /// responses (malicious/buggy master). Cleared alongside pending_* on
    /// settlement (excesses) or rollback (bounce).
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
    }

    // ═══════════════════════════════════════════════════════════════════
    // Discovery
    // ══════════════════════════════════════════════════════════════════

    /// Factory-only entry point: kick off TEP-89 discovery.
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

            // [V5.0.3 FIX #4] REPLAY GUARD: Drop duplicate TakeWalletAddress
            // responses for the same pending_query_id. Prevents multiple
            // JettonTransfer dispatches caused by malicious/buggy masters.
            if (self.consumed_claim.get(self.pending_query_id) != null) { return; }

            // Mark claim as consumed BEFORE mutating state/sending (atomicity).
            self.consumed_claim.set(self.pending_query_id, true);

            // v5.0.1: cache the beneficiary's jetton wallet so the success
            // excesses it returns (TEP-74 copies response_destination into
            // internal_transfer) are accepted as settlement confirmation.
            self.beneficiary_wallet = msg.wallet_address;

            self.claimed = self.claimed + self.pending_amount;

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
    // ══════════════════════════════════════════════════════════════════

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
    // Claim settlement
    // ═══════════════════════════════════════════════════════════════════

    /// Jetton wallet's success callback. Resets `pending_claim` so future
    /// claims can proceed.
    ///
    /// v5.0.1 FIX (mainnet K1, exit 36235): TEP-74 copies response_destination
    /// into internal_transfer, so the RECEIVING-side jetton wallet (the
    /// beneficiary's) also returns excesses to this contract — and COGNIQ's
    /// sending-side wallet returns none. Accepting only `jetton_wallet` as
    /// sender reverted the only excess that ever arrived. We now accept
    /// excesses from either real wallet of the transfer chain. Sender cannot
    /// be spoofed (the chain sets it), so no new attack surface: a foreign
    /// sender still reverts on "not our wallet".
    ///
    /// AUDIT v5.0.0:
    /// After successful claim completion (when claimed == total_amount),
    /// this handler returns ALL remaining TON balance to the beneficiary
    /// and self-destructs the contract.
    ///
    /// Mode breakdown:
    ///   - SendRemainingBalance: send all remaining balance (not just value field)
    ///   - SendIgnoreErrors: ignore errors (if beneficiary address is invalid, just skip)
    ///   - DestroyIfZero: destroy this contract after sending (reclaim storage deposit)
    receive(msg: JettonExcesses) {
        let jw: Address? = self.jetton_wallet;
        let bw: Address? = self.beneficiary_wallet;
        let s: Address = sender();
        require(
            jw != null && (s == jw!! || (bw != null && s == bw!!)),
            "not our wallet"
        );

        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
            
            // [V5.0.3 FIX #4] CLEAR REPLAY GUARD on settlement.
            // Allows beneficiary to reuse qid in a future Claim without hitting stale guard.
            self.consumed_claim.set(msg.query_id, null);

            // AUDIT v5: If this was the final claim (all funds claimed),
            // sweep all remaining TON to beneficiary and self-destruct.
            if (self.claimed >= self.total_amount) {
                message(MessageParameters{
                    to: self.beneficiary,
                    value: 0,  // value=0 with SendRemainingBalance sends ALL balance
                    // Tact 1.6.13 does not expose a named constant for DestroyIfZero (TVM flag 32).
                   // SendRemainingBalance (128) and SendIgnoreErrors (2) have named constants.
                    mode: SendRemainingBalance | SendIgnoreErrors | 32,
                    body: emptyCell()
                });
            }
        }
    }

    /// Jetton transfer failed: roll back `claimed` and clear pending state.
    bounced(msg: bounced<JettonTransfer>) {
        // [V5.0.3 MINOR] Defense-in-depth: verify bounce origin matches our JW.
        // While TVM cryptographically binds bounce to outbound message, this
        // mirrors factory pattern and eliminates theoretical edge-case confusion.
        require(sender() == self.jetton_wallet, "bounce from wrong wallet");

        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            self.claimed = self.claimed - self.pending_amount;
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
            
            // [V5.0.3 FIX #4] CLEAR REPLAY GUARD on rollback.
            // Same rationale as excesses: allow qid reuse after failure.
            self.consumed_claim.set(msg.query_id, null);
            
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
    get fun beneficiaryWallet(): Address? { return self.beneficiary_wallet; }
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
    
    // [V5.0.3 NEW GETTER] Diagnostic access to replay guard state.
    get fun isClaimConsumed(qid: Int): Bool { 
        let val: Bool? = self.consumed_claim.get(qid);
        return val != null && val!!; 
    }
}
