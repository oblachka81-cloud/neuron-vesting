# NEURON Vesting v1 — Contract Specification

## 1. Architecture

Two Tact contracts:

- **`LockupFactory`** (singleton, deployed once)
  - Accepts lock creation requests
  - Deploys per-user `LockupWallet` instances
  - Keeps a registry of all locks (for the indexer)
  - Collects platform fees

- **`LockupWallet`** (one per lock)
  - Holds the locked jettons
  - Stores lock params: jetton, amount, beneficiary, unlock schedule
  - Allows claims only by the beneficiary and only for vested amounts
  - Non-revocable by design — that is the whole point

## 2. Lock Parameters (v1 — simple)

| Parameter | Type | Description |
|---|---|---|
| `jetton_master` | `Address` | TEP-74 jetton master address |
| `total_amount` | `Int` | Total locked amount in nano-jettons |
| `beneficiary` | `Address` | Address allowed to claim |
| `unlock_at` | `Int` | Unix timestamp of full unlock |
| `created_at` | `Int` | Unix timestamp of creation |
| `claimed` | `Int` | Already claimed, in nano-jettons |

v2 will add: linear vesting with cliff, multiple beneficiaries, revocable grants.

### 2.5. Forward payload encoding (TEP-74)

Because `CreateLock` (~960 bits: 3 addresses + timestamps) cannot fit inside `JettonNotification.forward_payload` (~1023 bit limit), it MUST be wrapped as:

```tact
let inner = beginCell()
    .storeUint(0x1, 32)       // CreateLock op
    .storeUint(query_id, 64)
    .storeAddress(jetton_master)
    .storeAddress(beneficiary)
    .storeAddress(creator)
    .storeUint(unlock_at, 64)
    .endCell();

let forward = beginCell()
    .storeBit(1)              // "is reference" flag per TEP-74
    .storeRef(inner)
    .endCell();
```

The factory detects the flag and unwraps:

```tact
let sc: Slice = msg.forward_payload;
if (sc.loadBit()) {
    sc = sc.loadRef().beginParse();
}
```

This encoding is tested by the sandbox suite and is the **mandatory format** for all frontend integrations.

## 3. Messages (Tact)

### LockupFactory

**`CreateLock`** (from user, embedded as forward payload):
```tact
message(0x1) CreateLock {
  query_id: Int as uint64;
  jetton_master: Address;
  beneficiary: Address;
  creator: Address;
  unlock_at: Int as uint64;
}
```

