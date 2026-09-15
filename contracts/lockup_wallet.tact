// NEURON Vesting — shared types + LockupWallet
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

// ===== Vesting messages =====
message(0x1) CreateLock {
    query_id: Int as uint64;
    jetton_master: Address;
    beneficiary: Address;
    creator: Address;
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
    }

    // Learn our own jetton wallet address on first deposit
    receive(msg: JettonNotification) {
        if (self.jetton_wallet == null) {
            self.jetton_wallet = sender();
        }
    }

    // Beneficiary claims after unlock
    receive(msg: Claim) {
        require(sender() == self.beneficiary, "not beneficiary");
        require(now() >= self.unlock_at, "still locked");
        let available: Int = self.total_amount - self.claimed;
        require(available > 0, "nothing to claim");
        let jw: Address = self.jetton_wallet!!;
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
        emit(Claimed{ lock_id: self.lock_id, amount: available, beneficiary: self.beneficiary });
    }

    // Creator can only push the unlock date forward
    receive(msg: Extend) {
        require(sender() == self.creator, "not creator");
        require(msg.new_unlock_at > self.unlock_at, "only forward");
        require(msg.new_unlock_at <= now() + 315360000, "too far");
        let old: Int = self.unlock_at;
        self.unlock_at = msg.new_unlock_at;
        emit(Extended{ lock_id: self.lock_id, old_unlock_at: old, new_unlock_at: msg.new_unlock_at });
    }

    // Plain TON top-ups
    receive() { }

    get fun info(): (Int, Address, Address, Address, Int, Int, Int, Int) {
        return (self.lock_id, self.jetton_master, self.beneficiary, self.creator, self.total_amount, self.claimed, self.unlock_at, self.created_at);
    }
}
