# NEURON Vesting — Contract Specification

**Version:** v2.5.1 (factory) / v2.6.1 (wallet)
**Status:** Internal review passed · 55 sandbox tests green · external audit planned before third-party onboarding
**Language:** Tact 1.5.4

---

## Table of contents

1. Overview
2. Contract: `LockupFactory`
3. Contract: `LockupWallet`
4. Message types
5. Events
6. Constants
7. Invariants
8. Known limitations
9. Trust model
10. Sequence diagrams

---

## 1. Overview

NEURON Vesting is a **non-custodial** token lockup system on TON. Users lock TEP-74 jettons with a transparent, immutable schedule. Locked tokens cannot be withdrawn until the unlock date.

### Components

- **`LockupFactory`** — singleton. Receives jetton transfers, deploys `LockupWallet` instances, forwards jettons, accumulates fees.
- **`LockupWallet`** — one per lock. Holds jettons, enforces schedule, releases to beneficiary.
- **`messages.tact`** — shared TEP-74 message declarations.

---

## 2. Contract: `LockupFactory`

### State

| Field | Type | Description |
|-------|------|-------------|
| `next_id` | `Int as uint64` | Monotonic lock counter, starts at 1 |
| `treasury` | `Address` | Platform treasury (fee recipient, whitelist authority) |
| `own_wallets` | `map<Address, Address>` | `jetton_master → factory jetton wallet` |
| `wallet_to_master` | `map<Address, Address>` | `factory jetton wallet → jetton_master` |
| `fees` | `map<Address, Int>` | `jetton_master → accumulated jetton fee` |
| `ton_fees` | `Int as coins` | Accumulated TON platform fees |
| `pending_withdraw` | `map<Int, Int>` | `query_id → pending jetton fee withdrawal amount` |
| `pending_jetton` | `map<Int, Address>` | `query_id → pending jetton master` |
| `used_qids` | `map<Int, Bool>` | Monotonic query_id registry |
| `pending_create` | `map<Int, Address>` | `lock_id → child LockupWallet address` |
| `create_creator` | `map<Int, Address>` | `lock_id → creator` |
| `create_amount` | `map<Int, Int>` | `lock_id → locked amount` |
| `create_beneficiary` | `map<Int, Address>` | `lock_id → beneficiary` |
| `create_jetton` | `map<Int, Address>` | `lock_id → jetton master` |

### Receivers

#### `SetJettonWallet` (treasury only)

Registers a factory-owned jetton wallet for a given master.

**Preconditions:**
- `sender() == treasury`
- `query_id > 0`
- `own_wallets[jetton_master]` is unset OR equals `jetton_wallet`

**Effects:**
- `own_wallets[jetton_master] = jetton_wallet`
- `wallet_to_master[jetton_wallet] = jetton_master`
- Emits `JettonWalletSet`

**Security:** off-chain verifier (`scripts/verify-jetton-wallets.ts`) validates the address against the master's `get_wallet_address` before the call.

#### `JettonNotification` (any user, via whitelisted jetton wallet)

Main entry point for lock creation.

**Preconditions:**
1. `wallet_to_master[sender()] != null`
2. `own_wallets[jetton_master] != null`
3. `context().value >= 1.25 TON`
4. `forward_payload` parses as `CreateLock` and matches the master
5. `unlock_at > now()` and `unlock_at <= now() + 10 years`
6. `query_id > 0`
7. `lock_amount = amount - 0.5% fee > 0`
8. `creator != myAddress()`

**Effects:**
- Charges `ton_fees += 1 TON`, refunds overpay to `msg.sender`
- `fees[jetton_master] += 0.5% * amount`
- Deploys `LockupWallet` with `total_amount = amount - fee`
- Forwards jettons to `LockupWallet`
- Records `pending_create`, `create_*` for bounce recovery
- Emits `LockCreated`, `TonFeeCollected`

#### `WithdrawFees` (treasury only)

