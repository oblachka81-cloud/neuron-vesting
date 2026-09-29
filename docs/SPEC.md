# 📜 NEURON Vesting — Contract Specification

**Version:** v5.1.1 (factory v5.0.3 + wallet v5.1.1)
**Language:** Tact 1.6.13
**Network:** TON Mainnet
**Status:** Internal review passed · 70 sandbox tests green · **mainnet-verified (full + partial lifecycle, v5.1.1)** · reset sandbox-verified · static analysis clean (Misti + Soufflé)

> **Note on versions.** The repository holds factory **v5.0.3** and wallet **v5.1.1**.
> v5.1.1 is a strict superset of v5.1.0: it adds the `ClaimSettled` (0x128) observability
> event and changes nothing else. v5.1.0 closed W4 (on-chain `ResetPendingClaim`) and made
> `claimed` settlement-only. v5.0.3 added the claim replay guard (Finding #4) and the
> bounce sender guard. The mainnet deployment is **live** and its full lifecycle is proven
> by the transactions listed in §11.3 — there are no pending mainnet items except the
> reset path, which is intentionally sandbox-only (see §8 W4 and §11.3).

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
11. [Security & Verification Details](#11-security--verification-details)

---

## 1. Overview

NEURON Vesting is a non-custodial, immutable token lockup system on TON. Users lock TEP-74
jettons with a transparent schedule. The unlock date is fixed at creation and cannot be
changed on-chain. Locked tokens are released to the beneficiary only after `unlock_at`, and
the wallet self-destructs once fully claimed.

### Components

- **LockupFactory** — Singleton. Receives jetton transfers, deploys `LockupWallet`
  instances, forwards jettons via TEP-89 discovery, and accumulates platform fees.
- **LockupWallet** — One instance per lock. Holds jettons, enforces the schedule, releases
  to the beneficiary on claim, and self-destructs on final **confirmed** claim.
- **messages.tact** — Shared TEP-74 / TEP-89 message declarations.

### Jetton-wallet resolution (both contracts)

Neither contract computes a jetton-wallet address from StateInit / c4. Both ask the jetton
master via TEP-89 `provide_wallet_address` and cache the response. This makes the system
agnostic to the internal layout of any TEP-74 wallet implementation.

### Settlement-only accounting (v5.1.0+)

A claim is **dispatched** (`Claimed` 0x125) and only later **confirmed** (`ClaimSettled`
0x128) when `JettonExcesses` arrives. `claimed` moves **only** on confirmation. This is what
makes the on-chain reset safe: a stuck in-flight claim can be cleared without ever having
pre-booked accounting, so reset never corrupts balances. Indexers and UIs must treat
**0x128 as "paid"** and **0x125 as "in flight"** — conflating them is the exact bug v5.1.1
was designed to prevent.

---

## 2. Contract: LockupFactory

### State

| Field | Type | Description |
|---|---|---|
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
| `consumed_forward` | `map<Int, Bool>` | `lock_id` → forward already dispatched (v5.0.3, Finding #3) |
| `create_*` | `map<Int, …>` | Temporary create-state for bounce recovery |
| `pending_withdraw` / `pending_withdraw_jetton` / `cleared_withdraw` | maps | Treasury withdrawal in-flight state |

### Query-id namespaces

Two disjoint id spaces share the contract:

- **Create transfers:** `qid = lock_id | HIGH_BIT` (high bit set). Tracked via
  `pending_create` / `consumed_forward`, not via `used_qids`.
- **Treasury ops:** `qid = msg.query_id` with the high bit clear. Guarded by `used_qids`
  (monotonic) on `WithdrawFees`, `WithdrawTonFees`, `RescueTon`, `RescueJetton`. The
  fee-config setters `SetFeeBps` / `SetFeeTon` are idempotent state writes and intentionally
  do not consume `used_qids`.

### Receivers

#### `SetJettonWallet` (0x21, treasury only)

Registers a factory-owned jetton wallet for a given master.

- **Preconditions:** `sender() == treasury`, `msg.query_id > 0`,
  `own_wallets[jetton_master]` unset or equals `jetton_wallet`.
- **Effects:** `own_wallets[m] = w`, `wallet_to_master[w] = m`. Emits `JettonWalletSet`.
- **Security:** the address is derived off-chain from the master's
  `get_wallet_address(factory)` by three independent generators (off-chain verifier,
  `add-jetton.ts`, admin approve flow) that emit identical bytes
  (`qid → jetton_master → jetton_wallet`). The on-chain bijection guard (CHECK2) rejects
  cross-master wallet reuse. **Mainnet-verified:** tx `4bcce14f…d9e703c0` (COGNIQ,
  factory JW `EQBCGegQ5…WO2USM`).

#### `SetFeeBps` (0x25) / `SetFeeTon` (0x26) (treasury only)

Update `fee_bps` (capped at `MAX_FEE_BPS = 10%`) / `fee_ton`. Idempotent setters; no replay
guard needed.

#### `JettonNotification` (any user, via whitelisted jetton wallet)

Main entry point for lock creation.

- **Preconditions:**
  - `wallet_to_master[sender()] != null` (sender is a factory JW of a known master)
  - `own_wallets[master] != null` (master whitelisted)
  - `context().value >= fee_ton + GAS_BUFFER_TON` → **with mainnet defaults
    (`fee_ton = 0.1`) this is ≥ 0.2 TON**
  - `forward_payload` decodes: consume the TEP-74 `Either` bit, then require
    `bits >= CREATE_LOCK_PAYLOAD_BITS` (694) and `preloadUint(32) == CREATE_LOCK_OP` (0x1);
    else emit `LockCreationFailed` + `RefundRequired` and return without state change
  - parsed `jetton_master` field equals the reverse-mapped master (`jm_in == jetton_master`)
  - `unlock_at > now()` and `unlock_at <= now() + MAX_LOCK_DURATION`
  - client `qid > 0`
  - `lock_amount = amount - fee > 0` where `fee = amount * fee_bps / 10000`
- **Effects:**
  - `ton_fees += fee_ton`; overpay (`value - fee_ton - GAS_BUFFER_TON`) refunded to creator
    immediately
  - `fees[master] += fee`
  - `id = next_id++`; deploy `LockupWallet` with `DEPLOY_GAS` and body
    `StartDiscovery{query_id: id}`
  - send `ProvideWalletAddress{query_id: id | HIGH_BIT, owner_address: child}` to the master
    (TEP-89)
  - record `pending_create[id]`, `consumed_forward[id] = false`, and `create_*[id]` for
    bounce recovery
  - emit `LockCreated`, `TonFeeCollected`
- **Mainnet-verified:** tx `c3af5454…08ec3413` (lock #1, `LockCreated` 0x100 +
  `TonFeeCollected` 0x106, child deployed, overpay refunded).

#### `TakeWalletAddress` (TEP-89 response from the master)

- **Preconditions:** `(qid & HIGH_BIT) != 0`, `pending_create[id]` set, `owner_address`
  present and equals the child, `sender() == create_jetton[id]`.
- **Effects (v5.0.3 replay guard, Finding #3):** if `consumed_forward[id]` is already set,
  the duplicate response is **silently dropped** (no second transfer); otherwise forward the
  locked jettons from `own_wallets[master]` to the child via
  `JettonTransfer{query_id: qid, amount: lock_amount, destination: child, …}` with
  `TRANSFER_GAS` / `TRANSFER_FORWARD`, and set `consumed_forward[id] = true`.
- **Atomicity:** a wrong-owner response reverts **without** consuming the forward, so a
  later correct response still forwards (test 22). Per-id isolation holds (test 23).
- **Mainnet-verified:** tx `1ff2b7c0…68a65764` — exactly **one** `jetton_transfer` left the
  factory JW for lock #1 (no duplicate forward; guard not falsely triggered on the legit
  single response).

#### `WithdrawFees` (0x20) / `WithdrawTonFees` (0x22) (treasury only)

- **Preconditions:** `sender() == treasury`, `query_id > 0`, `query_id` not in `used_qids`,
  `amount > 0`, sufficient balance (`fees[master] >= amount` for jettons;
  `ton_fees >= amount` for TON); for jettons also `own_wallets[master] != null`.
- **Effects:** mark `used_qids[qid] = true`; deduct balance; for jettons set
  `pending_withdraw[qid]`, `pending_withdraw_jetton[qid]`, `cleared_withdraw[qid] = false`
  and send `JettonTransfer` to `destination_wallet`; emit `FeesWithdrawn`. For TON, send
  `value = amount` to destination.

#### `RescueTon` (0x23) / `RescueJetton` (0x24) (treasury only, emergency)

Same replay guard as withdrawals. `RescueTon` reserves `ton_fees + 0.05` and only sends
`myBalance() - reserved`. `RescueJetton` requires the master whitelisted and forwards from
`own_wallets[master]`.

#### `bounced`

Two cases disambiguated by the high bit of `query_id`:

- **Create-transfer bounce** (`qid & HIGH_BIT != 0`): matches `pending_create[id]`; verifies
  sender is `own_wallets[create_jetton[id]]`; rolls back `fees[master]` (saturated at 0);
  if `ton_fees >= create_fee_ton[id]`, deducts it and refunds
  `create_fee_ton + GAS_BUFFER_TON` to the creator; emits `CreateBounced` + `RefundRequired`;
  clears all `pending_create` / `create_*` / `consumed_forward` entries.
- **Fee-withdrawal bounce** (`qid & HIGH_BIT == 0`): matches `pending_withdraw[qid]` only
  when `cleared_withdraw[qid]` is false; verifies sender is
  `own_wallets[pending_withdraw_jetton[qid]]`; restores `fees[master] += amount`; sets
  `cleared_withdraw[qid] = true` so a duplicated bounce cannot double-credit.

#### `JettonExcesses` / `receive()`

`JettonExcesses` is an explicit no-op (without it, gas-refund excesses would abort with
exit 130). Plain TON top-ups are accepted. **Mainnet-verified:** tx
`df11fd06…f76bf1d9` — an excesses callback landed on the factory and was accepted (exit 0),
not aborted.

### Getters

| Getter | Returns |
|---|---|
| `nextLockId()` | `next_id` |
| `feeBps()` / `feeTon()` | `fee_bps` / `fee_ton` |
| `tonFees()` | `ton_fees` |
| `feeOf(jetton)` | `fees[jetton]` or 0 |
| `isWalletSet(jetton)` | whether master is whitelisted |
| `walletOf(jetton)` | `own_wallets[jetton]` |
| `pendingCreateOf(lockId)` | pending child address |
| `isForwardConsumed(lockId)` | `consumed_forward[lockId]` (v5.0.3) |

---

## 3. Contract: LockupWallet

### State

| Field | Type | Description |
|---|---|---|
| `lock_id` | `Int as uint64` | Unique lock id |
| `factory` | `Address` | Factory that deployed this wallet |
| `jetton_master` | `Address` | Jetton master of locked tokens |
| `beneficiary` | `Address` | Who can claim after unlock |
| `creator` | `Address` | Original jetton owner (recorded; no on-chain capability) |
| `total_amount` | `Int as coins` | Locked amount (immutable) |
| `claimed` | `Int as coins` | **Confirmed settlements only** (v5.1.0) |
| `unlock_at` | `Int as uint64` | Unix timestamp when claim becomes available |
| `jetton_wallet` | `Address?` | This wallet's jetton wallet, resolved via TEP-89 (set at most once) |
| `beneficiary_wallet` | `Address?` | Beneficiary's jetton wallet, cached during claim (v5.0.1) |
| `fund_sender` | `Address?` | Notification sender observed before discovery completed |
| `funded` | `Bool` | true once the exact expected amount was received |
| `pending_claim` | `Bool` | true while a claim is in-flight |
| `pending_amount` | `Int as coins` | Amount of the in-flight claim (> 0 iff `pending_claim`) |
| `pending_query_id` | `Int as uint64` | Query id of the in-flight claim |
| `pending_set_at` | `Int as uint64` | **v5.1.0** age anchor for the reset timeout |
| `consumed_claim` | `map<Int, Bool>` | **v5.0.3** per-qid dispatch replay guard (Finding #4) |

### Receivers

#### `StartDiscovery` (0x31, factory only)

- **Preconditions:** `sender() == factory`.
- **Effects:** send `ProvideWalletAddress{query_id: lock_id, owner_address: myAddress()}` to
  the master with `WALLET_DISCOVERY_GAS`.
- **Mainnet-verified:** tx `44e2c872…729f5e9c` (lock #1 child) and `538d5b02…c30ecf0d`
  (lock #2 child).

#### `TakeWalletAddress` (TEP-89 response from the master)

Reached for two distinct flows, both requiring `sender() == jetton_master` and a present
`owner_address`:

- **Flow 1 — discover own wallet** (`owner == myAddress() && jetton_wallet == null`): cache
  `jetton_wallet = msg.wallet_address`. If a funding notification arrived before discovery
  (`fund_sender == msg.wallet_address && !funded`), reconcile now: `funded = true`, clear
  `fund_sender`, emit `LockFunded`. **Mainnet-verified:** tx `b2907b94…493507f0` (lock #1,
  `0xd1735400`), `81164856…17ae5686` (lock #2).
- **Flow 2 — dispatch pending claim** (`pending_claim && owner == beneficiary &&
  query_id == pending_query_id`): **v5.0.3 replay guard** — if `consumed_claim[qid]` is set,
  silently drop (no second transfer); else set `consumed_claim[qid] = true`, cache
  `beneficiary_wallet = msg.wallet_address`, and send
  `JettonTransfer{query_id, amount: pending_amount, destination: beneficiary,
  response_destination: myAddress(), forward_ton_amount: CLAIM_FORWARD, forward_payload:
  <single 0 bit>}` from `jetton_wallet` with `CLAIM_GAS`; emit `Claimed` (0x125).
  **`claimed` is NOT moved here** (v5.1.0). Requires `jetton_wallet != null`.
  **Mainnet-verified:** tx `d026f92b…cf4f94a9` (lock #1), `92473423…4ded6e96` and
  `57b92636…804cef19` (lock #2, two dispatches across two claim cycles).

#### `JettonNotification` (funding)

If `jetton_wallet == null`: buffer the sender into `fund_sender` only when
`amount == total_amount`; return (no revert — discovery may not have completed yet). Else:
`require(sender() == jetton_wallet)`, `require(!funded)`, `require(amount == total_amount)`;
set `funded = true`; emit `LockFunded` (0x124). A deposit from any other sender, or with a
wrong amount, reverts. **Mainnet-verified:** tx `b65a4cfb…cb3ee109` (lock #1, 0x124),
`0ad1b160…6ebb71e8` (lock #2, 0x124).

#### `Claim` (0x10, beneficiary only)

- **Preconditions:** `sender() == beneficiary`, `funded`, `now() >= unlock_at`,
  `!pending_claim`, `query_id > 0`, `available = total_amount - claimed > 0`,
  `want = (amount == 0 ? available : amount)` with `0 < want <= available`.
- **Effects:** set `pending_claim = true`, `pending_amount = want`,
  `pending_query_id = query_id`, **`pending_set_at = now()`** (v5.1.0); send
  `ProvideWalletAddress{query_id, owner_address: beneficiary}` to the master with
  `WALLET_DISCOVERY_GAS`. The actual jetton transfer happens later in flow 2.
- **Mainnet-verified:** tx `c0d00a94…ac61d9f1` (lock #1 full), `f3112870…572d67f2`
  (lock #2 partial 500), `b23c7b48…9657106b` (lock #2 remainder).

#### `ResetPendingClaim` (0x11, beneficiary only) — **v5.1.0**

On-chain escape hatch for a stuck `pending_claim`.

- **Preconditions:** `sender() == beneficiary`, `pending_claim`,
  `now() >= pending_set_at + RESET_TIMEOUT` (3600s).
- **Effects:** clear `pending_claim / pending_amount / pending_query_id / pending_set_at`;
  clear `consumed_claim[qid]` so the qid is reusable; **`claimed` intentionally untouched**
  (I8 — nothing was pre-booked); emit `ClaimReset` (0x127).
- **Verification status:** **sandbox-only** (tests 63–67). On COGNIQ this path is
  unreachable by design — settlement always arrives recognizably, so `pending` clears in
  seconds and the 1-hour timeout never elapses while a claim is in flight. Reset exists as
  the safety net for foreign masters whose callbacks may never arrive. See §8 W4.

#### `JettonExcesses` (claim settlement — success path)

- **Preconditions (v5.0.1):** `sender() == jetton_wallet || sender() == beneficiary_wallet`
  (the second valid sender is cached during claim flow 2). TEP-74 copies
  `response_destination` into `internal_transfer`, so the receiving-side jetton wallet (the
  beneficiary's) also returns excesses; COGNIQ's sending-side wallet returns none. Accepting
  only the sending side reverted the only excess that ever arrived (exit 36235, v5.0.0).
- **Effects (v5.1.0/v5.1.1):** if `pending_claim && query_id == pending_query_id`:
  1. `claimed += pending_amount` (**confirmation happens here, not at dispatch**);
  2. **emit `ClaimSettled` (0x128) before clearing state and before any destroy** (v5.1.1,
     I9) so settlement is observable even on the final claim;
  3. clear `pending_*` and `consumed_claim[qid]`;
  4. if `claimed >= total_amount`, sweep all remaining TON to the beneficiary and
     self-destruct (`SendRemainingBalance | SendIgnoreErrors | 32`).
- Late excesses after a reset: `pending_claim == false` → ignored (I8), no double-book, no
  destroy.
- **Mainnet-verified:** tx `43da42f2…64319f00` (lock #1: 0x128 + sweep + destroy, balance 0,
  Nonexist), `f25ce1b2…8e30d2ae` (lock #2 settle #1: 0x128, **contract alive**, 495 left),
  `afc8c488…9b41f110` (lock #2 settle #2: 0x128 + sweep + destroy, balance 0, Nonexist).

#### `bounced` (claim settlement — failure path)

- **v5.0.3 defense-in-depth:** `require(sender() == jetton_wallet)` — a bounce from any
  other address is rejected, leaving `pending` intact.
- If `pending_claim && query_id == pending_query_id`: **`claimed` untouched** (v5.1.0 — was
  never pre-booked on dispatch); clear `pending_*` and `consumed_claim[qid]`; emit
  `ClaimBounced` (0x126). A bounce with a non-matching query id is silently ignored.
- **Verification status:** **sandbox** (tests 68–69, full-TEP-74-body injection with
  auto-detected bounce prefix). The wallet bounce branch is now covered offline; the
  **factory** `consumed_forward` bounce-cleanup remains an integration debt (different
  injection, not covered by 68/69). See §11.3.

#### `receive()`

Plain TON top-ups accepted (gas).

### Getters

| Getter | Returns |
|---|---|
| `lockId()` | `lock_id` |
| `isFunded()` | `funded` |
| `jettonWallet()` | `jetton_wallet` (nullable) |
| `beneficiaryWallet()` | `beneficiary_wallet` (nullable, v5.0.1) |
| `unlockAt()` | `unlock_at` |
| `beneficiaryGet()` | `beneficiary` |
| `claimedAmount()` | `claimed` (confirmed settlements only) |
| `isPendingClaim()` | `pending_claim` |
| `pendingSetAt()` | `pending_set_at` (v5.1.0) |
| `availableClaimable()` | 0 if `!funded` or `pending_claim` or `now() < unlock_at`, else `total_amount - claimed` |
| `isClaimConsumed(qid)` | `consumed_claim[qid]` (v5.0.3) |

---

## 4. Message Types & Opcodes

### TEP-74 standard

| Opcode | Message | Direction |
|---|---|---|
| `0x0f8a7ea5` | `JettonTransfer` | Outgoing |
| `0x7362d09c` | `JettonNotification` | Incoming |
| `0xd53276db` | `JettonExcesses` | Incoming (settlement / gas refund) |
| `0x178d4519` | `JettonInternalTransfer` | Internal (TEP-74) |

### TEP-89 / discovery (declared in messages.tact)

`ProvideWalletAddress` (`0x2c76b973`), `TakeWalletAddress` (`0xd1735400`).
`StartDiscovery` (`0x31`) is wallet-local.

### Platform control — Factory (byte-verified)

| Opcode | Message | Field order | Sender → Receiver |
|---|---|---|---|
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
|---|---|---|---|
| `0x10` | `Claim` | `query_id → amount(coins)` | Beneficiary → Wallet |
| `0x11` | `ResetPendingClaim` (v5.1.0) | `query_id` | Beneficiary → Wallet |
| `0x31` | `StartDiscovery` | `query_id` | Factory → Wallet |

---

## 5. Events

Ranges are disjoint so indexers can route events by opcode.

### Factory (byte-verified — exactly these seven are emitted)

| Opcode | Event | Fields |
|---|---|---|
| `0x100` | `LockCreated` | `lock_id, creator, beneficiary, jetton, amount, unlock_at` |
| `0x106` | `TonFeeCollected` | `lock_id, amount` |
| `0x107` | `FeesWithdrawn` | `query_id, jetton_master, amount, destination` |
| `0x109` | `JettonWalletSet` | `jetton_master, jetton_wallet` |
| `0x111` | `LockCreationFailed` | `lock_id, creator, jetton, amount` |
| `0x112` | `CreateBounced` | `lock_id, amount` |
| `0x115` | `RefundRequired` | `creator, jetton, amount` |

### Wallet (byte-verified — exactly these five are emitted)

| Opcode | Event | Fields | Semantics |
|---|---|---|---|
| `0x124` | `LockFunded` | `lock_id, amount` | funding confirmed |
| `0x125` | `Claimed` | `lock_id, amount, beneficiary, beneficiary_wallet` | **DISPATCH** — not yet paid |
| `0x126` | `ClaimBounced` | `lock_id, amount` | dispatch failed, `claimed` untouched |
| `0x127` | `ClaimReset` (v5.1.0) | `lock_id, query_id` | stuck claim cleared by beneficiary |
| `0x128` | `ClaimSettled` (v5.1.1) | `lock_id, amount, query_id` | **CONFIRMED PAYOUT** — the only "paid" event |

> **Indexer/UI contract.** `claimed_amount` in the database must advance **only** on
> `ClaimSettled` (0x128). `Claimed` (0x125) drives an "in flight" badge, never a payout.
> This separation is the whole point of v5.1.0/v5.1.1 and is enforced in `bot/indexer.js`
> (`markClaimed` is called on 0x128 only) and `web/cabinet.ts` (money is DB-authoritative).

---

## 6. Constants

### Factory (byte-verified against lockup_factory.tact v5.0.3)

| Name | Value | Purpose |
|---|---|---|
| `GAS_BUFFER_TON` | 0.1 TON | Minimum gas buffer the user must attach on top of `fee_ton` |
| `DEPLOY_GAS` | 0.12 TON | Gas the factory attaches when deploying the child wallet (internal) |
| `TRANSFER_GAS` | 0.05 TON | Gas on the jetton transfer that funds the child / pays fees |
| `TRANSFER_FORWARD` | 0.01 TON | `forward_ton_amount` so the child emits a notification |
| `DISCOVERY_GAS` | 0.05 TON | Gas on the TEP-89 `ProvideWalletAddress` request |
| `RESCUE_GAS` | 0.05 TON | Gas on a rescue jetton transfer |
| `MAX_LOCK_DURATION` | 315,360,000 (10y) | Max unlock horizon from creation |
| `MAX_FEE_BPS` | 1000 (10%) | Cap on the configurable jetton fee |
| `CREATE_LOCK_OP` | 0x1 | Payload opcode of `CreateLock` |
| `HIGH_BIT` | `1 << 63` | Separates create-transfer qids from treasury qids |
| `CREATE_LOCK_PAYLOAD_BITS` | 694 | Min payload size: `op(32)+qid(64)+2×addr(267)+unlock(64)` |

> **Minimum user attach = `fee_ton + GAS_BUFFER_TON`.** On **mainnet** the deployed
> `fee_ton = 0.1` TON, so the minimum attach is **0.2 TON**. The historical 1.1 TON figure
> in older docs corresponds to the *test* init (`fee_ton = 1`); it is **not** the production
> number. `DEPLOY_GAS` (0.12) is the factory's internal child-deploy budget and is not part
> of the user-facing minimum.

### Wallet (byte-verified against lockup_wallet.tact v5.1.1)

| Name | Value | Purpose |
|---|---|---|
| `WALLET_DISCOVERY_GAS` | 0.05 TON | Gas on a `provide_wallet_address` request to the master |
| `CLAIM_GAS` | 0.05 TON | Gas on the outgoing claim `JettonTransfer` |
| `CLAIM_FORWARD` | 0.01 TON | `forward_ton_amount` so the destination emits a notification |
| `RESET_TIMEOUT` | 3600 (v5.1.0) | Min seconds a pending claim must age before `ResetPendingClaim` |

> The claim `forward_payload` is a single 0 bit (`beginCell().storeBit(false)`), not an
> empty slice — some TEP-74 implementations (e.g. COGNIQ) revert an empty payload with
> exit 708.

### Deployed mainnet parameters (from deploy log)

| Parameter | Value |
|---|---|
| Factory address | `EQD_dSnLqcBiQyT2LRyNPIUpqAY9Qr9VoMgUCKtHN5xpSCTN` |
| Treasury | `EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl` (2-of-3 multisig) |
| `salt` | 10 |
| `fee_bps` | 50 (0.5%) |
| `fee_ton` | 0.1 TON |
| COGNIQ master | `EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg` |
| COGNIQ factory JW | `EQBCGegQ5KLJVUq2_rvO3TJx9D73ITblS-wIkHMYiBWO2USM` |

> Because `salt` and `fee_ton` differ from the sandbox init (`salt=3`, `fee_ton=1`), the
> **deterministic child-wallet addresses on mainnet differ from test vectors**. Do not
> cross-check child addresses against sandbox fixtures.

---

## 7. Invariants

### Factory (F1–F8, byte-verified)

- **F1:** `next_id` strictly increases, never reused.
- **F2:** `own_wallets[m]` set ⇔ master `m` whitelisted by treasury.
- **F3:** `wallet_to_master[w] = m ⇔ own_wallets[m] = w` (strict bijection).
  *Mainnet:* tx `4bcce14f…d9e703c0` (COGNIQ registered, no cross-binding).
- **F4:** `fees[m]` = cumulative `fee_bps`-equivalent cuts − withdrawals (saturated at 0 on
  create-bounce rollback).
- **F5:** `pending_withdraw[qid]`, `pending_withdraw_jetton[qid]`, `cleared_withdraw[qid]`
  are written together on withdraw; `cleared_withdraw` flips false → true exactly once on
  bounce, so a duplicated bounce cannot double-credit.
- **F6:** `used_qids` monotonic (once true, never false); applies to treasury withdraw/rescue
  ops. Create-transfer ids live in the `HIGH_BIT` namespace and are tracked by
  `pending_create` / `consumed_forward`, not `used_qids`. Fee-config setters are idempotent
  and bypass `used_qids`.
- **F7:** `pending_create[id]` and all `create_*[id]` are set together at create and cleared
  together on bounce.
- **F8:** `ton_fees >= 0` at all times; overpay never retained.
  *Mainnet:* tx `c3af5454…08ec3413` (overpay refunded to creator).
- **F9 (v5.0.3, Finding #3):** at most one forward `JettonTransfer` per `lock_id`; a
  duplicate `TakeWalletAddress` is silently dropped. *Mainnet:* tx `1ff2b7c0…68a65764`
  (exactly one forward for lock #1).

### Wallet (I1–I9, byte-verified; I6/I8/I9 mainnet-verified)

- **I1:** `claimed <= total_amount` (enforced by `want <= available` on claim and by
  settlement-only increments).
- **I2:** `pending_amount > 0` iff `pending_claim == true`.
- **I3:** `funded == true` only after a `JettonNotification` with `amount == total_amount`
  from the discovered jetton wallet (directly, or reconciled via `fund_sender` in
  `TakeWalletAddress`). *Mainnet:* tx `b65a4cfb…cb3ee109`, `0ad1b160…6ebb71e8`.
- **I4:** `jetton_wallet` is set at most once (discovery is idempotent; the `== null` guard
  in flow 1 prevents overwrite).
- **I5:** Claims are atomic — at most one pending claim per wallet (`!pending_claim`
  precondition on `Claim`).
- **I6:** After a **confirmed** final claim (`claimed >= total_amount`), all remaining TON
  balance is returned to the beneficiary and the contract self-destructs (no dust left).
  *Mainnet:* tx `43da42f2…64319f00` (lock #1, balance 0 / Nonexist) and
  `afc8c488…9b41f110` (lock #2 final, balance 0 / Nonexist). The negative case — a partial
  settle that must **not** destroy — is *mainnet*-verified by tx `f25ce1b2…8e30d2ae`
  (lock #2 settle #1, contract alive with 495 left).
- **I7 (v5.0.3, Finding #4):** at most one `JettonTransfer` dispatch per `pending_claim`
  lifecycle (`consumed_claim` guard); settlement clears the guard so the qid is reusable
  without DoS.
- **I8 (v5.1.0):** `claimed` reflects **only** confirmed settlements; `ResetPendingClaim`
  never mutates `claimed`; double-spend is impossible regardless of reset (the jetton wallet
  physically caps balance). *Mainnet (positive side):* dispatch txs
  `d026f92b…cf4f94a9` / `92473423…4ded6e96` / `57b92636…804cef19` left `claimed` at 0 until
  the matching `ClaimSettled` moved it.
- **I9 (v5.1.1):** every confirmed settlement emits `ClaimSettled` (0x128) **before**
  clearing pending state and before possible self-destruct, so payout is observable even on
  the final claim. *Mainnet:* tx `43da42f2…64319f00` and `afc8c488…9b41f110` both carry the
  0x128 external-out in the same transaction as the sweep/destroy.

---

## 8. Design Trade-offs

### Factory

- **L1:** `LockCreated` is emitted before the child jetton transfer confirms. If that
  transfer bounces, `CreateBounced` + `RefundRequired` follow. Frontends should treat a lock
  as canonical only after N blocks without a matching `CreateBounced` for the same `lock_id`.
- **L2:** If a create-transfer bounce is lost, the `pending_create` entry for that `lock_id`
  remains set. The entry is small and can be cleaned by a future migration.
- **L3:** A create-transfer bounce may leave an empty, unfunded deployed `LockupWallet`.
  Frontends must filter these via `LockCreationFailed` / `funded == false`.
- **L4:** A lost fee-withdrawal bounce leaves `pending_withdraw[qid]` set forever (no funds
  lost, but the treasury query_id is burned).

### Wallet

- **W1:** Funding requires the exact `total_amount`; there are no top-ups and no partial
  funding. A wrong-amount deposit reverts.
- **W2 (rewritten for v5.1.0):** `claimed` is incremented **only** on `JettonExcesses`
  (settlement), never at dispatch. Therefore an in-flight claim reserves nothing in
  `claimed`; the jetton wallet's physical balance is the only cap during flight. This is
  what makes W4's reset safe and is the inverse of the old optimistic model.
- **W3:** The wallet trusts the master's `TakeWalletAddress` response for both its own and
  the beneficiary's jetton-wallet address (TEP-89). A malicious master could misroute a
  claim; this is inherent to TEP-74/89 and mitigated by whitelisting only vetted masters.
- **W4 (CLOSED in v5.1.0):** a stuck `pending_claim` (settlement never arriving in a
  recognized form) is **no longer irreversible**. `ResetPendingClaim` (beneficiary-only,
  after `RESET_TIMEOUT`) clears the in-flight state and the dispatch guard without touching
  `claimed`, closing the loop. **Verification boundary:** reset is **sandbox-verified**
  (tests 63–67), **not** mainnet-verified, because on COGNIQ the path is unreachable by
  design — settlement always arrives recognizably, so `pending` clears in seconds and the
  1-hour timeout never elapses while a claim is in flight. Reset is the safety net for
  foreign masters whose callbacks may never arrive; treating that as a mainnet gap would be
  misleading, so it is documented as a deliberate sandbox-only guarantee.
- **R1 (residual, accepted):** if a dispatch succeeded but its excesses was lost forever
  (α), a reset leaves `claimed = 0` with an empty jetton wallet: no funds lost, no
  double-spend, but accounting understates and self-destruct does not fire. Inherent to
  lost-delivery settlement; mitigated for COGNIQ by the wide excesses guard (v5.0.1). Reset
  is the safety net for foreign masters.

---

## 9. Trust Model

| Party | Trusted for | Cannot do |
|---|---|---|
| Treasury | Whitelist masters, withdraw fees, emergency rescue, retune fees | Steal locked jettons, modify existing locks |
| Factory | Deploy, one-time deposit via TEP-89, overpay / failed-create refund | Withdraw jettons from a funded `LockupWallet` |
| Creator | Receive overpay / failed-create refund from the factory | Touch an existing funded lock; change `unlock_at` |
| Beneficiary | Claim after `unlock_at` (full or partial); **reset a stuck pending claim** (v5.1.0) | Claim before unlock, claim if unfunded; inflate `claimed` via reset (I8) |
| Jetton master | Answer TEP-89 `provide_wallet_address` truthfully | — (misrouting risk W3 — mitigate by whitelisting vetted masters only) |

> **Treasury compromise impact:** DoS on new lock creation (bad addresses registered). No
> theft of locked jettons. Mitigated by a live 2-of-3 multisig + off-chain verifier.
>
> **v5.1.0 change:** the beneficiary row gained "reset a stuck pending claim". This is safe
> precisely because of I8 — reset cannot move `claimed`, so it cannot be abused to claim
> twice; the jetton wallet's physical balance remains the hard cap.

---

## 10. Sequence Diagrams

### Create lock (byte-verified against factory v5.0.3)

```
User         User JW        Factory          Master        Child LW      Child JW
 │              │               │                │              │              │
 │ JettonTransfer(amount,       │                │              │              │
 │  CreateLock payload, ≥0.2 T) │                │              │              │
 ├─────────────▶│               │                │              │              │
 │              │ JettonNotif   │                │              │              │
 │              ├──────────────▶│                │              │              │
 │              │               │ reverse-map sender → master   │              │
 │              │               │ check whitelist + attach value │             │
 │              │               │ parse payload (Either bit,    │              │
 │              │               │  op=0x1, ≥694 bits)           │              │
 │              │               │ fee = amount*bps/10000        │              │
 │              │               │ lock_amount = amount - fee    │              │
 │              │               │ ton_fees += fee_ton           │              │
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
 │              │               │ [v5.0.3] consumed_forward guard: one forward │
 │              │               │ JettonTransfer(lock_amount → child)          │
 │              │               ├─────────────────────────────────────────────▶│
 │              │               │                │              │ JettonNotif  │
 │              │               │                │              │◀─────────────│
 │              │               │                │              │ funded=true  │
 │              │               │                │              │ emit LockFunded
```

**Mainnet proof (lock #1):** create `c3af5454…08ec3413` · forward (one) `1ff2b7c0…68a65764`
· child deploy `44e2c872…729f5e9c` · flow1 `b2907b94…493507f0` · funded `b65a4cfb…cb3ee109`.

### Claim — full (settlement-only, v5.1.1)

```
Beneficiary       LockupWallet          Master         own JW         Ben JW
     │                 │                   │              │              │
     │ Claim(amount)   │                   │              │              │
     ├────────────────▶│ verify sender, funded, unlock_at, !pending      │
     │                 │ pending_claim=true, pending_amount, pending_qid │
     │                 │ pending_set_at=now                              │
     │                 │ ProvideWalletAddress{qid, owner=Ben} (0.05 T)   │
     │                 ├──────────────────▶│              │              │
     │                 │◀── TakeWalletAddress{qid,owner=Ben,wallet=BenJW}│
     │                 │ cache beneficiary_wallet = BenJW                │
     │                 │ [v5.0.3] consumed_claim guard                   │
     │                 │ claimed NOT moved (v5.1.0)                      │
     │                 │ JettonTransfer(pending_amount → Ben) (0.05 T)   │
     │                 ├────────────────────────────────────────────────▶│
     │                 │ emit Claimed (0x125) = DISPATCH                 │
     │                 │◀── JettonExcesses{qid} (exit 0) from own OR ben JW
     │                 │ claimed += pending_amount                       │
     │                 │ emit ClaimSettled (0x128)  ← CONFIRMED PAYOUT   │
     │                 │ clear pending_*                                 │
     │                 │ if claimed >= total_amount:                     │
     │                 │   sweep all TON + self-destruct (128+32+2)      │
     │◀── sweep + destroy                                                │
     │                 │  (balance → 0, status → Nonexist)               │
```

**Mainnet proof (lock #1, full):** claim `c0d00a94…ac61d9f1` · dispatch `d026f92b…cf4f94a9`
(`claimed` still 0) · settle+destroy `43da42f2…64319f00` (0x128, balance 0, Nonexist).

### Claim — partial (two cycles, I6 positive + negative)

```
Beneficiary       LockupWallet
     │ Claim(500)  ├────────▶ dispatch 0x125 · settle 0x128 · claimed=500 · CONTRACT ALIVE (495 left)
     │ Claim(all)  ├────────▶ dispatch 0x125 · settle 0x128 · claimed=995 · sweep + DESTROY
```

**Mainnet proof (lock #2, partial):** claim1 `f3112870…572d67f2` · dispatch1
`92473423…4ded6e96` · settle1 `f25ce1b2…8e30d2ae` (**alive**, 495 left) · claim2
`b23c7b48…9657106b` · dispatch2 `57b92636…804cef19` · settle2+destroy
`afc8c488…9b41f110` (balance 0, Nonexist).

### Claim bounce / reset (failure paths)

```
bounced<JettonTransfer>{qid} from own JW:
   require(sender()==jetton_wallet)            ← v5.0.3 defense-in-depth
   if pending_claim && qid==pending_query_id:
     claimed UNTOUCHED (v5.1.0)                ← nothing was pre-booked
     clear pending_*, consumed_claim[qid]
     emit ClaimBounced (0x126)

ResetPendingClaim{qid} from beneficiary, after RESET_TIMEOUT:   ← v5.1.0 (sandbox-only)
   clear pending_*, consumed_claim[qid]
   claimed UNTOUCHED (I8)
   emit ClaimReset (0x127)
   late JettonExcesses{qid} afterwards → ignored (pending_claim==false)
```

---

## 11. Security & Verification Details

This section documents the automated verification pipeline results and provides technical
rationale for acknowledged findings. All artifacts are reproducible via GitHub Actions
workflows.

### 11.1 Static Analysis Summary

| Tool | Version | Detectors/Rules | Result | Artifact |
|---|---|---|---|---|
| Misti | v0.9.0+ | 42 built-in + Soufflé-based | ✅ No errors found | `docs/audit/misti-report.txt` |
| TON Dev Skills | v0.1.4 | 50+ heuristic rules | ⚠️ 0 critical/high on executable logic (FPs documented in 11.2) | `docs/audit/ton-dev-skills-audit.txt` |
| Jest Sandbox Tests | @ton/sandbox | N/A | ✅ **70 / 70 passing** (incl. 68–69 wallet-bounce, 70 ClaimSettled) | CI run |
| Mainnet E2E (full) | TON Mainnet | create→funded→claim→settle→destroy | ✅ **Verified** (tx `43da42f2…64319f00`) | tonviewer |
| Mainnet E2E (partial) | TON Mainnet | partial→alive→remainder→destroy | ✅ **Verified** (tx `f25ce1b2…8e30d2ae`, `afc8c488…9b41f110`) | tonviewer |
| Mainnet E2E (reset) | TON Mainnet | stuck-claim escape hatch | ⚠️ **Sandbox-only** (unreachable on COGNIQ by design, §8 W4) | tests 63–67 |

### 11.2 Acknowledged Findings Rationale

**TON-GAS-001 (Medium) — Cross-contract send without gas check.**
*Location:* `lockup_wallet.tact` file header comment.
*Finding:* Heuristic detects cross-contract sends lacking explicit
`require(context().value >= ...)` guards.
*Analysis:* **False Positive.** The reported line is a comment. Manual review of the three
genuine cross-contract sends confirms they are already constrained safely:

- `StartDiscovery → ProvideWalletAddress`: gated by `require(sender() == self.factory)`; the
  factory always attaches `DEPLOY_GAS = 0.12` TON, covering `WALLET_DISCOVERY_GAS = 0.05`.
  An additional value check would be redundant dead code.
- `Claim → ProvideWalletAddress`: funded from the wallet's own balance via
  `SendPayGasSeparately`. Logic does not depend on incoming `context().value`. Adding a
  guard would reject valid claims from users who attach minimal TON.
- `TakeWalletAddress` (flow 2) → `JettonTransfer`: response to a TEP-89 query. In mainnet
  traces the incoming value is ~0.0494 GRAM, below `CLAIM_GAS = 0.05`. Adding
  `require(context().value >= CLAIM_GAS)` here would demonstrably break the working mainnet
  claim path (confirmed live: tx `d026f92b…cf4f94a9` and `92473423…4ded6e96` dispatched with
  ~0.0494 GRAM incoming and exit 0).

*Conclusion:* Existing design is safe. Insufficient balance at send time reverts without
state change (action phase), and claim rollback is covered by `bounced<JettonTransfer>`. No
code change made.

**messages.tact exclusions.** In an early run the scan target was narrowed to exclude
`messages.tact`. This file contains only message declarations with no executable logic;
automated heuristics misfire on these structures (e.g. TON-AUTH-001 "privileged path").
Logical correctness of declarations is fully covered by Misti (0 findings across all files).

**Historical context (v5.0.1 → v5.0.2 → v5.0.3 → v5.1.x).** Initial v5.0.1 runs flagged 17
medium items (13× SuboptimalSend, 3× SuspiciousMessageMode, 1× SuboptimalCellOperation), all
resolved or formally documented by v5.0.2. v5.0.3 added the claim replay guard (Finding #4)
and bounce sender guard. v5.1.0 closed W4 and made accounting settlement-only. v5.1.1 added
`ClaimSettled` (0x128) for observability. The current report is clean with all 42 detectors
active.

### 11.3 Coverage Boundaries (honest ledger)

So that no claim in this spec overstates evidence, the verification surface is split
explicitly:

| Branch | Coverage | Evidence |
|---|---|---|
| Factory whitelist bijection (F3) | **mainnet** | tx `4bcce14f…d9e703c0` |
| Factory single-forward guard (F9, Finding #3) | **mainnet** | tx `1ff2b7c0…68a65764` |
| Factory overpay refund (F8) | **mainnet** | tx `c3af5454…08ec3413` |
| Factory excesses no-op | **mainnet** | tx `df11fd06…f76bf1d9` |
| Wallet funding (I3) | **mainnet** | tx `b65a4cfb…cb3ee109`, `0ad1b160…6ebb71e8` |
| Wallet settlement-only dispatch (I8, positive) | **mainnet** | tx `d026f92b…`, `92473423…`, `57b92636…` (`claimed`=0 at dispatch) |
| Wallet confirmed payout + destroy (I6, I9) | **mainnet** | tx `43da42f2…`, `afc8c488…` |
| Wallet partial non-destroy (I6, negative) | **mainnet** | tx `f25ce1b2…` (alive, 495 left) |
| Wallet claim replay guard (I7, Finding #4) | **sandbox** | tests 61–62 |
| Wallet reset escape hatch (W4) | **sandbox** | tests 63–67 (unreachable on COGNIQ by design) |
| Wallet bounce branch (sender guard + cleanup) | **sandbox** | tests 68–69 (full-TEP-74-body injection) |
| Wallet `ClaimSettled` emission (I9) | **sandbox + mainnet** | test 70 + tx `43da42f2…`, `afc8c488…` |
| **Factory `consumed_forward` bounce-cleanup** | **integration debt** | not covered by 68/69 (different injection); tracked, not claimed verified |

> The only row not covered anywhere is the **factory** forward-bounce cleanup. It is listed
> here rather than hidden, because a spec that omits its own gaps is worth less than one
> that names them. Everything else in this document is backed by either a green sandbox test
> or a live mainnet transaction cited above.

---

*End of specification.* Both contract halves are byte-verified against
`lockup_factory.tact` **v5.0.3** / `lockup_wallet.tact` **v5.1.1**. The full and partial
claim lifecycles are mainnet-verified on TON (29 Sep 2026); the reset path is a deliberate
sandbox-only guarantee (unreachable on the primary master by design). All previously known
runtime bugs (K1, #3, #4, W4) are fixed; the residual limitations (L1–L4, W1–W3, R1) and the
single integration debt (factory forward-bounce) are documented above rather than masked.
```
