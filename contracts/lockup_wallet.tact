// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — LockupWallet v2.6.1 (Final)
// ───────────────────────────────────────────────────────────────────────────
// One instance per lock. Holds jettons, enforces unlock schedule, releases
// to beneficiary. Non-custodial: neither creator nor factory can withdraw.
//
// Invariants:
//   I1. claimed ∈ [0, total_amount]
//   I2. available = total_amount - claimed ≥ 0
//   I3. at most one claim in-flight (pending_claim == true)
//   I4. jetton_wallet is provided at deploy time by the factory
//   I5. only beneficiary can claim / reset pending
//   I6. creator can only push unlock_at forward, while still locked
//   I7. bounce restores accounting ONLY if query_id matches in-flight claim
//   I8. total_amount is immutable — no top-ups change it
//   I9. claim requires funded == true
//
// Known limitations:
//   L1. ResetPendingClaim does NOT roll back `claimed`. If a pending transfer
//       failed silently (bounce lost) after reset, those jettons stay on the
//       contract's jetton wallet, unaccounted and unrecoverable.
//   L2. Non-factory jetton deposits are accepted but ignored (emitted as
//       UnexpectedDeposit). They stay on our jetton wallet, unaccounted.
//   L3. total_amount is fixed at deploy. No top-ups extend it.
// ═══════════════════════════════════════════════════════════════════════════

import "@stdlib/deploy";
import "./messages";

// ═══════════════════════════════════════════════════════════════════════════
// Vesting messages
// ═══════════════════════════════════════════════════════════════════════════

message(0x10) Claim {
    query_id: Int as uint64;
    amount: Int as coins;      // 0 = claim all currently available
}

message(0x11) Extend {
    query_id: Int as uint64;
    new_unlock_at: Int as uint64;
}

message(0x12) ResetPendingClaim {
    query_id: Int as uint64;
}

// ═══════════════════════════════════════════════════════════════════════════
// Events (wallet range 0x120-0x13F to avoid collision with factory)
// ═══════════════════════════════════════════════════════════════════════════

message(0x101) Claimed {
    lock_id: Int as uint64;
    amount: Int as coins;
    beneficiary: Address;
    query_id: Int as uint64;
}

message(0x102) Extended {
    lock_id: Int as uint64;
    old_unlock_at: Int as uint64;
    new_unlock_at: Int as uint64;
}

message(0x105) ClaimBounced {
    lock_id: Int as uint64;
    amount: Int as coins;
    query_id: Int as uint64;
}

message(0x120) PendingClaimReset {
    lock_id: Int as uint64;
    amount: Int as coins;
    query_id: Int as uint64;
}

message(0x121) StaleBounceIgnored {
    lock_id: Int as uint64;
    query_id: Int as uint64;
    pending_query_id: Int as uint64;
}

message(0x122) LockFunded {
    lock_id: Int as uint64;
    amount: Int as coins;
    query_id: Int as uint64;
}

