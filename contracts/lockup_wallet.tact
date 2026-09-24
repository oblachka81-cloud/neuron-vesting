import "@stdlib/deploy";
import "./messages";

message(0x10) Claim {
    query_id: Int as uint64;
    amount: Int as coins;
}

message(0x31) StartDiscovery {
    query_id: Int as uint64;
}

message(0x124) LockFunded {
    lock_id: Int as uint64;
    amount: Int as coins;
}

message(0x125) Claimed {
    lock_id: Int as uint64;
    amount: Int as coins;
    beneficiary: Address;
    beneficiary_wallet: Address;
}

message(0x126) ClaimBounced {
    lock_id: Int as uint64;
    amount: Int as coins;
}

const DISCOVERY_GAS: Int = ton("0.1");
const CLAIM_GAS: Int = ton("0.2");
const CLAIM_FORWARD: Int = ton("0.05");

contract LockupWallet {
    lock_id: Int as uint64;
    factory: Address;
    jetton_master: Address;
    beneficiary: Address;
    creator: Address;

    total_amount: Int as coins;
    claimed: Int as coins;
    unlock_at: Int as uint64;

    jetton_wallet: Address?;
    fund_sender: Address?;
    funded: Bool;

    pending_claim: Bool;
    pending_amount: Int as coins;
    pending_query_id: Int as uint64;

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
        self.fund_sender = null;
        self.funded = false;
        self.pending_claim = false;
        self.pending_amount = 0;
        self.pending_query_id = 0;
    }

    receive(msg: StartDiscovery) {
        require(sender() == self.factory, "not factory");
        send(SendParameters{
            to: self.jetton_master,
            value: DISCOVERY_GAS,
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

    // owner_address приходит как Maybe ^MsgAddress (1 бит + ref)
    let ownerOpt: Cell? = msg.owner_address;
    require(ownerOpt != null, "no owner");
    let owner: Address = ownerOpt!!.beginParse().loadAddress();

    if (self.pending_claim
        && owner == self.beneficiary
        && msg.query_id == self.pending_query_id) {
        require(self.jetton_wallet != null, "no wallet");

        self.claimed = self.claimed + self.pending_amount;

        send(SendParameters{
            to: self.jetton_wallet!!,
            value: CLAIM_GAS,
            mode: SendPayGasSeparately,
            body: JettonTransfer{
                query_id: self.pending_query_id,
                amount: self.pending_amount,
                destination: msg.wallet_address,
                response_destination: myAddress(),
                custom_payload: null,
                forward_ton_amount: CLAIM_FORWARD,
                forward_payload: emptySlice()
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

    if (owner == myAddress() && self.jetton_wallet == null) {
        self.jetton_wallet = msg.wallet_address;

        let fs: Address? = self.fund_sender;
        if (fs != null && fs!! == msg.wallet_address && !self.funded) {
            self.funded = true;
            self.fund_sender = null;
            emit(LockFunded{ lock_id: self.lock_id, amount: self.total_amount }.toCell());
        }
        return;
    }
}

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

        send(SendParameters{
            to: self.jetton_master,
            value: DISCOVERY_GAS,
            mode: SendPayGasSeparately,
            body: ProvideWalletAddress{
                query_id: msg.query_id,
                owner_address: self.beneficiary,
                include_address: true
            }.toCell()
        });
    }

    receive(msg: JettonExcesses) {
        let jw: Address? = self.jetton_wallet;
        require(jw != null && sender() == jw!!, "not our wallet");
        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
        }
    }

    bounced(msg: bounced<JettonTransfer>) {
        if (self.pending_claim && msg.query_id == self.pending_query_id) {
            self.claimed = self.claimed - self.pending_amount;
            self.pending_claim = false;
            self.pending_amount = 0;
            self.pending_query_id = 0;
            emit(ClaimBounced{ lock_id: self.lock_id, amount: msg.amount }.toCell());
        }
    }

    receive() { }

    get fun lockId(): Int { return self.lock_id; }
    get fun isFunded(): Bool { return self.funded; }
    get fun jettonWallet(): Address? { return self.jetton_wallet; }
    get fun availableClaimable(): Int {
        if (!self.funded || self.pending_claim || now() < self.unlock_at) { return 0; }
        return self.total_amount - self.claimed;
    }
    get fun unlockAt(): Int { return self.unlock_at; }
    get fun beneficiaryGet(): Address { return self.beneficiary; }
    get fun claimedAmount(): Int { return self.claimed; }
    get fun isPendingClaim(): Bool { return self.pending_claim; }
}
