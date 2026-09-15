// NEURON Vesting — factory: deploys lockup wallets, collects platform fees
import "@stdlib/deploy";
import "./lockup_wallet";

contract LockupFactory {
    next_id: Int as uint64;
    treasury: Address;
    fees: map<Address, Int>;
    own_wallets: map<Address, Address>;

    init(treasury: Address) {
        self.next_id = 1;
        self.treasury = treasury;
    }

    // Jettons arrived with a CreateLock payload
    receive(msg: JettonNotification) {
        let sc: Slice = msg.forward_payload;
        require(sc.loadUint(32) == 0x1, "wrong op");
        let qid: Int = sc.loadUint(64);
        let jm: Address = sc.loadAddress();
        let ben: Address = sc.loadAddress();
        let creator: Address = sc.loadAddress();
        let unlock_at: Int = sc.loadUint(64);

        require(unlock_at > now(), "past date");

        let fee: Int = (msg.amount * 50) / 10000;
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");

        let known: Address? = self.own_wallets.get(jm);
        if (known == null) {
            self.own_wallets.set(jm, sender());
        } else {
            require(known!! == sender(), "wrong wallet");
        }

        self.fees.set(jm, (self.fees.get(jm) ?? 0) + fee);

        let id: Int = self.next_id;
        self.next_id = id + 1;

        let childInit: StateInit = initOf LockupWallet(id, myAddress(), jm, ben, creator, lock_amount, unlock_at);
        let childAddr: Address = contractAddress(childInit);

        send(SendParameters{
            to: childAddr,
            value: ton("0.1"),
            mode: SendPayGasSeparately,
            init: childInit,
            body: emptyCell()
        });

        send(SendParameters{
            to: sender(),
            value: ton("0.06"),
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: qid,
                amount: lock_amount,
                destination: childAddr,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });

        emit(LockCreated{ lock_id: id, creator: creator, beneficiary: ben, jetton: jm, amount: lock_amount, unlock_at: unlock_at });
    }

    // Treasury withdraws accumulated jetton fees
    receive(msg: WithdrawFees) {
        require(sender() == self.treasury, "not treasury");
        let cur: Int = self.fees.get(msg.jetton_master) ?? 0;
        require(cur >= msg.amount, "not enough fees");
        self.fees.set(msg.jetton_master, cur - msg.amount);
        let jw: Address = self.own_wallets.get(msg.jetton_master)!!;
        send(SendParameters{
            to: jw,
            value: ton("0.06"),
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: msg.amount,
                destination: msg.destination_wallet,
                response_destination: self.treasury,
                custom_payload: null,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell()
        });
    }

    receive() { }

    get fun nextLockId(): Int { return self.next_id; }
    get fun feeOf(jetton: Address): Int { return self.fees.get(jetton) ?? 0; }
    get fun treasuryAddress(): Address { return self.treasury; }
}