**Preconditions:** `sender() == treasury`, `query_id > 0`, qid not used, `fees[jetton_master] >= amount > 0`

**Effects:** reserves `query_id`, deducts `fees`, sends `JettonTransfer` to `destination_wallet`. On bounce: restores `fees`, emits `WithdrawBounced`.

#### `WithdrawTonFees` (treasury only)

**Preconditions:** `sender() == treasury`, `query_id > 0`, qid not used, `amount > 0`, `ton_fees >= amount`

**Effects:** reserves `query_id`, deducts `ton_fees`, sends TON to `destination`. Emits `TonFeesWithdrawn`.

#### `bounced<JettonTransfer>`

Handles two cases, disambiguated by `query_id` namespace:
- **Create-transfer bounce** — matches `pending_create[qid]`: verifies sender is the expected jetton wallet, refunds jettons to creator, emits `CreateBounced` + `LockCreationFailed`, clears pending maps.
- **Fee-withdrawal bounce** — matches `pending_withdraw[qid]`: verifies sender, restores `fees[master]`, emits `WithdrawBounced`, clears pending maps.

#### `receive()` — plain TON top-ups accepted.

### Getters

| Getter | Returns |
|--------|---------|
| `nextLockId()` | `next_id` |
| `treasuryAddress()` | `treasury` |
| `feeOf(jetton)` | `fees[jetton]` or 0 |
| `tonFees()` | `ton_fees` |
| `walletOf(jetton)` | `own_wallets[jetton]` |
| `masterOf(wallet)` | `wallet_to_master[wallet]` |
| `isWalletSet(jetton)` | whether master is whitelisted |
| `isQueryIdUsed(qid)` | whether qid was used |
| `pendingWithdrawOf(qid)` | pending jetton amount |
| `pendingJettonOf(qid)` | pending jetton master |
| `pendingCreateOf(lockId)` | pending child address |
| `createJettonOf(lockId)` | pending jetton master |

---

## 3. Contract: `LockupWallet`

### State

| Field | Type | Description |
|-------|------|-------------|
| `lock_id` | `Int as uint64` | Unique lock id |
| `factory` | `Address` | Factory that deployed this wallet |
| `jetton_master` | `Address` | Jetton master of locked tokens |
| `jetton_wallet` | `Address` | This wallet's jetton wallet address (provided at deploy) |
| `beneficiary` | `Address` | Who can claim after unlock |
| `creator` | `Address` | Original jetton owner; can extend |
| `total_amount` | `Int as coins` | Locked amount (immutable) |
| `claimed` | `Int as coins` | Amount claimed so far |
| `unlock_at` | `Int as uint64` | Unix timestamp when claim becomes available |
| `created_at` | `Int as uint64` | Deploy timestamp |
| `last_claim` | `Int as coins` | Amount of in-flight claim |
| `pending_claim` | `Bool` | True while a claim transfer is in-flight |
| `pending_since` | `Int as uint64` | Timestamp of pending claim start |
| `pending_query_id` | `Int as uint64` | Query id of the in-flight claim |
| `funded` | `Bool` | True after first correct-amount deposit |

### Receivers

#### `JettonNotification`

**Preconditions:** `sender() == jetton_wallet`

**Effects:** if `!funded && amount == total_amount` → `funded = true`, emits `LockFunded`. Otherwise emits `UnexpectedDeposit` (deposit accepted but ignored).

#### `Claim`

**Preconditions:**
1. `sender() == beneficiary`
2. `funded == true`
3. `now() >= unlock_at`
4. `!pending_claim`
5. `query_id > 0`
6. `available > 0`
7. `want > 0` (`msg.amount == 0` means full claim)
8. `want <= available`

**Effects:** updates `last_claim`, `claimed`, `pending_*`. Sends `JettonTransfer` via `jetton_wallet` targeting beneficiary. Emits `Claimed`. On bounce: rolls back `claimed`, emits `ClaimBounced`.

