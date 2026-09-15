// LockupFactory — singleton factory for NEURON Vesting
// Deploys LockupWallet instances and collects platform fees

import "@stdlib/deploy";
import "./lockup_wallet";

// Messages
message(0x1) CreateLock {
    jetton_master: Address;
    beneficiary: Address;
    unlock_at: Int as uint64;
    query_id: Int as uint64;
}

message(0x7362d09c) JettonNotification {
    query_id: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forward_payload: Cell;
}

message(0x2) DeployLock {
    jetton_master: Address;
    beneficiary: Address;
    total_amount: Int as coins;
    unlock_at: Int as uint64;
    creator: Address;
}

// Constants
const FEE_BPS: Int = 50; // 0.5% = 50 basis points
const MIN_LOCK_AMOUNT: Int = 1000000000; // 1 jetton in nano (9 decimals)
const MAX_LOCK_PERCENT: Int = 10; // max 10% of supply

// Factory contract
contract LockupFactory with Deployable {
    lock_id: Int as uint64;
    treasury: Address;
    total_fees: Int as coins;

    init(treasury: Address) {
        self.lock_id = 0;
        self.treasury = treasury;
        self.total_fees = 0;
    }

    // Handle jetton notification from jetton wallet
    receive(msg: JettonNotification) {
        // Parse forward payload as CreateLock
        let create_lock: CreateLock = msg.forward_payload.parse(
            (b: Slice) => {
                let opcode: Int = b.loadUint(32);
                require(opcode == 0x1, "Invalid opcode");
                return CreateLock{
                    jetton_master: b.loadAddress(),
                    beneficiary: b.loadAddress(),
                    unlock_at: b.loadUint(64),
                    query_id: b.loadUint(64)
                };
            }
        );

        // Validate parameters
        require(msg.amount >= MIN_LOCK_AMOUNT, "Amount too small");
        require(create_lock.unlock_at > now(), "Unlock must be in the future");

        // Calculate fee
        let fee: Int = (msg.amount * FEE_BPS) / 10000;
        let lock_amount: Int = msg.amount - fee;

        // Update state
        self.lock_id += 1;
        self.total_fees += fee;

        // Deploy LockupWallet
        let wallet: LockupWallet = contractLockupWallet(self.lock_id);
        send(SendParameters{
            to: wallet,
            value: ton("0.1"),
            mode: SendPayGasSeparately,
            body: DeployLock{
                jetton_master: create_lock.jetton_master,
                beneficiary: create_lock.beneficiary,
                total_amount: lock_amount,
                unlock_at: create_lock.unlock_at,
                creator: msg.sender
            }.toCell()
        });

        // Send fee to treasury
        send(SendParameters{
            to: self.treasury,
            value: fee,
            mode: SendPayGasSeparately
        });

        // Emit event
        emit LockCreated(
            self.lock_id,
            msg.sender,
            create_lock.beneficiary,
            create_lock.jetton_master,
            lock_amount,
            create_lock.unlock_at
        );
    }

    // Getters
    get fun lock_id(): Int {
        return self.lock_id;
    }

    get fun total_fees(): Int {
        return self.total_fees;
    }
}

// Events
event LockCreated(lock_id: Int, creator: Address, beneficiary: Address, jetton: Address, amount: Int, unlock_at: Int);