**`JettonNotification`** (TEP-74 standard, from user's jetton wallet):
```tact
message(0x7362d09c) JettonNotification {
  query_id: Int as uint64;
  amount: Int as coins;
  sender: Address;
  forward_payload: Slice as remaining;  // carries wrapped CreateLock (see 2.5)
}
```

**`DeployLock`** (internal, factory -> new wallet):
```tact
message(0x2) DeployLock {
  jetton_master: Address;
  beneficiary: Address;
  total_amount: Int as coins;
  unlock_at: Int as uint64;
  creator: Address;
}
```

### LockupWallet

**`Claim`** (from beneficiary):
```tact
message(0x10) Claim {
  query_id: Int as uint64;
}
```

**`Extend`** (from creator, can only PUSH the date forward):
```tact
message(0x11) Extend {
  new_unlock_at: Int as uint64;
}
```

**`ReceiveJetton`** (internal, TEP-74 standard):
```tact
message(0x178d4519) ReceiveJetton {
  query_id: Int as uint64;
  amount: Int as coins;
  sender: Address;
  forward_payload: Cell;
}
```

## 4. Lock Creation Flow

1. User picks jetton, amount, unlock date, beneficiary in the mini app
2. Frontend builds a `CreateLock` payload, wraps it in a **TEP-74 compliant forward cell** (`storeBit(1)` + `storeRef(CreateLockCell)`) and sends a jetton transfer from the user's jetton wallet with `forward_payload = wrapped`
3. User's jetton wallet transfers jettons to the factory's jetton wallet with the forward payload
4. Factory's jetton wallet receives jettons and emits `JettonNotification` to the factory
5. Factory parses the payload, validates params, takes the fee (0.5%), deploys a new `LockupWallet` and forwards the remaining jettons to it
6. LockupWallet initializes with the params and emits `LockCreated(lock_id, creator, beneficiary, amount, unlock_at)`
7. Indexer catches the event, writes to DB, frontend shows the new lock

## 5. Claim Flow

1. After `unlock_at` the beneficiary taps Claim in the mini app
2. Frontend sends `Claim` to the LockupWallet
3. Wallet validates:
   - `now >= unlock_at` (otherwise reject)
   - sender == `beneficiary` (otherwise reject)
   - `total_amount - claimed > 0`
4. Wallet sends a jetton transfer to the beneficiary
5. Wallet updates `claimed = total_amount`
6. Emits `Claimed(lock_id, amount, beneficiary)`

## 6. Extend Flow

1. Creator taps Extend and picks a new date later than the current one
2. Wallet validates:
   - sender == `creator`
   - `new_unlock_at > unlock_at` (forward only)
   - `new_unlock_at <= now + 10 years` (sanity check)
3. Wallet updates `unlock_at = new_unlock_at`
4. Emits `Extended(lock_id, old_unlock_at, new_unlock_at)`

## 7. Platform Fee

- **0.5% of total_amount** in jettons, taken at creation
- Fees accumulate in the factory per jetton master and are withdrawn by the treasury via `WithdrawFees` (multisig treasury in v2)
- Locks with zero or negative post-fee amount are rejected
- Supply-based caps are enforced off-chain by the indexer catalog policy (v1)

## 8. Edge Cases & Protections

| Case | Handling |
|---|---|
| Claim before unlock_at | Rejected, jettons stay locked |
| Claim by non-beneficiary | Rejected |
| Extend by non-creator | Rejected |
| Extend into the past | Rejected |
| Repeat claim | Ok while claimed < total, rejected after |
| Non-TEP-74 jetton | Factory cannot parse payload, rejected |
| Amount too small | Rejected at factory |
| LockupWallet gas runs low | 0.1 TON reserve attached at deploy |

## 9. Events for the Indexer

All events emitted via `emit`:
- `LockCreated(lock_id: Int, creator: Address, beneficiary: Address, jetton: Address, amount: Int, unlock_at: Int)`
- `Claimed(lock_id: Int, amount: Int, beneficiary: Address)`
- `Extended(lock_id: Int, old_unlock_at: Int, new_unlock_at: Int)`

## 10. Security

- Contracts are non-custodial: nobody holds keys
- v1 has no upgradability — code is fixed, audit reads it once
- Treasury wallet is a separate multisig (2-of-3 minimum)
- Rate limit on lock creation per address (anti-spam for the factory)
- Jetton master whitelist at launch (no junk jettons in the catalog)

## 11. Out of Scope (v2)

- Linear vesting with cliff
- Multiple beneficiaries with shares
- Revocable grants (for investors)
- LP token locks
- Staking of locked jettons (yield on top of lock)
- Fiat on-ramp for fee payment

## 12. Required Test Cases

1. Create lock with valid params -> jettons land in the wallet
2. Claim before unlock_at -> rejected
3. Claim at unlock_at -> jettons arrive to beneficiary
4. Claim by non-beneficiary -> rejected
5. Extend forward by creator -> ok
6. Extend into the past -> rejected
7. Extend by non-creator -> rejected
8. Fee of 0.5% arrives to treasury
9. Repeat partial claim
10. Attack: create lock with a malformed jetton master

### 13. Testnet deployment (v1)

- Factory address (testnet): `kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh`
- Treasury: deployer wallet (testnet), multisig in v2
- Deployer derivation: BIP39 12-word mnemonic + SLIP-0010 ed25519, path m/44'/607'/0', wallet v5r1, networkGlobalId -3
- Secrets: TESTNET_MNEMONIC, TONCENTER_API_KEY (testnet-only, rotate before any mainnet use)