message(0x123) UnexpectedDeposit {
    lock_id: Int as uint64;
    sender: Address;
    amount: Int as coins;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const MAX_EXTEND_HORIZON: Int = 315360000;   // 10 years
const CLAIM_GAS: Int = ton("0.07");
const PENDING_TIMEOUT: Int = 21600;          // 6 hours

// ═══════════════════════════════════════════════════════════════════════════
// Contract
// ═══════════════════════════════════════════════════════════════════════════

contract LockupWallet {
    lock_id: Int as uint64;
    factory: Address;
    jetton_master: Address;
    jetton_wallet: Address;
    beneficiary: Address;
    creator: Address;

    total_amount: Int as coins;
    claimed: Int as coins;
    unlock_at: Int as uint64;
    created_at: Int as uint64;

    last_claim: Int as coins;
    pending_claim: Bool;
    pending_since: Int as uint64;
    pending_query_id: Int as uint64;

    funded: Bool;

    init(
        lock_id: Int,
        factory: Address,
        jetton_master: Address,
        jetton_wallet: Address,
        beneficiary: Address,
        creator: Address,
        total_amount: Int,
        unlock_at: Int
    ) {
        self.lock_id = lock_id;
        self.factory = factory;
        self.jetton_master = jetton_master;
        self.jetton_wallet = jetton_wallet;
        self.beneficiary = beneficiary;
        self.creator = creator;
        self.total_amount = total_amount;
        self.claimed = 0;
        self.unlock_at = unlock_at;
        self.created_at = now();
        self.last_claim = 0;
        self.pending_claim = false;
        self.pending_since = 0;
        self.pending_query_id = 0;
        self.funded = false;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Deposits
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: JettonNotification) {
        require(sender() == self.jetton_wallet, "not our jetton wallet");

        if (!self.funded && msg.amount == self.total_amount) {
            self.funded = true;
            emit(LockFunded{
                lock_id: self.lock_id,
                amount: msg.amount,
                query_id: msg.query_id
            }.toCell());
            return;
        }

        emit(UnexpectedDeposit{
            lock_id: self.lock_id,
            sender: msg.sender,
            amount: msg.amount
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Claim
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: Claim) {
        require(sender() == self.beneficiary, "not beneficiary");
        require(self.funded, "lock not funded");
        require(now() >= self.unlock_at, "still locked");
        require(!self.pending_claim, "claim in flight");
        require(msg.query_id > 0, "query_id must be > 0");

        let available: Int = self.total_amount - self.claimed;
        require(available > 0, "nothing to claim");

        let want: Int = msg.amount;
        if (want == 0) {
            want = available;
        }
        require(want > 0, "zero amount");
        require(want <= available, "exceeds available");

        self.last_claim = want;
        self.claimed = self.claimed + want;
        self.pending_claim = true;
        self.pending_since = now();
        self.pending_query_id = msg.query_id;

        send(SendParameters{
            to: self.jetton_wallet,
            value: CLAIM_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: want,
                destination: self.beneficiary,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });

        emit(Claimed{
            lock_id: self.lock_id,
            amount: want,
            beneficiary: self.beneficiary,
            query_id: msg.query_id
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Extend (creator-only, forward-only, while still locked)
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: Extend) {
        require(sender() == self.creator, "not creator");
        require(now() < self.unlock_at, "already unlocked");
        require(msg.new_unlock_at > self.unlock_at, "only forward");
        require(msg.new_unlock_at <= now() + MAX_EXTEND_HORIZON, "too far");

        let old: Int = self.unlock_at;
        self.unlock_at = msg.new_unlock_at;

        emit(Extended{
            lock_id: self.lock_id,
            old_unlock_at: old,
            new_unlock_at: msg.new_unlock_at
        }.toCell());
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Reset stuck pending claim (does NOT roll back claimed — see L1)
    // ═══════════════════════════════════════════════════════════════════════

    receive(msg: ResetPendingClaim) {
        require(sender() == self.beneficiary, "not beneficiary");
        require(self.pending_claim, "no pending claim");
        require(now() >= self.pending_since + PENDING_TIMEOUT, "timeout not reached");

        emit(PendingClaimReset{
            lock_id: self.lock_id,
            amount: self.last_claim,
            query_id: self.pending_query_id
        }.toCell());

        self.last_claim = 0;
        self.pending_claim = false;
        self.pending_since = 0;
        self.pending_query_id = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Bounce handler (I7)
    // ═══════════════════════════════════════════════════════════════════════

    bounced(msg: bounced<JettonTransfer>) {
        require(sender() == self.jetton_wallet, "not our wallet");

        if (!self.pending_claim) {
            emit(StaleBounceIgnored{
                lock_id: self.lock_id,
                query_id: msg.query_id,
                pending_query_id: self.pending_query_id
            }.toCell());
            return;
        }

        if (msg.query_id != self.pending_query_id) {
            emit(StaleBounceIgnored{
                lock_id: self.lock_id,
                query_id: msg.query_id,
                pending_query_id: self.pending_query_id
            }.toCell());
            return;
        }

        self.claimed = self.claimed - self.last_claim;

        emit(ClaimBounced{
            lock_id: self.lock_id,
            amount: self.last_claim,
            query_id: msg.query_id
        }.toCell());

        self.last_claim = 0;
        self.pending_claim = false;
        self.pending_since = 0;
        self.pending_query_id = 0;
    }

    receive() { }

    // ═══════════════════════════════════════════════════════════════════════
    // Getters
    // ═══════════════════════════════════════════════════════════════════════

    get fun lockId(): Int { return self.lock_id; }
    get fun factory(): Address { return self.factory; }
    get fun jettonMaster(): Address { return self.jetton_master; }
    get fun jettonWallet(): Address { return self.jetton_wallet; }
    get fun beneficiary(): Address { return self.beneficiary; }
    get fun creator(): Address { return self.creator; }
    get fun totalAmount(): Int { return self.total_amount; }
    get fun claimedAmount(): Int { return self.claimed; }
    get fun available(): Int { return self.total_amount - self.claimed; }
    get fun availableClaimable(): Int {
        if (!self.funded) { return 0; }
        if (self.pending_claim) { return 0; }
        if (now() < self.unlock_at) { return 0; }
        return self.total_amount - self.claimed;
    }
    get fun unlockAt(): Int { return self.unlock_at; }
    get fun createdAt(): Int { return self.created_at; }
    get fun isPending(): Bool { return self.pending_claim; }
    get fun pendingSince(): Int { return self.pending_since; }
    get fun pendingQueryId(): Int { return self.pending_query_id; }
    get fun lastClaimAmount(): Int { return self.last_claim; }
    get fun isFunded(): Bool { return self.funded; }
}
