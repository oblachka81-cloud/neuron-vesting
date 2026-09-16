// NEURON Vesting — shared types + LockupWallet (v2: verified jetton wallet, bounce-safe)

import "@stdlib/deploy";

// ===== TEP-74 jetton messages =====
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

// ===== TEP-89 wallet discovery =====
message(0x2c76b973) ProvideWalletAddress {
    query_id: Int as uint64;
    owner: Address;
    include_address: Bool;
}

message(0xd1735400) WalletAddressInfo {
    query_id: Int as uint64;
    wallet: Address;
    owner: Address;
}

// ===== Vesting messages =====
message(0x1) CreateLock {
    query_id: Int as uint64;
    jetton_master: Address;
    beneficiary: Address;
    unlock_at: Int as uint64;
}

message(0x10) Claim {
    query_id: Int as uint64;
}

message(0x11) Extend {
    query_id: Int as uint64;
    new_unlock_at: Int as uint64;
}

message(0x20) WithdrawFees {
    query_id: Int as uint64;
    jetton_master: Address;
    destination_wallet: Address;
    amount: Int as coins;
}

message(0x21) SetJettonWallet {
    query_id: Int as uint64;
    jetton_master: Address;
    jetton_wallet: Address;
}

// ===== Events =====
message(0x100) LockCreated {
    lock_id: Int as uint64;
    creator: Address;
    beneficiary: Address;
    jetton: Address;
    amount: Int as coins;
    unlock_at: Int as uint64;
}

message(0x101) Claimed {
    lock_id: Int as uint64;
    amount: Int as coins;
    beneficiary: Address;
}

message(0x102) Extended {
    lock_id: Int as uint64;
    old_unlock_at: Int as uint64;
    new_unlock_at: Int as uint64;
}

message(0x103) WalletVerified {
    lock_id: Int as uint64;
    wallet: Address;
}

message(0x104) WithdrawBounced {
    query_id: Int as uint64;
    amount: Int as coins;
}

message(0x105) ClaimBounced {
    lock_id: Int as uint64;
    amount: Int as coins;
}

// ===== LockupWallet: one per lock, holds the tokens =====
contract LockupWallet {
    lock_id: Int as uint64;
    factory: Address;
    jetton_master: Address;
    beneficiary: Address;
    creator: Address;
    total_amount: Int as coins;
    claimed: Int as coins;
    unlock_at: Int as uint64;
    created_at: Int as uint64;
    jetton_wallet: Address?;
    asked: Bool;
    last_claim: Int as coins;

    init(
        lock_id: Int as uint64,
        factory: Address,
        jetton_master: Address,
        beneficiary: Address,
        creator: Address,
        total_amount: Int as coins,
        unlock_at: Int as uint64
    ) {
        self.lock_id = lock_id;
        self.factory = factory;
        self.jetton_master = jetton_master;
        self.beneficiary = beneficiary;
        self.creator = creator;
        self.total_amount = total_amount;
        self.claimed = 0;
        self.unlock_at = unlock_at;
        self.created_at = now();
        self.jetton_wallet = null;
        self.asked = false;
        self.last_claim = 0;
    }

    // Deposits: never trust notification sender. Ask the master instead.
    receive(msg: JettonNotification) {
        if (self.jetton_wallet != null) {
            require(sender() == self.jetton_wallet!!, "wrong wallet");
            return;
        }
        if (!self.asked) {
            self.asked = true;
            send(SendParameters{
                to: self.jetton_master,
                value: ton("0.08"),
                mode: SendPayGasSeparately,
                body: ProvideWalletAddress{ query_id: 0, owner: myAddress(), include_address: true }.toCell()
            });
        }
    }

    // Only the master itself can answer this
    receive(msg: WalletAddressInfo) {
        require(sender() == self.jetton_master, "not master");
        require(msg.owner == myAddress(), "wrong owner");
        if (self.jetton_wallet == null) {
            self.jetton_wallet = msg.wallet;
            emit(WalletVerified{ lock_id: self.lock_id, wallet: msg.wallet }.toCell());
        }
    }

    // Beneficiary claims after unlock
    receive(msg: Claim) {
        require(sender() == self.beneficiary, "not beneficiary");
        require(now() >= self.unlock_at, "still locked");
        require(self.jetton_wallet != null, "wallet not verified");
        let available: Int = self.total_amount - self.claimed;
        require(available > 0, "nothing to claim");
        let jw: Address = self.jetton_wallet!!;
        self.last_claim = available;
        self.claimed = self.total_amount;
        send(SendParameters{
            to: jw,
            value: ton("0.05"),
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: available,
                destination: self.beneficiary,
                response_destination: self.beneficiary,
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });
        emit(Claimed{ lock_id: self.lock_id, amount: available, beneficiary: self.beneficiary }.toCell());
    }

    // Creator can only push the unlock date forward
    receive(msg: Extend) {
        require(sender() == self.creator, "not creator");
        require(msg.new_unlock_at > self.unlock_at, "only forward");
        require(msg.new_unlock_at <= now() + 315360000, "too far");
        let old: Int = self.unlock_at;
        self.unlock_at = msg.new_unlock_at;
        emit(Extended{ lock_id: self.lock_id, old_unlock_at: old, new_unlock_at: msg.new_unlock_at }.toCell());
    }

    // Claim transfer bounced: restore from our own field, not from truncated msg
    bounced(msg: bounced<JettonTransfer>) {
        self.claimed = self.claimed - self.last_claim;
        emit(ClaimBounced{ lock_id: self.lock_id, amount: self.last_claim }.toCell());
        self.last_claim = 0;
    }

    // Plain TON top-ups
    receive() { }

    get fun lockId(): Int { return self.lock_id; }
    get fun jettonMaster(): Address { return self.jetton_master; }
    get fun beneficiary(): Address { return self.beneficiary; }
    get fun creator(): Address { return self.creator; }
    get fun totalAmount(): Int { return self.total_amount; }
    get fun claimedAmount(): Int { return self.claimed; }
    get fun unlockAt(): Int { return self.unlock_at; }
    get fun createdAt(): Int { return self.created_at; }
    get fun jettonWallet(): Address? { return self.jetton_wallet; }
}
