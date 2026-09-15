// LockupWallet — holds locked tokens for a single lock
// Enforces unlock schedule and allows beneficiary to claim

import "@stdlib/deploy";

// Messages
message(0x10) Claim {
    query_id: Int as uint64;
}

message(0x11) Extend {
    new_unlock_at: Int as uint64;
}

message(0x2) DeployLock {
    jetton_master: Address;
    beneficiary: Address;
    total_amount: Int as coins;
    unlock_at: Int as uint64;
    creator: Address;
}

message(0x178d4519) ReceiveJetton {
    query_id: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forward_payload: Cell;
}

// LockupWallet contract
contract LockupWallet {
    lock_id: Int as uint64;
    jetton_master: Address;
    beneficiary: Address;
    creator: Address;
    total_amount: Int as coins;
    claimed: Int as coins;
    unlock_at: Int as uint64;
    created_at: Int as uint64;

    init(lock_id: Int) {
        self.lock_id = lock_id;
        self.jetton_master = newAddress(0, 0); // placeholder
        self.beneficiary = newAddress(0, 0);
        self.creator = newAddress(0, 0);
        self.total_amount = 0;
        self.claimed = 0;
        self.unlock_at = 0;
        self.created_at = 0;
    }

    // Initialize wallet from factory
    receive(msg: DeployLock) {
        require(self.jetton_master == newAddress(0, 0), "Already initialized");
        
        self.jetton_master = msg.jetton_master;
        self.beneficiary = msg.beneficiary;
        self.creator = msg.creator;
        self.total_amount = msg.total_amount;
        self.unlock_at = msg.unlock_at;
        self.created_at = now();
    }

    // Handle incoming jettons (TEP-74 standard)
    receive(msg: ReceiveJetton) {
        // Jettons received, nothing to do here
        // The amount should match what was promised during creation
    }

    // Claim unlocked tokens
    receive(msg: Claim) {
        require(sender() == self.beneficiary, "Not beneficiary");
        require(now() >= self.unlock_at, "Still locked");
        
        let available: Int = self.total_amount - self.claimed;
        require(available > 0, "Nothing to claim");

        // Update state
        self.claimed = self.total_amount;

        // TODO: Send jetton transfer to beneficiary
        // This requires jetton wallet interaction, implement in next iteration

        // Emit event
        emit Claimed(self.lock_id, available, self.beneficiary);
    }

    // Extend unlock date (creator only, forward only)
    receive(msg: Extend) {
        require(sender() == self.creator, "Not creator");
        require(msg.new_unlock_at > self.unlock_at, "Can only extend forward");
        require(msg.new_unlock_at <= now() + 365 * 24 * 60 * 60 * 10, "Max 10 years");

        let old_unlock: Int = self.unlock_at;
        self.unlock_at = msg.new_unlock_at;

        emit Extended(self.lock_id, old_unlock, msg.new_unlock_at);
    }

    // Getters
    get fun lock_info(): (Int, Address, Address, Int, Int, Int, Int) {
        return (
            self.lock_id,
            self.jetton_master,
            self.beneficiary,
            self.total_amount,
            self.claimed,
            self.unlock_at,
            self.created_at
        );
    }
}

// Events
event Claimed(lock_id: Int, amount: Int, beneficiary: Address);
event Extended(lock_id: Int, old_unlock_at: Int, new_unlock_at: Int);