#### `Extend`

**Preconditions:**
1. `sender() == creator`
2. `now() < unlock_at`
3. `new_unlock_at > unlock_at`
4. `new_unlock_at <= now() + 10 years`

**Effects:** `unlock_at = new_unlock_at`. Emits `Extended`.

#### `ResetPendingClaim`

**Preconditions:**
1. `sender() == beneficiary`
2. `pending_claim == true`
3. `now() >= pending_since + 6 hours`

**Effects:** clears `pending_*`. **Does NOT roll back `claimed`** (see L1). Emits `PendingClaimReset`.

#### `bounced<JettonTransfer>`

**Preconditions:** `sender() == jetton_wallet`

**Effects:** if `pending_claim && query_id == pending_query_id` → `claimed -= last_claim`, clears `pending_*`, emits `ClaimBounced`. Otherwise emits `StaleBounceIgnored`.

#### `receive()` — plain TON top-ups accepted.

### Getters

| Getter | Returns |
|--------|---------|
| `lockId()` | `lock_id` |
| `factory()` | `factory` |
| `jettonMaster()` | `jetton_master` |
| `jettonWallet()` | `jetton_wallet` |
| `beneficiary()` | `beneficiary` |
| `creator()` | `creator` |
| `totalAmount()` | `total_amount` |
| `claimedAmount()` | `claimed` |
| `available()` | `total_amount - claimed` |
| `availableClaimable()` | 0 if not funded / still locked / pending, else `available` |
| `unlockAt()` | `unlock_at` |
| `createdAt()` | `created_at` |
| `isPending()` | `pending_claim` |
| `pendingSince()` | `pending_since` |
| `pendingQueryId()` | `pending_query_id` |
| `lastClaimAmount()` | `last_claim` |
| `isFunded()` | `funded` |

---

## 4. Message types

### TEP-74

| Opcode | Message | Direction |
|--------|---------|-----------|
| `0x0f8a7ea5` | `JettonTransfer` | Outgoing |
| `0x7362d09c` | `JettonNotification` | Incoming |

### Platform control

| Opcode | Message | Sender |
|--------|---------|--------|
| `0x21` | `SetJettonWallet` | treasury → factory |
| `0x20` | `WithdrawFees` | treasury → factory |
| `0x22` | `WithdrawTonFees` | treasury → factory |
| `0x10` | `Claim` | beneficiary → wallet |
| `0x11` | `Extend` | creator → wallet |
| `0x12` | `ResetPendingClaim` | beneficiary → wallet |
| `0x1` | `CreateLock` (forward payload) | user → factory (via jetton transfer) |

---

## 5. Events

### Factory (range `0x100`–`0x11F`)

| Opcode | Event |
|--------|-------|
| `0x100` | `LockCreated` |
| `0x104` | `WithdrawBounced` |
| `0x106` | `TonFeeCollected` |
| `0x107` | `FeesWithdrawn` |
| `0x108` | `OverpayRefunded` |
| `0x109` | `JettonWalletSet` |
| `0x110` | `TonFeesWithdrawn` |
| `0x111` | `LockCreationFailed` |
| `0x112` | `CreateBounced` |

### Wallet (range `0x124`–`0x12F`)

| Opcode | Event |
|--------|-------|
| `0x124` | `Claimed` |
| `0x125` | `Extended` |
| `0x126` | `ClaimBounced` |
| `0x127` | `PendingClaimReset` |
| `0x128` | `StaleBounceIgnored` |
| `0x129` | `LockFunded` |
| `0x12A` | `UnexpectedDeposit` |

**Note:** ranges are disjoint so indexers can route events by opcode.

---

## 6. Constants

### Factory

