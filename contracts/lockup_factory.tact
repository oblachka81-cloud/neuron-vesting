import "@stdlib/deploy";
import "./messages";
import "./lockup_wallet";

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

message(0x22) WithdrawTonFees {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
}

message(0x23) RescueTon {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
}

message(0x24) RescueJetton {
    query_id: Int as uint64;
    jetton_master: Address;
    amount: Int as coins;
    destination: Address;
}

message(0x25) SetFeeBps { query_id: Int as uint64; fee_bps: Int as uint16; }
message(0x26) SetFeeTon { query_id: Int as uint64; fee_ton: Int as coins; }

message(0x100) LockCreated {
    lock_id: Int as uint64;
    creator: Address;
    beneficiary: Address;
    jetton: Address;
    amount: Int as coins;
    unlock_at: Int as uint64;
}
message(0x106) TonFeeCollected { lock_id: Int as uint64; amount: Int as coins; }
message(0x107) FeesWithdrawn { query_id: Int as uint64; jetton_master: Address; amount: Int as coins; destination: Address; }
message(0x109) JettonWalletSet { jetton_master: Address; jetton_wallet: Address; }
message(0x111) LockCreationFailed { lock_id: Int as uint64; creator: Address; jetton: Address; amount: Int as coins; }
message(0x112) CreateBounced { lock_id: Int as uint64; amount: Int as coins; }
message(0x115) RefundRequired { creator: Address; jetton: Address; amount: Int as coins; }

const GAS_BUFFER_TON: Int = ton("0.6");
const DEPLOY_GAS: Int = ton("0.2");
const TRANSFER_GAS: Int = ton("0.3");
const RESCUE_GAS: Int = ton("0.3");
const MAX_LOCK_DURATION: Int = 315360000;
const CREATE_LOCK_OP: Int = 0x1;
const HIGH_BIT: Int = 1 << 63;
const MAX_FEE_BPS: Int = 1000;

