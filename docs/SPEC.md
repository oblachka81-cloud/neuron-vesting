# 📜 NEURON Vesting — Contract Specification

**Version:** `v5.0.0`  
**Status:** Internal review passed · 51 sandbox tests green · external audit planned before third-party onboarding  
**Language:** Tact 1.6.13  
**Network:** TON Mainnet  

---

## ✅ Verification status (read first)

Both contract halves below were re-read from source in this revision. The split now reflects *what was verified against code* versus *what is implemented in code but not yet confirmed by a mainnet run*:

| Section | Source of truth | Status |
| :--- | :--- | :--- |
| §2 LockupFactory, §4 factory messages, §5 factory events, §6 factory constants, §7 factory invariants, §8 factory limitations, §9 (factory rows), §10 create-flow | `contracts/lockup_factory.tact` (this revision) | **Byte-verified** against source |
| §3 LockupWallet, §4 wallet messages, §5 wallet events, §6 wallet constants, §7 wallet invariants, §8 wallet limitations, §9 (wallet rows), §10 claim-flow | `contracts/lockup_wallet.tact` (this revision) | **Byte-verified** against source |
| Wallet invariant **I6** (post-claim sweep + self-destruct) and factory `JettonExcesses` no-op | code present, **mainnet run pending** | **Implemented, not mainnet-confirmed** — see [§8 K1](#8-known-limitations) |

No section carries a `re-verify` flag anymore. The only open item is I6, which is a *runtime* gap (the handler exists but reverts on mainnet), not a *documentation* gap.

---

## 📑 Table of Contents
1. [Overview](#1-overview)
2. [Contract: LockupFactory](#2-contract-lockupfactory)
3. [Contract: LockupWallet](#3-contract-lockupwallet)
4. [Message Types & Opcodes](#4-message-types--opcodes)
5. [Events](#5-events)
6. [Constants](#6-constants)
7. [Invariants](#7-invariants)
8. [Known Limitations](#8-known-limitations)
9. [Trust Model](#9-trust-model)
10. [Sequence Diagrams](#10-sequence-diagrams)

---

## 1. Overview
NEURON Vesting is a non-custodial, immutable token lockup system on TON. Users lock TEP-74 jettons with a transparent schedule. Locked tokens cannot be withdrawn until the `unlock_at` timestamp. The unlock date is fixed at creation and cannot be changed on-chain in v5.0.0.

### Components
- **`LockupFactory`**: Singleton. Receives jetton transfers, deploys `LockupWallet` instances, forwards jettons via TEP-89 discovery, and accumulates platform fees.
- **`LockupWallet`**: One instance per lock. Holds jettons, enforces the schedule, releases to the beneficiary on claim.
- **`messages.tact`**: Shared TEP-74 / TEP-89 message declarations.

### Jetton-wallet resolution (both contracts)
Neither contract computes a jetton-wallet address from `StateInit`/`c4`. Both ask the jetton master via TEP-89 `provide_wallet_address` and cache the response. This makes the system agnostic to the internal layout of any TEP-74 wallet implementation.

---

## 2. Contract: LockupFactory

### State
| Field | Type | Description |
| :--- | :--- | :--- |
| `next_id` | `Int as uint64` | Monotonic lock counter, starts at 1 |
| `treasury` | `Address` | Platform treasury (fee recipient, whitelist authority) |
| `salt` | `Int as uint64` | Deployment salt (deterministic child addressing) |
| `fee_bps` | `Int as uint16` | Per-lock jetton fee in basis points (cap `MAX_FEE_BPS`) |
| `fee_ton` | `Int as coins` | Fixed TON platform fee per lock |
| `own_wallets` | `map<Address, Address>` | `jetton_master` → factory jetton wallet |
| `wallet_to_master`| `map<Address, Address>` | factory jetton wallet → `jetton_master` |
| `fees` | `map<Address, Int>` | `jetton_master` → accumulated jetton fee |
| `ton_fees` | `Int as coins` | Accumulated TON platform fees |
| `used_qids` | `map<Int, Bool>` | Treasury query-id registry (replay guard) |
| `pending_create` | `map<Int, Address>` | `lock_id` → child `LockupWallet` address |
| `create_creator` / `create_amount` / `create_jetton` / `create_fee_jetton` / `create_fee_ton` | `map<Int, …>` | Temporary create-state for bounce recovery |
| `pending_withdraw` | `map<Int, Int>` | treasury `query_id` → in-flight jetton withdrawal amount |
| `pending_withdraw_jetton` | `map<Int, Address>` | treasury `query_id` → jetton master |
| `cleared_withdraw` | `map<Int, Bool>` | `false` while in-flight, `true` after a bounce is processed (double-bounce guard) |

### Query-id namespaces (F1)
Two disjoint id spaces share the contract:
- **Create transfers:** `qid = lock_id | HIGH_BIT` (high bit set). Tracked via `pending_create`, **not** via `used_qids`.
- **Treasury ops:** `qid = msg.query_id` with the high bit clear. Guarded by `used_qids` (monotonic) on `WithdrawFees`, `WithdrawTonFees`, `RescueTon`, `RescueJetton`. The fee-config setters `SetFeeBps` / `SetFeeTon` are idempotent state writes and intentionally do **not** consume `used_qids`.

### Receivers
#### `SetJettonWallet` (`0x21`, treasury only)
Registers a factory-owned jetton wallet for a given master.
- **Preconditions:** `sender() == treasury`, `msg.query_id > 0`, `own_wallets[jetton_master]` unset OR equals `jetton_wallet`.
- **Effects:** `own_wallets[m] = w`, `wallet_to_master[w] = m`. Emits `JettonWalletSet`.
- **Security:** Off-chain verifier (`scripts/verify-jetton-wallets.ts`) validates the address against the master's `get_wallet_address(factory)` before the call. The same derivation is reproduced on-chain by `add-jetton.ts` and the admin `approve` flow, so the three generators emit identical bytes (verified: `qid → jetton_master → jetton_wallet`).

#### `SetFeeBps` (`0x25`) / `SetFeeTon` (`0x26`) (treasury only)
Update `fee_bps` (capped at `MAX_FEE_BPS` = 10%) / `fee_ton`. Idempotent setters; no replay guard needed.

#### `JettonNotification` (any user, via whitelisted jetton wallet)
Main entry point for lock creation.
- **Preconditions:**
  - `wallet_to_master[sender()] != null` (sender is a factory JW of a known master)
  - `own_wallets[master] != null` (master whitelisted)
  - `context().value >= fee_ton + GAS_BUFFER_TON` → with current defaults, **≥ 1.1 TON**
  - `forward_payload` decodes: consume the TEP-74 `Either` bit, then require `bits >= CREATE_LOCK_PAYLOAD_BITS` (694) and `preloadUint(32) == CREATE_LOCK_OP` (0x1); else emit `LockCreationFailed` + `RefundRequired` and return without state change
  - parsed `jetton_master` field equals the reverse-mapped master (`jm_in == jetton_master`)
  - `unlock_at > now()` and `unlock_at <= now() + MAX_LOCK_DURATION`
  - client `qid > 0`
  - `lock_amount = amount - fee > 0` where `fee = amount * fee_bps / 10000`
- **Effects:**
  - `ton_fees += fee_ton`; overpay (`value - fee_ton - GAS_BUFFER_TON`) refunded to creator immediately
  - `fees[master] += fee`
  - `id = next_id++`; deploy `LockupWallet` with `DEPLOY_GAS` and body `StartDiscovery{query_id: id}`
  - send `ProvideWalletAddress{query_id: id | HIGH_BIT, owner_address: child}` to the master (TEP-89)
  - record `pending_create[id]` and `create_*[id]` for bounce recovery
  - emit `LockCreated`, `TonFeeCollected`

#### `TakeWalletAddress` (TEP-89 response from the master)
- **Preconditions:** `(qid & HIGH_BIT) != 0`, `pending_create[id]` set, `owner_address` present and equals the child, `sender() == create_jetton[id]`.
- **Effects:** forward the locked jettons from `own_wallets[master]` to the child via `JettonTransfer{query_id: qid, amount: lock_amount, destination: child, …}` with `TRANSFER_GAS` / `TRANSFER_FORWARD`.

#### `WithdrawFees` (`0x20`) / `WithdrawTonFees` (`0x22`) (treasury only)
- **Preconditions:** `sender() == treasury`, `query_id > 0`, `query_id` not in `used_qids`, `amount > 0`, sufficient balance (`fees[master] >= amount` for jettons; `ton_fees >= amount` for TON); for jettons also `own_wallets[master] != null`.
- **Effects:** mark `used_qids[qid] = true`; deduct balance; for jettons set `pending_withdraw[qid]`, `pending_withdraw_jetton[qid]`, `cleared_withdraw[qid] = false` and send `JettonTransfer` to `destination_wallet`; emit `FeesWithdrawn`. For TON, send `value = amount` to `destination`.

#### `RescueTon` (`0x23`) / `RescueJetton` (`0x24`) (treasury only, emergency)
Same replay guard as withdrawals. `RescueTon` reserves `ton_fees + 0.05` and only sends `myBalance() - reserved`. `RescueJetton` requires the master whitelisted and forwards from `own_wallets[master]`.

#### `bounced<JettonTransfer>`
Two cases disambiguated by the high bit of `query_id`:
1. **Create-transfer bounce** (`qid & HIGH_BIT != 0`): matches `pending_create[id]`; verifies sender is `own_wallets[create_jetton[id]]`; rolls back `fees[master]` (saturated at 0); if `ton_fees >= create_fee_ton[id]`, deducts it and refunds `create_fee_ton + GAS_BUFFER_TON` to the creator; emits `CreateBounced` + `RefundRequired`; clears all `pending_create` / `create_*` entries.
2. **Fee-withdrawal bounce** (`qid & HIGH_BIT == 0`): matches `pending_withdraw[qid]` only when `cleared_withdraw[qid]` is `false`; verifies sender is `own_wallets[pending_withdraw_jetton[qid]]`; restores `fees[master] += amount`; sets `cleared_withdraw[qid] = true` so a duplicated bounce cannot double-credit.

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

## 3. Contract: LockupWallet

### State
| Field | Type | Description |
| :--- | :--- | :--- |
| `lock_id` | `Int as uint64` | Unique lock id |
| `factory` | `Address` | Factory that deployed this wallet |
| `jetton_master` | `Address` | Jetton master of locked tokens |
| `beneficiary` | `Address` | Who can claim after unlock |
| `creator` | `Address` | Original jetton owner (recorded; no on-chain capability in v5.0.0) |
| `total_amount` | `Int as coins` | Locked amount (immutable) |
| `claimed` | `Int as coins` | Amount claimed so far |
| `unlock_at` | `Int as uint64` | Unix timestamp when claim becomes available |
| `jetton_wallet` | `Address?` | This wallet's jetton wallet address, resolved via TEP-89 (set at most once) |
| `fund_sender` | `Address?` | Notification sender observed before discovery completed; reconciled in `TakeWalletAddress` |
| `funded` | `Bool` | True once the exact expected amount was received |
| `pending_claim` | `Bool` | True while a claim is in-flight (I5) |
| `pending_amount` | `Int as coins` | Amount of the in-flight claim (I2: `> 0` iff `pending_claim`) |
| `pending_query_id` | `Int as uint64` | Query id of the in-flight claim |

### Receivers
#### `StartDiscovery` (`0x31`, factory only)
Kicks off TEP-89 discovery of this wallet's own jetton wallet.
- **Preconditions:** `sender() == factory`.
- **Effects:** send `ProvideWalletAddress{query_id: lock_id, owner_address: myAddress()}` to the master with `WALLET_DISCOVERY_GAS`.

#### `TakeWalletAddress` (TEP-89 response from the master)
Reached for two distinct flows, both requiring `sender() == jetton_master` and a present `owner_address`:
- **Flow 1 — discover own wallet** (`owner == myAddress()` and `jetton_wallet == null`): cache `jetton_wallet = msg.wallet_address`. If a funding notification arrived before discovery (`fund_sender == msg.wallet_address` and `!funded`), reconcile now: `funded = true`, clear `fund_sender`, emit `LockFunded` (I3, I4).
- **Flow 2 — complete pending claim** (`pending_claim && owner == beneficiary && query_id == pending_query_id`): `claimed += pending_amount`; send `JettonTransfer{query_id: pending_query_id, amount: pending_amount, destination: beneficiary, response_destination: myAddress(), forward_ton_amount: CLAIM_FORWARD, forward_payload: <single 0 bit>}` from `jetton_wallet` with `CLAIM_GAS`; emit `Claimed`. Requires `jetton_wallet != null`.

#### `JettonNotification` (funding)
- If `jetton_wallet == null`: buffer the sender into `fund_sender` **only** when `amount == total_amount`; return (no revert — discovery may not have completed yet).
- Else: `require(sender() == jetton_wallet)`, `require(!funded)`, `require(amount == total_amount)`; set `funded = true`; emit `LockFunded`. A deposit from any other sender, or with a wrong amount, **reverts** (see §8 K3) — it is not silently ignored.

#### `Claim` (`0x10`, beneficiary only)
- **Preconditions:** `sender() == beneficiary`, `funded`, `now() >= unlock_at`, `!pending_claim`, `query_id > 0`, `available = total_amount - claimed > 0`, `want = (amount == 0 ? available : amount)` with `0 < want <= available`.
- **Effects:** set `pending_claim = true`, `pending_amount = want`, `pending_query_id = query_id`; send `ProvideWalletAddress{query_id, owner_address: beneficiary}` to the master with `WALLET_DISCOVERY_GAS`. The actual jetton transfer happens later in `TakeWalletAddress` flow 2.

#### `JettonExcesses` (claim settlement — success path)
- **Preconditions:** `sender() == jetton_wallet`.
- **Effects:** if `pending_claim && query_id == pending_query_id`, clear `pending_claim / pending_amount / pending_query_id`. **Then**, if `claimed >= total_amount`, attempt to sweep all remaining TON to the beneficiary and self-destruct (`mode: 128 + 32 + 2`). ⚠️ This sweep branch is implemented in code but **reverts on mainnet** with exit 36235 (see §8 K1); until fixed, a completed wallet retains its deposit as dust.

#### `bounced<JettonTransfer>` (claim settlement — failure path)
- If `pending_claim && query_id == pending_query_id`: `claimed -= pending_amount`, clear `pending_*`, emit `ClaimBounced`. A bounce with a non-matching query id is silently ignored (no `StaleBounceIgnored` event exists in this revision).

#### `receive()`
Plain TON top-ups accepted (gas).

> **No `Extend` and no `ResetPendingClaim` receivers exist in v5.0.0.** `unlock_at` is immutable, and a stuck `pending_claim` (settlement message never arriving) blocks further claims with no manual escape hatch (see §8 K2).

### Getters (exactly eight)
| Getter | Returns |
| :--- | :--- |
| `lockId()` | `lock_id` |
| `isFunded()` | `funded` |
| `jettonWallet()` | `jetton_wallet` (nullable) |
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
| `0xd1735400` | `JettonExcesses` | Incoming (settlement / gas refund) |

### TEP-89 / discovery (declared in `messages.tact`)
`ProvideWalletAddress`, `TakeWalletAddress` — opcodes per `messages.tact` (not restated here to avoid drift). `StartDiscovery` (`0x31`) is wallet-local.

### Platform control — Factory (byte-verified)
| Opcode | Message | Field order (serialization) | Sender → Receiver |
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
| Opcode | Message | Field order (serialization) | Sender → Receiver |
| :--- | :--- | :--- | :--- |
| `0x10` | `Claim` | `query_id → amount(coins)` | Beneficiary → Wallet |
| `0x31` | `StartDiscovery` | `query_id` | Factory → Wallet |

---

## 5. Events
*Ranges are disjoint so indexers can route events by opcode.*

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

> Earlier drafts of this spec listed `0x104 WithdrawBounced`, `0x108 OverpayRefunded`, `0x110 TonFeesWithdrawn`. **These are not emitted by `lockup_factory.tact` v5.0.0** and have been removed. Overpay refunds and fee-withdrawal bounces are silent state transitions; the only bounce-related emissions are `CreateBounced` + `RefundRequired`.

### Wallet (byte-verified — exactly these three are emitted)
| Opcode | Event | Fields |
| :--- | :--- | :--- |
| `0x124` | `LockFunded` | `lock_id, amount` |
| `0x125` | `Claimed` | `lock_id, amount, beneficiary, beneficiary_wallet` |
| `0x126` | `ClaimBounced` | `lock_id, amount` |

> Earlier drafts listed `0x127 PendingClaimReset`, `0x128 StaleBounceIgnored`, `0x129`/`0x12A` duplicates and an `Extended` event. **None of these exist in `lockup_wallet.tact` v5.0.0** (no `ResetPendingClaim` receiver, no `Extend` receiver, no `UnexpectedDeposit`/`StaleBounceIgnored` emissions) and have been removed.

---

## 6. Constants

### Factory (byte-verified against `lockup_factory.tact`)
| Name | Value | Purpose |
| :--- | :--- | :--- |
| `GAS_BUFFER_TON` | `0.1 TON` | Minimum gas buffer the user must attach on top of `fee_ton` |
| `DEPLOY_GAS` | `0.12 TON` | Gas the factory attaches when deploying the child wallet (internal) |
| `TRANSFER_GAS` | `0.05 TON` | Gas on the jetton transfer that funds the child / pays fees |
| `TRANSFER_FORWARD` | `0.01 TON` | `forward_ton_amount` so the child emits a notification |
| `DISCOVERY_GAS` | `0.05 TON` | Gas on the TEP-89 `ProvideWalletAddress` request |
| `RESCUE_GAS` | `0.05 TON` | Gas on a rescue jetton transfer |
| `MAX_LOCK_DURATION` | `315,360,000` (10y) | Max unlock horizon from creation |
| `MAX_FEE_BPS` | `1000` (10%) | Cap on the configurable jetton fee |
| `CREATE_LOCK_OP` | `0x1` | Payload opcode of `CreateLock` |
| `HIGH_BIT` | `1 << 63` | Separates create-transfer qids from treasury qids |
| `CREATE_LOCK_PAYLOAD_BITS` | `694` | Min payload size: op(32)+qid(64)+2×addr(267)+unlock(64) |

> The minimum user attach is `fee_ton + GAS_BUFFER_TON`. With current defaults (`fee_ton = 1 TON`) that is **1.1 TON**. `DEPLOY_GAS` (0.12) is the factory's internal child-deploy budget and is **not** part of the user-facing minimum.

### Wallet (byte-verified against `lockup_wallet.tact`)
| Name | Value | Purpose |
| :--- | :--- | :--- |
| `WALLET_DISCOVERY_GAS` | `0.05 TON` | Gas on a `provide_wallet_address` request to the master |
| `CLAIM_GAS` | `0.05 TON` | Gas on the outgoing claim `JettonTransfer` |
| `CLAIM_FORWARD` | `0.01 TON` | `forward_ton_amount` so the destination emits a notification |

> The claim `forward_payload` is a single `0` bit (`beginCell().storeBit(false)`), not an empty slice — some TEP-74 implementations (e.g. COGNIQ) revert an empty payload with exit 708. There is **no** `MAX_EXTEND_HORIZON`, `CLAIM_GAS` ≠ 0.07 (it is 0.05), and **no** `PENDING_TIMEOUT` constant in this revision.

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

### Wallet (I1–I6, byte-verified against source; I6 runtime-pending)
- **I1:** `claimed <= total_amount` (enforced by `want <= available` on claim and `claimed -= pending_amount` on bounce).
- **I2:** `pending_amount > 0` iff `pending_claim == true`.
- **I3:** `funded == true` only after a `JettonNotification` with `amount == total_amount` from the discovered jetton wallet (directly, or reconciled via `fund_sender` in `TakeWalletAddress`).
- **I4:** `jetton_wallet` is set at most once (discovery is idempotent; the `== null` guard in flow 1 prevents overwrite).
- **I5:** Claims are atomic — at most one pending claim per wallet (`!pending_claim` precondition on `Claim`).
- **I6:** After successful claim completion (`claimed >= total_amount`), all remaining TON balance is returned to the beneficiary and the contract self-destructs (no dust left). **⚠️ Implemented in the `JettonExcesses` handler, but the sweep branch reverts on mainnet with exit 36235 — see §8 K1. Until fixed, I6 holds in code but not in observed state.**

---

## 8. Known Limitations

### Runtime gaps (mainnet-observed)
- **K1 — Post-claim sweep / self-destruct reverts.** The `JettonExcesses` handler contains the sweep (`send(value: 0, mode: 128 + 32 + 2)` when `claimed >= total_amount`), but on mainnet this reverts with **exit code 36235**, so the wallet keeps its storage deposit as dust instead of destroying. Evidence: lock #1 claim delivered the jettons (+995 COGNIQ to the beneficiary) yet wallet `EQDt4Bjv…ocfSj8ul` ended at **0.253 GRAM**, not 0; reverting tx `d7c26f13…441cbb45`. Root cause is **not yet established** — it requires a decoded trace of the 36235 revert (raw Boc / decoded tx). A hypothesis that the `require(sender() == jetton_wallet)` guard fires before the sweep (because the excess arrived from an address that is not the cached `jetton_wallet`) is **unconfirmed** and must not be treated as the diagnosis. Fix path: decode → patch → redeploy factory (new salt) → fresh end-to-end claim to 0-balance. Until then, treat completed locks as leaving ~0.25 TON dust per wallet.
- **K2 — No on-chain extension, no manual pending reset.** `lockup_wallet.tact` v5.0.0 has no `Extend` receiver (so `unlock_at` is immutable and `creator` has no on-chain capability) and no `ResetPendingClaim` receiver (so if a settlement message never arrives, `pending_claim` sticks and further claims are blocked). These are deliberate absences in this revision, tracked for v6+ on the roadmap.
- **K3 — Stray jetton deposits revert, not ignored.** A `JettonNotification` from a sender other than the discovered `jetton_wallet`, or with an amount other than `total_amount`, hits a `require` and **reverts** the message (unless it arrives before discovery, in which case it is buffered into `fund_sender` only on exact amount match). Earlier drafts described these as "accepted but ignored" — that was wrong; the real behavior is revert.

### Factory design trade-offs (byte-verified)
- **L1:** `LockCreated` is emitted before the child jetton transfer confirms. If that transfer bounces, `CreateBounced` + `RefundRequired` follow. Frontends should treat a lock as canonical only after N blocks without a matching `CreateBounced` for the same `lock_id`.
- **L2:** If a create-transfer bounce is lost, the `pending_create` entry for that `lock_id` remains set. The entry is small and can be cleaned by a future migration.
- **L3:** A create-transfer bounce may leave an empty, unfunded deployed `LockupWallet`. Frontends must filter these via `LockCreationFailed` / `funded == false`.
- **L4:** A lost fee-withdrawal bounce leaves `pending_withdraw[qid]` set forever (no funds lost, but the treasury `query_id` is burned).

### Wallet design trade-offs (byte-verified)
- **W1:** Funding requires the **exact** `total_amount`; there are no top-ups and no partial funding. A wrong-amount deposit reverts (K3).
- **W2:** `claimed` is incremented in `TakeWalletAddress` flow 2 **before** the `JettonTransfer` is sent, so the in-flight amount is reserved atomically; a bounce rolls it back. This is correct but means `claimed` briefly exceeds the actually-delivered balance while a claim is in-flight (bounded by `pending_amount`, I2).
- **W3:** The wallet trusts the master's `TakeWalletAddress` response for both its own and the beneficiary's jetton-wallet address (TEP-89). A malicious master could misroute a claim; this is inherent to TEP-74/89 and mitigated by whitelisting only vetted masters.

---

## 9. Trust Model
| Party | Trusted for | Cannot do |
| :--- | :--- | :--- |
| **Treasury** | Whitelist masters, withdraw fees, emergency rescue (factory) | Steal locked jettons, modify existing locks |
| **Factory** | Deploy, one-time deposit via TEP-89, overpay / failed-create refund | Withdraw jettons from a funded `LockupWallet` |
| **Creator** | Receive overpay / failed-create refund from the factory | Touch an existing funded lock; change `unlock_at` (no `Extend`, K2) |
| **Beneficiary** | Claim after `unlock_at` (full or partial) | Claim before unlock, claim if unfunded; reset a stuck pending claim (no `ResetPendingClaim`, K2) |
| **Jetton master** | Answer TEP-89 `provide_wallet_address` truthfully | (Misrouting risk W3 — mitigate by whitelisting vetted masters only) |

> **⚠️ Treasury compromise impact:** DoS on *new* lock creation (bad addresses registered). **No theft of locked jettons.** Mitigated by a live 2-of-3 multisig + off-chain verifier.

---

## 10. Sequence Diagrams

### Create lock (byte-verified against factory)
```mermaid
sequenceDiagram
    participant User
    participant JW as JettonWallet (user)
    participant F as LockupFactory
    participant M as JettonMaster
    participant CW as Child LockupWallet
    participant CJW as Child JettonWallet

    User->>JW: JettonTransfer(amount, CreateLock payload, ≥1.1 TON)
    JW->>F: JettonNotification
    F->>F: wallet_to_master[sender] → master; whitelist + attach check
    F->>F: parse payload (Either bit, op==0x1, ≥694 bits); validate dates/qid
    F->>F: fee = amount*bps/10000; lock = amount-fee; ton_fees += fee_ton
    F->>User: refund overpay (value - fee_ton - 0.1)
    F->>CW: deploy StartDiscovery{id} (DEPLOY_GAS=0.12)
    F->>M: ProvideWalletAddress{qid = id|HIGH_BIT, owner = CW}
    F-->>User: emit LockCreated, TonFeeCollected
    M->>F: TakeWalletAddress{qid, owner=CW}
    F->>F: own_wallets[master] = factory JW
    F->>CJW: JettonTransfer(lock → CW) (TRANSFER_GAS / TRANSFER_FORWARD)
    CJW->>CW: JettonNotification
    CW->>CW: funded = true; emit LockFunded
```

### Claim (byte-verified against wallet; sweep branch marked pending)
```mermaid
sequenceDiagram
    participant Ben as Beneficiary
    participant CW as LockupWallet
    participant M as JettonMaster
    participant JW as JettonWallet (of CW)

    Ben->>CW: Claim(amount)
    CW->>CW: verify sender, funded, unlock_at, !pending, want<=available
    CW->>CW: pending_claim=true; pending_amount=want; pending_query_id=qid
    CW->>M: ProvideWalletAddress{qid, owner=Ben} (WALLET_DISCOVERY_GAS)
    M->>CW: TakeWalletAddress{qid, owner=Ben, wallet=BenJW}
    CW->>CW: claimed += pending_amount
    CW->>JW: JettonTransfer(pending_amount → Ben) (CLAIM_GAS / CLAIM_FORWARD)
    JW-->>CW: JettonExcesses{qid} (success)
    CW->>CW: clear pending_*
    alt claimed >= total_amount
        CW->>Ben: sweep all remaining TON + self-destruct (mode 128+32+2)
        Note over CW,Ben: ⚠️ K1 — this branch reverts 36235 on mainnet today;<br/>wallet keeps dust until fixed
    else partial claim
        CW-->>Ben: (wallet stays alive for further claims)
    end
```

### Claim bounce (rollback path)
```mermaid
sequenceDiagram
    participant CW as LockupWallet
    participant JW as JettonWallet (of CW)

    JW-->>CW: bounced<JettonTransfer>{qid}
    CW->>CW: if pending_claim && qid==pending_query_id: claimed -= pending_amount; clear pending_*
    CW-->>CW: emit ClaimBounced
```

---
*End of specification. Both contract halves are byte-verified against `lockup_factory.tact` / `lockup_wallet.tact` v5.0.0. The single open item is wallet invariant I6 (post-claim sweep), which is implemented in code but reverts on mainnet (K1) pending a decoded trace and a redeploy-and-verify cycle.*
