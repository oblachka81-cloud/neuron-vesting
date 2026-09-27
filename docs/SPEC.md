# 📜 NEURON Vesting — Contract Specification

**Version:** `v5.0.1` (factory v5.0.0 + wallet v5.0.1)  
**Language:** Tact 1.6.13  
**Network:** TON Mainnet  
**Status:** Internal review passed · 55 sandbox tests green · mainnet-verified

---

## 📑 Table of Contents

1. [Overview](#1-overview)
2. [Contract: LockupFactory](#2-contract-lockupfactory)
3. [Contract: LockupWallet](#3-contract-lockupwallet)
4. [Message Types & Opcodes](#4-message-types--opcodes)
5. [Events](#5-events)
6. [Constants](#6-constants)
7. [Invariants](#7-invariants)
8. [Design Trade-offs](#8-design-trade-offs)
9. [Trust Model](#9-trust-model)
10. [Sequence Diagrams](#10-sequence-diagrams)

---

## 1. Overview

NEURON Vesting is a non-custodial, immutable token lockup system on TON. Users lock TEP-74 jettons with a transparent schedule. Locked tokens cannot be withdrawn until the `unlock_at` timestamp. The unlock date is fixed at creation and cannot be changed on-chain.

### Components

- **`LockupFactory`** — Singleton. Receives jetton transfers, deploys `LockupWallet` instances, forwards jettons via TEP-89 discovery, and accumulates platform fees.
- **`LockupWallet`** — One instance per lock. Holds jettons, enforces the schedule, releases to the beneficiary on claim, and self-destructs on final claim.
- **`messages.tact`** — Shared TEP-74 / TEP-89 message declarations.

### Jetton-wallet resolution (both contracts)

Neither contract computes a jetton-wallet address from `StateInit` / `c4`. Both ask the jetton master via TEP-89 `provide_wallet_address` and cache the response. This makes the system agnostic to the internal layout of any TEP-74 wallet implementation.

---

## 2. Contract: `LockupFactory`

### State

| Field | Type | Description |
| :--- | :--- | :--- |
| `next_id` | `Int as uint64` | Monotonic lock counter, starts at 1 |
| `treasury` | `Address` | Platform treasury (fee recipient, whitelist authority) |
| `salt` | `Int as uint64` | Deployment salt (deterministic child addressing) |
| `fee_bps` | `Int as uint16` | Per-lock jetton fee in basis points (cap `MAX_FEE_BPS`) |
| `fee_ton` | `Int as coins` | Fixed TON platform fee per lock |
| `own_wallets` | `map<Address, Address>` | `jetton_master` → factory jetton wallet |
| `wallet_to_master` | `map<Address, Address>` | factory jetton wallet → `jetton_master` |
| `fees` | `map<Address, Int>` | `jetton_master` → accumulated jetton fee |
| `ton_fees` | `Int as coins` | Accumulated TON platform fees |
| `used_qids` | `map<Int, Bool>` | Treasury query-id registry (replay guard) |
| `pending_create` | `map<Int, Address>` | `lock_id` → child `LockupWallet` address |
| `create_creator` / `create_amount` / `create_jetton` / `create_fee_jetton` / `create_fee_ton` | `map<Int, …>` | Temporary create-state for bounce recovery |
| `pending_withdraw` | `map<Int, Int>` | treasury `query_id` → in-flight jetton withdrawal amount |
| `pending_withdraw_jetton` | `map<Int, Address>` | treasury `query_id` → jetton master |
| `cleared_withdraw` | `map<Int, Bool>` | `false` while in-flight, `true` after a bounce is processed (double-bounce guard) |

### Query-id namespaces

Two disjoint id spaces share the contract:

- **Create transfers:** `qid = lock_id | HIGH_BIT` (high bit set). Tracked via `pending_create`, not via `used_qids`.
- **Treasury ops:** `qid = msg.query_id` with the high bit clear. Guarded by `used_qids` (monotonic) on `WithdrawFees`, `WithdrawTonFees`, `RescueTon`, `RescueJetton`. The fee-config setters `SetFeeBps` / `SetFeeTon` are idempotent state writes and intentionally do not consume `used_qids`.

### Receivers

#### `SetJettonWallet` (0x21, treasury only)

Registers a factory-owned jetton wallet for a given master.

- **Preconditions:** `sender() == treasury`, `msg.query_id > 0`, `own_wallets[jetton_master]` unset **or** equals `jetton_wallet`.
- **Effects:** `own_wallets[m] = w`, `wallet_to_master[w] = m`. Emits `JettonWalletSet`.
- **Security:** Off-chain verifier (`scripts/verify-jetton-wallets.ts`) validates the address against the master's `get_wallet_address(factory)` before the call. The same derivation is reproduced on-chain by `add-jetton.ts` and the admin approve flow, so the three generators emit identical bytes (`qid → jetton_master → jetton_wallet`).

#### `SetFeeBps` (0x25) / `SetFeeTon` (0x26) (treasury only)

Update `fee_bps` (capped at `MAX_FEE_BPS = 10%`) / `fee_ton`. Idempotent setters; no replay guard needed.

#### `JettonNotification` (any user, via whitelisted jetton wallet)

Main entry point for lock creation.

**Preconditions:**

- `wallet_to_master[sender()] != null` (sender is a factory JW of a known master)
- `own_wallets[master] != null` (master whitelisted)
- `context().value >= fee_ton + GAS_BUFFER_TON` → with current defaults, **≥ 1.1 TON**
- `forward_payload` decodes: consume the TEP-74 `Either` bit, then require `bits >= CREATE_LOCK_PAYLOAD_BITS (694)` and `preloadUint(32) == CREATE_LOCK_OP (0x1)`; else emit `LockCreationFailed` + `RefundRequired` and return without state change
- parsed `jetton_master` field equals the reverse-mapped master (`jm_in == jetton_master`)
- `unlock_at > now()` and `unlock_at <= now() + MAX_LOCK_DURATION`
- client `qid > 0`
- `lock_amount = amount - fee > 0` where `fee = amount * fee_bps / 10000`

**Effects:**

- `ton_fees += fee_ton`; overpay (`value - fee_ton - GAS_BUFFER_TON`) refunded to creator immediately
- `fees[master] += fee`
- `id = next_id++`; deploy `LockupWallet` with `DEPLOY_GAS` and body `StartDiscovery{query_id: id}`
- send `ProvideWalletAddress{query_id: id | HIGH_BIT, owner_address: child}` to the master (TEP-89)
- record `pending_create[id]` and `create_*[id]` for bounce recovery
- emit `LockCreated`, `TonFeeCollected`

#### `TakeWalletAddress` (TEP-89 response from the master)

- **Preconditions:** `(qid & HIGH_BIT) != 0`, `pending_create[id]` set, `owner_address` present and equals the child, `sender() == create_jetton[id]`.
- **Effects:** forward the locked jettons from `own_wallets[master]` to the child via `JettonTransfer{query_id: qid, amount: lock_amount, destination: child, …}` with `TRANSFER_GAS` / `TRANSFER_FORWARD`.

#### `WithdrawFees` (0x20) / `WithdrawTonFees` (0x22) (treasury only)

- **Preconditions:** `sender() == treasury`, `query_id > 0`, `query_id` not in `used_qids`, `amount > 0`, sufficient balance (`fees[master] >= amount` for jettons; `ton_fees >= amount` for TON); for jettons also `own_wallets[master] != null`.
- **Effects:** mark `used_qids[qid] = true`; deduct balance; for jettons set `pending_withdraw[qid]`, `pending_withdraw_jetton[qid]`, `cleared_withdraw[qid] = false` and send `JettonTransfer` to `destination_wallet`; emit `FeesWithdrawn`. For TON, send `value = amount` to destination.

#### `RescueTon` (0x23) / `RescueJetton` (0x24) (treasury only, emergency)

Same replay guard as withdrawals. `RescueTon` reserves `ton_fees + 0.05` and only sends `myBalance() - reserved`. `RescueJetton` requires the master whitelisted and forwards from `own_wallets[master]`.

#### `bounced<JettonTransfer>`

Two cases disambiguated by the high bit of `query_id`:

- **Create-transfer bounce** (`qid & HIGH_BIT != 0`): matches `pending_create[id]`; verifies sender is `own_wallets[create_jetton[id]]`; rolls back `fees[master]` (saturated at 0); if `ton_fees >= create_fee_ton[id]`, deducts it and refunds `create_fee_ton + GAS_BUFFER_TON` to the creator; emits `CreateBounced` + `RefundRequired`; clears all `pending_create` / `create_*` entries.
- **Fee-withdrawal bounce** (`qid & HIGH_BIT == 0`): matches `pending_withdraw[qid]` only when `cleared_withdraw[qid]` is `false`; verifies sender is `own_wallets[pending_withdraw_jetton[qid]]`; restores `fees[master] += amount`; sets `cleared_withdraw[qid] = true` so a duplicated bounce cannot double-credit.

#### `JettonExcesses` / `receive()`

`JettonExcesses` is an explicit no-op (without it, gas-refund excesses would abort with exit 130). Plain TON top-ups are accepted.

### Getters

| Getter | Returns |
| :--- | :--- |
| `nextLockId()` | `next_id` |
| `feeBps()` / `feeTon()` | `fee_bps` / `fee_ton` |
| `tonFees()` | `ton_fees` |
| `feeOf(jetton)` | `fees[jetton]` or 0 |
| `isWalletSet(jetton)` | whether master is whitelisted |
| `walletOf(jetton)` | `own_wallets[jetton]` |
| `pendingCreateOf(lockId)` | pending child address |

---

## 3. Contract: `LockupWallet`

### State

| Field | Type | Description |
| :--- | :--- | :--- |
| `lock_id` | `Int as uint64` | Unique lock id |
| `factory` | `Address` | Factory that deployed this wallet |
| `jetton_master` | `Address` | Jetton master of locked tokens |
| `beneficiary` | `Address` | Who can claim after unlock |
| `creator` | `Address` | Original jetton owner (recorded; no on-chain capability) |
| `total_amount` | `Int as coins` | Locked amount (immutable) |
| `claimed` | `Int as coins` | Amount claimed so far |
| `unlock_at` | `Int as uint64` | Unix timestamp when claim becomes available |
| `jetton_wallet` | `Address?` | This wallet's jetton wallet address, resolved via TEP-89 (set at most once) |
| `beneficiary_wallet` | `Address?` | Beneficiary's jetton wallet address, cached during claim (v5.0.1) |
| `fund_sender` | `Address?` | Notification sender observed before discovery completed; reconciled in `TakeWalletAddress` |
| `funded` | `Bool` | `true` once the exact expected amount was received |
| `pending_claim` | `Bool` | `true` while a claim is in-flight |
| `pending_amount` | `Int as coins` | Amount of the in-flight claim (`> 0` iff `pending_claim`) |
| `pending_query_id` | `Int as uint64` | Query id of the in-flight claim |

### Receivers

#### `StartDiscovery` (0x31, factory only)

Kicks off TEP-89 discovery of this wallet's own jetton wallet.

- **Preconditions:** `sender() == factory`.
- **Effects:** send `ProvideWalletAddress{query_id: lock_id, owner_address: myAddress()}` to the master with `WALLET_DISCOVERY_GAS`.

#### `TakeWalletAddress` (TEP-89 response from the master)

Reached for two distinct flows, both requiring `sender() == jetton_master` and a present `owner_address`:

- **Flow 1 — discover own wallet** (`owner == myAddress() && jetton_wallet == null`): cache `jetton_wallet = msg.wallet_address`. If a funding notification arrived before discovery (`fund_sender == msg.wallet_address && !funded`), reconcile now: `funded = true`, clear `fund_sender`, emit `LockFunded`.
- **Flow 2 — complete pending claim** (`pending_claim && owner == beneficiary && query_id == pending_query_id`): cache `beneficiary_wallet = msg.wallet_address`; `claimed += pending_amount`; send `JettonTransfer{query_id, amount: pending_amount, destination: beneficiary, response_destination: myAddress(), forward_ton_amount: CLAIM_FORWARD, forward_payload: <single 0 bit>}` from `jetton_wallet` with `CLAIM_GAS`; emit `Claimed`. Requires `jetton_wallet != null`.

#### `JettonNotification` (funding)

- If `jetton_wallet == null`: buffer the sender into `fund_sender` only when `amount == total_amount`; return (no revert — discovery may not have completed yet).
- Else: `require(sender() == jetton_wallet)`, `require(!funded)`, `require(amount == total_amount)`; set `funded = true`; emit `LockFunded`. A deposit from any other sender, or with a wrong amount, reverts.

#### `Claim` (0x10, beneficiary only)

- **Preconditions:** `sender() == beneficiary`, `funded`, `now() >= unlock_at`, `!pending_claim`, `query_id > 0`, `available = total_amount - claimed > 0`, `want = (amount == 0 ? available : amount)` with `0 < want <= available`.
- **Effects:** set `pending_claim = true`, `pending_amount = want`, `pending_query_id = query_id`; send `ProvideWalletAddress{query_id, owner_address: beneficiary}` to the master with `WALLET_DISCOVERY_GAS`. The actual jetton transfer happens later in `TakeWalletAddress` flow 2.

#### `JettonExcesses` (claim settlement — success path)

- **Preconditions (v5.0.1):** `sender() == jetton_wallet || sender() == beneficiary_wallet` (the second valid sender is cached during claim flow 2). TEP-74 copies `response_destination` into `internal_transfer`, so the receiving-side jetton wallet (the beneficiary's) also returns excesses; COGNIQ's sending-side wallet returns none. Accepting only the sending side reverted the only excess that ever arrived (exit 36235, v5.0.0).
- **Effects:** if `pending_claim && query_id == pending_query_id`, clear `pending_claim` / `pending_amount` / `pending_query_id`. Then, if `claimed >= total_amount`, sweep all remaining TON to the beneficiary and self-destruct (`mode: 128 + 32 + 2`).

#### `bounced<JettonTransfer>` (claim settlement — failure path)

If `pending_claim && query_id == pending_query_id`: `claimed -= pending_amount`, clear `pending_*`, emit `ClaimBounced`. A bounce with a non-matching query id is silently ignored.

#### `receive()`

Plain TON top-ups accepted (gas).

### Getters

| Getter | Returns |
| :--- | :--- |
| `lockId()` | `lock_id` |
| `isFunded()` | `funded` |
| `jettonWallet()` | `jetton_wallet` (nullable) |
| `beneficiaryWallet()` | `beneficiary_wallet` (nullable, v5.0.1) |
| `unlockAt()` | `unlock_at` |
| `beneficiaryGet()` | `beneficiary` |
| `claimedAmount()` | `claimed` |
| `isPendingClaim()` | `pending_claim` |
| `availableClaimable()` | `0` if `!funded` or `pending_claim` or `now() < unlock_at`, else `total_amount - claimed` |

---

## 4. Message Types & Opcodes

### TEP-74 standard

| Opcode | Message | Direction |
| :--- | :--- | :--- |
| `0x0f8a7ea5` | `JettonTransfer` | Outgoing |
| `0x7362d09c` | `JettonNotification` | Incoming |
| `0xd53276db` | `JettonExcesses` | Incoming (settlement / gas refund) |
| `0x178d4519` | `JettonInternalTransfer` | Internal (TEP-74) |

### TEP-89 / discovery (declared in `messages.tact`)

`ProvideWalletAddress` (`0x2c76b973`), `TakeWalletAddress` (`0xd1735400`). `StartDiscovery` (`0x31`) is wallet-local.

### Platform control — Factory (byte-verified)

| Opcode | Message | Field order | Sender → Receiver |
| :--- | :--- | :--- | :--- |
| `0x20` | `WithdrawFees` | `query_id → jetton_master → destination_wallet → amount(coins)` | Treasury → Factory |
| `0x21` | `SetJettonWallet` | `query_id → jetton_master → jetton_wallet` | Treasury → Factory |
| `0x22` | `WithdrawTonFees` | `query_id → amount(coins) → destination` | Treasury → Factory |
| `0x23` | `RescueTon` | `query_id → amount(coins) → destination` | Treasury → Factory |
| `0x24` | `RescueJetton` | `query_id → jetton_master → amount(coins) → destination` | Treasury → Factory |
| `0x25` | `SetFeeBps` | `query_id → fee_bps(uint16)` | Treasury → Factory |
| `0x26` | `SetFeeTon` | `query_id → fee_ton(coins)` | Treasury → Factory |
| `0x01` | `CreateLock` (forward payload) | `op(32) → qid(64) → jetton_master → beneficiary → unlock_at(64)` | User → Factory (via jetton transfer) |

### Platform control — Wallet (byte-verified)

| Opcode | Message | Field order | Sender → Receiver |
| :--- | :--- | :--- | :--- |
| `0x10` | `Claim` | `query_id → amount(coins)` | Beneficiary → Wallet |
| `0x31` | `StartDiscovery` | `query_id` | Factory → Wallet |

---

## 5. Events

Ranges are disjoint so indexers can route events by opcode.

### Factory (byte-verified — exactly these seven are emitted)

| Opcode | Event | Fields |
| :--- | :--- | :--- |
| `0x100` | `LockCreated` | `lock_id, creator, beneficiary, jetton, amount, unlock_at` |
| `0x106` | `TonFeeCollected` | `lock_id, amount` |
| `0x107` | `FeesWithdrawn` | `query_id, jetton_master, amount, destination` |
| `0x109` | `JettonWalletSet` | `jetton_master, jetton_wallet` |
| `0x111` | `LockCreationFailed` | `lock_id, creator, jetton, amount` |
| `0x112` | `CreateBounced` | `lock_id, amount` |
| `0x115` | `RefundRequired` | `creator, jetton, amount` |

### Wallet (byte-verified — exactly these three are emitted)

| Opcode | Event | Fields |
| :--- | :--- | :--- |
| `0x124` | `LockFunded` | `lock_id, amount` |
| `0x125` | `Claimed` | `lock_id, amount, beneficiary, beneficiary_wallet` |
| `0x126` | `ClaimBounced` | `lock_id, amount` |

---

## 6. Constants

### Factory (byte-verified against `lockup_factory.tact`)

| Name | Value | Purpose |
| :--- | :--- | :--- |
| `GAS_BUFFER_TON` | 0.1 TON | Minimum gas buffer the user must attach on top of `fee_ton` |
| `DEPLOY_GAS` | 0.12 TON | Gas the factory attaches when deploying the child wallet (internal) |
| `TRANSFER_GAS` | 0.05 TON | Gas on the jetton transfer that funds the child / pays fees |
| `TRANSFER_FORWARD` | 0.01 TON | `forward_ton_amount` so the child emits a notification |
| `DISCOVERY_GAS` | 0.05 TON | Gas on the TEP-89 `ProvideWalletAddress` request |
| `RESCUE_GAS` | 0.05 TON | Gas on a rescue jetton transfer |
| `MAX_LOCK_DURATION` | 315,360,000 (10y) | Max unlock horizon from creation |
| `MAX_FEE_BPS` | 1000 (10%) | Cap on the configurable jetton fee |
| `CREATE_LOCK_OP` | `0x1` | Payload opcode of `CreateLock` |
| `HIGH_BIT` | `1 << 63` | Separates create-transfer qids from treasury qids |
| `CREATE_LOCK_PAYLOAD_BITS` | 694 | Min payload size: op(32)+qid(64)+2×addr(267)+unlock(64) |

The minimum user attach is `fee_ton + GAS_BUFFER_TON`. With current defaults (`fee_ton = 1 TON`) that is **1.1 TON**. `DEPLOY_GAS` (0.12) is the factory's internal child-deploy budget and is not part of the user-facing minimum.

### Wallet (byte-verified against `lockup_wallet.tact`)

| Name | Value | Purpose |
| :--- | :--- | :--- |
| `WALLET_DISCOVERY_GAS` | 0.05 TON | Gas on a `provide_wallet_address` request to the master |
| `CLAIM_GAS` | 0.05 TON | Gas on the outgoing claim `JettonTransfer` |
| `CLAIM_FORWARD` | 0.01 TON | `forward_ton_amount` so the destination emits a notification |

The claim `forward_payload` is a single `0` bit (`beginCell().storeBit(false)`), not an empty slice — some TEP-74 implementations (e.g. COGNIQ) revert an empty payload with exit 708.

---

## 7. Invariants

### Factory (F1–F8, byte-verified)

- **F1:** `next_id` strictly increases, never reused.
- **F2:** `own_wallets[m]` set ⇔ master `m` whitelisted by treasury.
- **F3:** `wallet_to_master[w] = m` ⇔ `own_wallets[m] = w` (strict bijection).
- **F4:** `fees[m]` = cumulative `fee_bps`-equivalent cuts − withdrawals (saturated at 0 on create-bounce rollback).
- **F5:** `pending_withdraw[qid]`, `pending_withdraw_jetton[qid]`, `cleared_withdraw[qid]` are written together on withdraw; `cleared_withdraw` flips `false → true` exactly once on bounce, so a duplicated bounce cannot double-credit.
- **F6:** `used_qids` monotonic (once true, never false); applies to treasury withdraw/rescue ops. Create-transfer ids live in the `HIGH_BIT` namespace and are tracked by `pending_create`, not `used_qids`. Fee-config setters are idempotent and bypass `used_qids`.
- **F7:** `pending_create[id]` and all `create_*[id]` are set together at create and cleared together on bounce.
- **F8:** `ton_fees >= 0` at all times; overpay never retained.

### Wallet (I1–I6, byte-verified against source; I6 mainnet-verified)

- **I1:** `claimed <= total_amount` (enforced by `want <= available` on claim and `claimed -= pending_amount` on bounce).
- **I2:** `pending_amount > 0` iff `pending_claim == true`.
- **I3:** `funded == true` only after a `JettonNotification` with `amount == total_amount` from the discovered jetton wallet (directly, or reconciled via `fund_sender` in `TakeWalletAddress`).
- **I4:** `jetton_wallet` is set at most once (discovery is idempotent; the `== null` guard in flow 1 prevents overwrite).
- **I5:** Claims are atomic — at most one pending claim per wallet (`!pending_claim` precondition on `Claim`).
- **I6:** After successful claim completion (`claimed >= total_amount`), all remaining TON balance is returned to the beneficiary and the contract self-destructs (no dust left). ✅ **Mainnet-verified** in v5.0.1 (tx `de15fd59…a94b4fcb`, 28 Sep 2026).

---

## 8. Design Trade-offs

### Factory

- **L1:** `LockCreated` is emitted before the child jetton transfer confirms. If that transfer bounces, `CreateBounced` + `RefundRequired` follow. Frontends should treat a lock as canonical only after N blocks without a matching `CreateBounced` for the same `lock_id`.
- **L2:** If a create-transfer bounce is lost, the `pending_create` entry for that `lock_id` remains set. The entry is small and can be cleaned by a future migration.
- **L3:** A create-transfer bounce may leave an empty, unfunded deployed `LockupWallet`. Frontends must filter these via `LockCreationFailed` / `funded == false`.
- **L4:** A lost fee-withdrawal bounce leaves `pending_withdraw[qid]` set forever (no funds lost, but the treasury `query_id` is burned).

### Wallet

- **W1:** Funding requires the exact `total_amount`; there are no top-ups and no partial funding. A wrong-amount deposit reverts.
- **W2:** `claimed` is incremented in `TakeWalletAddress` flow 2 before the `JettonTransfer` is sent, so the in-flight amount is reserved atomically; a bounce rolls it back. `claimed` briefly exceeds the actually-delivered balance while a claim is in-flight (bounded by `pending_amount`, I2).
- **W3:** The wallet trusts the master's `TakeWalletAddress` response for both its own and the beneficiary's jetton-wallet address (TEP-89). A malicious master could misroute a claim; this is inherent to TEP-74/89 and mitigated by whitelisting only vetted masters.
- **W4:** No on-chain `Extend` and no on-chain `ResetPendingClaim` in wallet v5.0.1. `unlock_at` is immutable, and a stuck `pending_claim` (settlement message never arriving) blocks further claims with no on-chain escape hatch. Tracked for v6+.

---

## 9. Trust Model

| Party | Trusted for | Cannot do |
| :--- | :--- | :--- |
| **Treasury** | Whitelist masters, withdraw fees, emergency rescue, retune fees | Steal locked jettons, modify existing locks |
| **Factory** | Deploy, one-time deposit via TEP-89, overpay / failed-create refund | Withdraw jettons from a funded `LockupWallet` |
| **Creator** | Receive overpay / failed-create refund from the factory | Touch an existing funded lock; change `unlock_at` |
| **Beneficiary** | Claim after `unlock_at` (full or partial) | Claim before unlock, claim if unfunded; reset a stuck pending claim |
| **Jetton master** | Answer TEP-89 `provide_wallet_address` truthfully | — (misrouting risk W3 — mitigate by whitelisting vetted masters only) |

**Treasury compromise impact:** DoS on new lock creation (bad addresses registered). No theft of locked jettons. Mitigated by a live 2-of-3 multisig + off-chain verifier.

---

## 10. Sequence Diagrams

### Create lock (byte-verified against factory)

```text
User         User JW        Factory          Master        Child LW      Child JW
 │              │               │                │              │              │
 │ JettonTransfer(amount,       │                │              │              │
 │  CreateLock payload, ≥1.1 T)│                │              │              │
 ├─────────────▶│               │                │              │              │
 │              │ JettonNotif   │                │              │              │
 │              ├──────────────▶│                │              │              │
 │              │               │ reverse-map sender → master   │              │
 │              │               │ check whitelist + attach value │              │
 │              │               │ parse payload (Either bit,    │              │
 │              │               │  op=0x1, ≥694 bits)            │              │
 │              │               │ fee = amount*bps/10000         │              │
 │              │               │ lock_amount = amount - fee     │              │
 │              │               │ ton_fees += fee_ton            │              │
 │              │◀── refund overpay (value - fee_ton - 0.1) ────│              │
 │              │               │                │              │              │
 │              │               │ StartDiscovery{id} (0.12 T)   │              │
 │              │               ├───────────────────────────────▶              │
 │              │               │                │              │              │
 │              │               │ ProvideWalletAddress{qid|HB,  │              │
 │              │               │  owner=child} (0.05 T)        │              │
 │              │               ├───────────────▶│              │              │
 │              │               │ emit LockCreated, TonFeeCollected            │
 │              │               │                │              │              │
 │              │               │◀── TakeWalletAddress{qid,owner=child} ───────│
 │              │               │ JettonTransfer(lock_amount → child)           │
 │              │               ├─────────────────────────────────────────────▶│
 │              │               │                │              │ JettonNotif  │
 │              │               │                │              │◀─────────────│
 │              │               │                │              │ funded=true  │
 │              │               │                │              │ emit LockFunded
 │              │               │                │              │              │
```

Claim (byte-verified against wallet)

```text
Beneficiary       LockupWallet          Master         own JW         Ben JW
     │                 │                   │              │              │
     │ Claim(amount)   │                   │              │              │
     ├────────────────▶│                   │              │              │
     │                 │ verify sender, funded, unlock_at, !pending    │
     │                 │ pending_claim=true, pending_amount, pending_qid
     │                 │ ProvideWalletAddress{qid, owner=Ben} (0.05 T) │
     │                 ├──────────────────▶│              │              │
     │                 │◀── TakeWalletAddress{qid,owner=Ben,wallet=BenJW} ─────│
     │                 │ cache beneficiary_wallet = BenJW                 │
     │                 │ claimed += pending_amount                        │
     │                 │ JettonTransfer(pending_amount → Ben) (0.05 T)    │
     │                 ├─────────────────────────────────────────────────▶│
     │                 │                   │              │ JettonNotif  │
     │                 │                   │              │◀─────────────│
     │                 │◀── JettonExcesses{qid} (exit 0) from own OR ben JW
     │                 │ clear pending_*   │              │              │
     │                 │ if claimed >= total_amount:                      │
     │                 │   sweep all TON + self-destruct (128+32+2)       │
     │◀── sweep + destroy                                                  │
     │                 │  (balance → 0, status → Nonexist)                │
     │                 │                   │              │              │
```

Mainnet proof: tx de15fd59…a94b4fcb (28 Sep 2026) — excess accepted (exit 0), full 0.152551844 GRAM sweep, wallet balance 0, status Nonexist.

Claim bounce (rollback path)

```text
LockupWallet          own JW
     │                   │
     │◀── bounced<JettonTransfer>{qid} ───│
     │ if pending_claim && qid == pending_query_id:
     │   claimed -= pending_amount
     │   clear pending_*
     │   emit ClaimBounced
     │                   │
```

---

End of specification. Both contract halves are byte-verified against lockup_factory.tact v5.0.0 / lockup_wallet.tact v5.0.1. All previously known runtime bugs are fixed and mainnet-verified.

```
