// NEURON Vesting — factory v2: whitelisted jettons, creator from notification, bounce-safe

import "@stdlib/deploy";
import "./lockup_wallet";

contract LockupFactory {
    next_id: Int as uint64;
    treasury: Address;
    fees: map<Address, Int>;
    own_wallets: map<Address, Address>;
    pending_withdraw: Int as coins;
    pending_jetton: Address?;

    init(treasury: Address) {
        self.next_id = 1;
        self.treasury = treasury;
        self.pending_withdraw = 0;
        self.pending_jetton = null;
    }

    // Treasury approves a jetton: registers factory's jetton wallet for this master
    receive(msg: SetJettonWallet) {
        require(sender() == self.treasury, "not treasury");
        self.own_wallets.set(msg.jetton_master, msg.jetton_wallet);
    }

    // Jettons arrived with a CreateLock payload
    receive(msg: JettonNotification) {
        let sc: Slice = msg.forward_payload;
        if (sc.loadBit()) {
            sc = sc.loadRef().beginParse();
        }
        require(sc.loadUint(32) == 0x1, "wrong op");
        let qid: Int = sc.loadUint(64);
        let jm: Address = sc.loadAddress();
        let ben: Address = sc.loadAddress();
        let unlock_at: Int = sc.loadUint(64);
        require(unlock_at > now(), "past date");

        // v2: only whitelisted jetton, and only from its registered factory wallet
        let known: Address? = self.own_wallets.get(jm);
        require(known != null, "jetton not approved");
        require(known!! == sender(), "wrong wallet");

        let fee: Int = (msg.amount * 50) / 10000;
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");

        // v2: creator = real jetton owner from notification, not a payload field
        let creator: Address = msg.sender;

        let currentFee: Int? = self.fees.get(jm);
        self.fees.set(jm, (currentFee != null ? currentFee!! : 0) + fee);

        let id: Int = self.next_id;
        self.next_id = id + 1;

        let childInit: StateInit = initOf LockupWallet(id, myAddress(), jm, ben, creator, lock_amount, unlock_at);
        let childAddr: Address = contractAddress(childInit);

        send(SendParameters{
            to: childAddr,
            value: ton("0.1"),
            mode: SendPayGasSeparately,
            code: childInit.code,
            data: childInit.data,
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

        emit(LockCreated{
            lock_id: id,
            creator: creator,
            beneficiary: ben,
            jetton: jm,
            amount: lock_amount,
            unlock_at: unlock_at
        }.toCell());
    }

    // Treasury withdraws accumulated jetton fees
    receive(msg: WithdrawFees) {
        require(sender() == self.treasury, "not treasury");
        let cur: Int? = self.fees.get(msg.jetton_master);
        require(cur != null, "no fees yet");
        require(cur!! >= msg.amount, "not enough fees");
        self.fees.set(msg.jetton_master, cur!! - msg.amount);
        self.pending_withdraw = msg.amount;
        self.pending_jetton = msg.jetton_master;
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

    // Withdraw transfer bounced: restore fee balance from our own fields
    bounced(msg: bounced<JettonTransfer>) {
        if (self.pending_jetton != null) {
            let jm: Address = self.pending_jetton!!;
            let cur: Int? = self.fees.get(jm);
            self.fees.set(jm, (cur != null ? cur!! : 0) + self.pending_withdraw);
            emit(WithdrawBounced{ query_id: 0, amount: self.pending_withdraw }.toCell());
            self.pending_withdraw = 0;
            self.pending_jetton = null;
        }
    }

    receive() { }

    get fun nextLockId(): Int { return self.next_id; }
    get fun feeOf(jetton: Address): Int {
        let f: Int? = self.fees.get(jetton);
        return f != null ? f!! : 0;
    }
    get fun treasuryAddress(): Address { return self.treasury; }
    get fun walletOf(jetton: Address): Address? { return self.own_wallets.get(jetton); }
}