contract LockupFactory {
    next_id: Int as uint64;
    treasury: Address;
    salt: Int as uint64;
    fee_bps: Int as uint16;
    fee_ton: Int as coins;

    own_wallets: map<Address, Address>;
    wallet_to_master: map<Address, Address>;
    ton_fees: Int as coins;
    used_qids: map<Int, Bool>;

    pending_create: map<Int, Address>;
    create_creator: map<Int, Address>;
    create_amount: map<Int, Int>;
    create_jetton: map<Int, Address>;
    create_fee_jetton: map<Int, Int>;
    create_fee_ton: map<Int, Int>;
    fees: map<Address, Int>;

    pending_withdraw: map<Int, Int>;
    pending_withdraw_jetton: map<Int, Address>;

    init(treasury: Address, salt: Int, fee_bps: Int, fee_ton: Int) {
        self.next_id = 1;
        self.treasury = treasury;
        self.salt = salt;
        self.fee_bps = fee_bps;
        self.fee_ton = fee_ton;
        self.ton_fees = 0;
    }

    receive(msg: SetJettonWallet) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        let cur: Address? = self.own_wallets.get(msg.jetton_master);
        require(cur == null || cur!! == msg.jetton_wallet, "already set");
        self.own_wallets.set(msg.jetton_master, msg.jetton_wallet);
        self.wallet_to_master.set(msg.jetton_wallet, msg.jetton_master);
        emit(JettonWalletSet{ jetton_master: msg.jetton_master, jetton_wallet: msg.jetton_wallet }.toCell());
    }

    receive(msg: SetFeeBps) {
        require(sender() == self.treasury, "not treasury");
        require(msg.fee_bps <= MAX_FEE_BPS, "max 10%");
        self.fee_bps = msg.fee_bps;
    }

    receive(msg: SetFeeTon) {
        require(sender() == self.treasury, "not treasury");
        self.fee_ton = msg.fee_ton;
    }

    receive(msg: JettonNotification) {
        let jm: Address? = self.wallet_to_master.get(sender());
        require(jm != null, "unknown wallet");
        let jetton_master: Address = jm!!;
        require(self.own_wallets.get(jetton_master) != null, "jetton not whitelisted");
        require(context().value >= self.fee_ton + GAS_BUFFER_TON, "attach fee+buffer");

        let sc: Slice = msg.forward_payload;
        if (sc.bits() > 0 && sc.loadBit()) {
            sc = sc.loadRef().beginParse();
        }

        if (sc.bits() < 694 || sc.preloadUint(32) != CREATE_LOCK_OP) {
            emit(LockCreationFailed{ lock_id: 0, creator: msg.sender, jetton: jetton_master, amount: msg.amount }.toCell());
            emit(RefundRequired{ creator: msg.sender, jetton: jetton_master, amount: msg.amount }.toCell());
            return;
        }

        sc.loadUint(32);
        let qid: Int = sc.loadUint(64);
        let jm_in: Address = sc.loadAddress();
        let ben: Address = sc.loadAddress();
        let unlock_at: Int = sc.loadUint(64);

        require(jm_in == jetton_master, "jm mismatch");
        require(unlock_at > now() && unlock_at <= now() + MAX_LOCK_DURATION, "bad date");
        require(qid > 0, "qid 0");

        let fee: Int = (msg.amount * self.fee_bps) / 10000;
        let lock_amount: Int = msg.amount - fee;
        require(lock_amount > 0, "too small");
        let creator: Address = msg.sender;

        let overpay: Int = context().value - self.fee_ton - GAS_BUFFER_TON;
        self.ton_fees = self.ton_fees + self.fee_ton;
        if (overpay > 0) {
            send(SendParameters{ to: creator, value: overpay, mode: SendPayGasSeparately, body: emptyCell() });
        }

        let curFee: Int? = self.fees.get(jetton_master);
        self.fees.set(jetton_master, (curFee != null ? curFee!! : 0) + fee);

        let id: Int = self.next_id;
        self.next_id = id + 1;

        let childInit: StateInit = initOf LockupWallet(
            id, myAddress(), jetton_master, ben, creator, lock_amount, unlock_at
        );
        let childAddr: Address = contractAddress(childInit);

        self.pending_create.set(id, childAddr);
        self.create_creator.set(id, creator);
        self.create_amount.set(id, lock_amount);
        self.create_jetton.set(id, jetton_master);
        self.create_fee_jetton.set(id, fee);
        self.create_fee_ton.set(id, self.fee_ton);

        send(SendParameters{
            to: childAddr,
            value: DEPLOY_GAS,
            mode: SendPayGasSeparately,
            code: childInit.code,
            data: childInit.data,
            body: StartDiscovery{ query_id: id }.toCell()
        });

        send(SendParameters{
            to: jetton_master,
            value: DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: id | HIGH_BIT,
                owner_address: childAddr,
                include_address: true
            }.toCell()
        });

        emit(LockCreated{ lock_id: id, creator: creator, beneficiary: ben, jetton: jetton_master, amount: lock_amount, unlock_at: unlock_at }.toCell());
        emit(TonFeeCollected{ lock_id: id, amount: self.fee_ton }.toCell());
    }

    receive(msg: TakeWalletAddress) {
        let qid: Int = msg.query_id;
        if ((qid & HIGH_BIT) == 0) { return; }
        let id: Int = qid & (HIGH_BIT - 1);
        let child: Address? = self.pending_create.get(id);
        if (child == null) { return; }
        require(msg.owner_address == child!!, "wrong owner");

        let jmOpt: Address? = self.create_jetton.get(id);
        require(jmOpt != null && sender() == jmOpt!!, "not master");

        let amountOpt: Int? = self.create_amount.get(id);
        require(amountOpt != null, "no amount");

        let jwOpt: Address? = self.own_wallets.get(jmOpt!!);
        require(jwOpt != null, "no factory wallet");

        send(SendParameters{
            to: jwOpt!!,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: qid,
                amount: amountOpt!!,
                destination: msg.wallet_address,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: ton("0.15"),
                forward_payload: emptySlice()
            }.toCell()
        });
    }

    receive(msg: WithdrawFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        require(msg.amount > 0, "zero");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        let curOpt: Int? = self.fees.get(msg.jetton_master);
        let cur: Int = curOpt != null ? curOpt!! : 0;
        require(cur >= msg.amount, "not enough fees");

        let jw: Address? = self.own_wallets.get(msg.jetton_master);
        require(jw != null, "not whitelisted");

        self.used_qids.set(msg.query_id, true);
        self.fees.set(msg.jetton_master, cur - msg.amount);
        self.pending_withdraw.set(msg.query_id, msg.amount);
        self.pending_withdraw_jetton.set(msg.query_id, msg.jetton_master);

        send(SendParameters{
            to: jw!!,
            value: TRANSFER_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: msg.amount,
                destination: msg.destination_wallet,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: ton("0.05"),
                forward_payload: emptySlice()
            }.toCell()
        });

        emit(FeesWithdrawn{
            query_id: msg.query_id,
            jetton_master: msg.jetton_master,
            amount: msg.amount,
            destination: msg.destination_wallet
        }.toCell());
    }

    bounced(msg: bounced<JettonTransfer>) {
        let qid: Int = msg.query_id;

        if ((qid & HIGH_BIT) != 0) {
            let id: Int = qid & (HIGH_BIT - 1);
            let child: Address? = self.pending_create.get(id);
            if (child == null) { return; }

            let jmOpt: Address? = self.create_jetton.get(id);
            let creatorOpt: Address? = self.create_creator.get(id);
            let amountOpt: Int? = self.create_amount.get(id);
            let feeOpt: Int? = self.create_fee_jetton.get(id);
            let tonOpt: Int? = self.create_fee_ton.get(id);

            require(jmOpt != null && creatorOpt != null && amountOpt != null && feeOpt != null && tonOpt != null, "inconsistent create state");

            let jm: Address = jmOpt!!;
            let creator: Address = creatorOpt!!;
            let amount: Int = amountOpt!!;
            let fee: Int = feeOpt!!;
            let charged_ton: Int = tonOpt!!;

            let jwOpt: Address? = self.own_wallets.get(jm);
            require(jwOpt != null, "no factory wallet");
            require(sender() == jwOpt!!, "bounce from wrong wallet");

            let curFeeOpt: Int? = self.fees.get(jm);
            let curFee: Int = curFeeOpt != null ? curFeeOpt!! : 0;
            self.fees.set(jm, curFee > fee ? curFee - fee : 0);

            if (self.ton_fees >= charged_ton) {
                self.ton_fees = self.ton_fees - charged_ton;
                send(SendParameters{ to: creator, value: charged_ton, mode: SendPayGasSeparately, body: emptyCell() });
            }

            emit(CreateBounced{ lock_id: id, amount: amount }.toCell());
            emit(RefundRequired{ creator: creator, jetton: jm, amount: amount + fee }.toCell());

            self.pending_create.set(id, null);
            self.create_creator.set(id, null);
            self.create_amount.set(id, null);
            self.create_jetton.set(id, null);
            self.create_fee_jetton.set(id, null);
            self.create_fee_ton.set(id, null);
            return;
        }

        let amtOpt: Int? = self.pending_withdraw.get(qid);
        let jmOpt: Address? = self.pending_withdraw_jetton.get(qid);
        if (amtOpt != null && jmOpt != null) {
            let jm: Address = jmOpt!!;
            let jwOpt: Address? = self.own_wallets.get(jm);
            require(jwOpt != null, "no factory wallet");
            require(sender() == jwOpt!!, "withdraw bounce from wrong wallet");

            let opt: Int? = self.fees.get(jm);
            let cur: Int = opt != null ? opt!! : 0;
            self.fees.set(jm, cur + amtOpt!!);

            self.pending_withdraw.set(qid, null);
            self.pending_withdraw_jetton.set(qid, null);
        }
    }

    receive(msg: WithdrawTonFees) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0 && msg.amount > 0, "bad args");
        require(self.ton_fees >= msg.amount, "not enough");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");
        self.used_qids.set(msg.query_id, true);
        self.ton_fees = self.ton_fees - msg.amount;
        send(SendParameters{ to: msg.destination, value: msg.amount, mode: SendPayGasSeparately, body: emptyCell() });
    }

    receive(msg: RescueTon) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        require(msg.amount > 0, "zero");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        let reserved: Int = self.ton_fees + ton("0.05");
        let available: Int = myBalance() - reserved;
        require(available >= msg.amount, "not enough after reserving fees");

        self.used_qids.set(msg.query_id, true);

        send(SendParameters{ to: msg.destination, value: msg.amount, mode: SendPayGasSeparately, body: emptyCell() });
    }

    receive(msg: RescueJetton) {
        require(sender() == self.treasury, "not treasury");
        require(msg.query_id > 0, "qid 0");
        require(msg.amount > 0, "zero");
        require(self.used_qids.get(msg.query_id) == null, "qid reused");

        let jw: Address? = self.own_wallets.get(msg.jetton_master);
        require(jw != null, "not whitelisted");

        self.used_qids.set(msg.query_id, true);

        send(SendParameters{
            to: jw!!,
            value: RESCUE_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: msg.query_id,
                amount: msg.amount,
                destination: msg.destination,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: ton("0.05"),
                forward_payload: emptySlice()
            }.toCell()
        });
    }

    receive() { }

    get fun nextLockId(): Int { return self.next_id; }
    get fun feeBps(): Int { return self.fee_bps; }
    get fun feeTon(): Int { return self.fee_ton; }
    get fun tonFees(): Int { return self.ton_fees; }
    get fun feeOf(jetton: Address): Int {
        let opt: Int? = self.fees.get(jetton);
        return opt != null ? opt!! : 0;
    }
    get fun isWalletSet(jetton: Address): Bool { return self.own_wallets.get(jetton) != null; }
    get fun walletOf(jetton: Address): Address? { return self.own_wallets.get(jetton); }
    get fun pendingCreateOf(lockId: Int): Address? { return self.pending_create.get(lockId); }
}