| Name | Value | Purpose |
|------|-------|---------|
| `PLATFORM_FEE_TON` | 1 TON | Per-lock platform fee |
| `GAS_BUFFER_TON` | 0.25 TON | Minimum gas buffer |
| `DEPLOY_GAS` | 0.15 TON | Sent with child deploy |
| `TRANSFER_GAS` | 0.15 TON | Sent with jetton transfer |
| `REFUND_GAS` | 0.08 TON | Sent with refunds |
| `MAX_LOCK_DURATION` | 315360000 (10y) | Max unlock horizon |
| `CREATE_LOCK_OP` | `0x1` | Payload opcode |

### Wallet

| Name | Value | Purpose |
|------|-------|---------|
| `MAX_EXTEND_HORIZON` | 315360000 (10y) | Max extend horizon |
| `CLAIM_GAS` | 0.07 TON | Gas for claim transfer |
| `PENDING_TIMEOUT` | 21600 (6h) | Reset pending after this |

---

## 7. Invariants

### Factory (F1–F9)

1. `next_id` strictly increases, never reused.
2. `own_wallets[m]` set ⇔ master `m` is whitelisted.
3. `wallet_to_master[w] = m` ⇔ `own_wallets[m] = w` (bijection).
4. `fees[m]` = sum of 0.5% cuts − withdrawals.
5. `pending_withdraw[qid]` and `pending_jetton[qid]` set/cleared together.
6. `used_qids` monotonic: once true, never false.
7. `pending_create[qid]` set at create, cleared on success or bounce.
8. `create_jetton[qid]` tracks master for refund on create bounce.
9. `ton_fees >= 0` at all times.

### Wallet (I1–I9)

1. `0 <= claimed <= total_amount`.
2. `available >= 0`.
3. At most one claim in-flight.
4. `jetton_wallet` set at deploy time by factory.
5. Only beneficiary can claim / reset pending.
6. Creator can only extend forward, while still locked.
7. Bounce restores accounting only on `query_id` match.
8. `total_amount` immutable.
9. Claim requires `funded == true`.

---

## 8. Known limitations

**Wallet:**
- **L1:** `ResetPendingClaim` does not roll back `claimed` (stuck-but-safe trade-off).
- **L2:** Non-factory jetton deposits accepted but ignored (`UnexpectedDeposit`).
- **L3:** No top-ups extend `total_amount`.

**Factory:**
- **L1:** Lost fee-withdrawal bounce leaves `pending_withdraw[qid]` set forever (no funds lost).
- **L2:** Overpay refund goes to `msg.sender` (original owner).
- **L3:** Create-transfer bounce leaves an empty deployed `LockupWallet`; frontends filter by `LockCreationFailed`.

---

## 9. Trust model

| Party | Trusted for |
|-------|-------------|
| Treasury | Whitelisting masters, fee withdrawal |
| Factory | Deploy, one-time deposit, overpay refund |
| Creator | Extend only (forward, while locked) |
| Beneficiary | Claim after unlock, reset stuck pending |

**Treasury compromise:** DoS on new locks. **No theft** of locked jettons.

---

## 10. Sequence diagrams

### Create lock

```
User          JettonWallet         Factory          LockupWallet
 │                 │                  │                  │
 │── JettonTransfer ─▶                │                  │
 │                 │── JettonNotify ─▶│                  │
 │                 │                  │ verify whitelist │
 │                 │                  │ charge 1 TON     │
 │                 │                  │ refund overpay   │
 │                 │                  │── deploy ───────▶│
 │                 │                  │── JettonTransfer ─▶ (child wallet)
 │                 │                  │ emit LockCreated │
```

### Claim

```
Beneficiary      LockupWallet        JettonWallet
 │                   │                    │
 │── Claim ─────────▶│                    │
 │                   │ verify sender,     │
 │                   │ funded, unlock_at, │
 │                   │ not pending        │
 │                   │── JettonTransfer ─▶│
 │                   │                    │ (success: done)
 │                   │◀── bounce ─────────│ (failure: rollback claimed)
```

---

**End of specification.**
