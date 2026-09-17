# NEURON Vesting

> Token Lock & Vesting platform on TON — lock any TEP-74 jetton with public on-chain proof.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## What is it

A **non-custodial** smart contract system that lets any TON project or token holder **lock jettons** with a transparent, immutable schedule. Locked tokens **cannot be withdrawn** until the unlock date — that is the whole point.

**For projects:** lock team tokens, LP tokens, or advisor allocations and publish a verifiable on-chain proof for investors.

**For holders:** lock your tokens for personal discipline or to participate in platform incentives.

**Non-custodial by design:**
- Neither the factory, nor the creator, nor the platform can withdraw locked jettons.
- The beneficiary can claim only after `unlock_at`.
- The creator can only **extend** the unlock date forward, never shorten it.

---

## Architecture

Three Tact contracts:

| Contract | Purpose |
|----------|---------|
| **`LockupFactory`** | Singleton. Receives jetton transfers with `CreateLock` payload, deploys per-lock `LockupWallet` instances, forwards locked jettons, accumulates platform fees. |
| **`LockupWallet`** | One instance per lock. Holds the jettons, enforces the schedule, releases to the beneficiary on time. Immutable after deploy. |
| **`messages.tact`** | Shared TEP-74 message types (imported by both contracts). |

### Flow

```
┌─────────┐   JettonTransfer + CreateLock payload   ┌──────────────┐
│  User   │ ──────────────────────────────────────▶ │ LockupFactory│
└─────────┘                                          └──────┬───────┘
            ┌───────────────────┬────────────────────┐
            ▼                   ▼                    ▼
      ┌──────────┐      ┌────────────────    ┌───────────────┐
      │ Deploy   │      │ Forward jettons│    │ Refund overpay│
      │ Lockup   │─────▶│ to LockupWallet│    │ to creator    │
      │ Wallet   │      └────────────────┘    └───────────────┘
      └────┬─────┘
           │ (funded)
           ▼
      ┌──────────────┐
      │ LockupWallet │  ◀── Beneficiary claims after unlock_at
      │ (1 per lock) │  ◀── Creator extends (forward-only)
      └──────────────┘
~~~

---

## How it works

### 1. Create a lock

Any user sends a **jetton transfer** to the `LockupFactory` with:
- **Amount:** number of jettons to lock
- **Forward payload:** `CreateLock` structure (`jetton_master`, `beneficiary`, `unlock_at`)
- **Attached TON:** ≥ **1.25 TON** (1 TON platform fee + 0.25 TON gas buffer)

The factory:
1. Validates the sender is a whitelisted jetton wallet.
2. Charges **0.5% jetton fee** (goes to platform treasury).
3. Deploys a new `LockupWallet` for this lock.
4. Forwards the locked jettons to it.
5. Emits `LockCreated`.

### 2. Claim

After `unlock_at`, the **beneficiary** sends a `Claim` message to the `LockupWallet`:
- `amount = 0` → claim everything available
- `amount > 0` → partial claim

The wallet transfers jettons to the beneficiary. If the transfer bounces, accounting rolls back automatically.

### 3. Extend

While the lock is **still locked** (`now() < unlock_at`), the **creator** can send `Extend` to push the unlock date forward. Maximum horizon: **10 years** from the message timestamp. **Cannot** shorten.

### 4. Withdraw fees

The **treasury** can withdraw:
- **Jetton fees** — 0.5% accumulated per jetton master, via `WithdrawFees`.
- **TON fees** — 1 TON per lock, via `WithdrawTonFees`.

---

## Fee structure

| Fee | Amount | Paid by | Destination |
|-----|--------|---------|-------------|
| **Platform fee (TON)** | 1 TON per lock | Creator | Factory `ton_fees` → treasury |
| **Gas buffer** | 0.25 TON per lock | Creator | Consumed by gas |
| **Platform fee (jetton)** | 0.5% of locked amount | Deducted from lock | Factory `fees[master]` → treasury |

Overpay (attach > 1.25 TON) is refunded to the creator.

---

## Trust model

| Party | Can | Cannot |
|-------|-----|--------|
| **Beneficiary** | Claim after unlock. Reset stuck pending claim after 6h timeout. | Claim before unlock. Claim if not funded. |
| **Creator** | Extend unlock forward (while locked). | Withdraw jettons. Shorten unlock. Extend after unlock. |
| **Factory** | Deploy `LockupWallet`. Deposit jettons once. Forward overpay. | Withdraw jettons from `LockupWallet`. Reset pending claims. |
| **Treasury** | Whitelist jetton masters. Withdraw accumulated fees. | Steal locked jettons. Modify existing locks. |
| **Anyone** | Send TON (gas) to contracts. Send jettons (accepted but ignored). | Interfere with locks. |

**Treasury is trusted for:**
- Whitelisting jetton masters (registering `jetton_wallet` addresses).
- Withdrawing accumulated platform fees.

**Treasury compromise impact:** DoS on new lock creation (bad addresses registered). **No theft** of locked jettons. **Mitigation:** multi-sig treasury + off-chain verifier (see `scripts/`).

---

## Invariants

### `LockupFactory`

- **F1.** `next_id` strictly increases, never reused.
- **F2.** `own_wallets[m]` set ⇔ treasury approved master `m`.
- **F3.** `wallet_to_master[w] = m` ⇔ `own_wallets[m] = w` (bijection).
- **F4.** `fees[m]` = sum of all 0.5% cuts for master `m`, minus withdrawals.
- **F5.** `pending_withdraw[qid]` and `pending_jetton[qid]` set/cleared together.
- **F6.** `used_qids` monotonic: once true, never false.
- **F7.** `pending_create[qid]` set at create, cleared on success or bounce.
- **F8.** `create_jetton[qid]` tracks master for refund on create bounce.
- **F9.** `ton_fees >= 0` at all times.

### `LockupWallet`

- **I1.** `claimed ∈ [0, total_amount]`.
- **I2.** `available = total_amount - claimed ≥ 0`.
- **I3.** At most one claim in-flight (`pending_claim == true`).
- **I4.** `jetton_wallet` provided at deploy time by the factory.
- **I5.** Only beneficiary can claim / reset pending.
- **I6.** Creator can only push `unlock_at` forward, while still locked.
- **I7.** Bounce restores accounting ONLY if `query_id` matches in-flight claim.
- **I8.** `total_amount` is immutable — no top-ups change it.
- **I9.** Claim requires `funded == true`.

---

## Known Limitations

### `LockupWallet`

- **L1.** `ResetPendingClaim` does **NOT** roll back `claimed`. If a pending transfer failed silently (bounce lost) after reset, those jettons stay on the contract's jetton wallet, unaccounted and unrecoverable. Conservative trade-off: **stuck-but-safe > recoverable-but-exploitable**.
- **L2.** Non-factory jetton deposits are accepted but **ignored** (emitted as `UnexpectedDeposit`). They stay on our jetton wallet, unaccounted.
- **L3.** `total_amount` is fixed at deploy. No top-ups extend it. To add funds, create a new lock.

### `LockupFactory`

- **L1.** Lost fee-withdrawal bounce leaves `pending_withdraw[qid]` set forever. No funds lost; treasury simply uses a new `query_id`.
- **L2.** Overpay refund goes to `msg.sender` (original owner), not `sender()`.
- **L3.** If a create-transfer bounces, factory refunds to the creator and emits `LockCreationFailed`. The `LockupWallet` stays deployed but empty. Frontends should filter locks whose `lock_id` appears in a `LockCreationFailed` event.

---

## Security

### Reporting a vulnerability

If you discover a security issue, please **do not open a public issue**. Instead:

- **Email:** oblacka81@gmail.com
- **Telegram:** NEURON Support — [@animaneuri](https://t.me/animaneuri)
- **GitHub Security Advisories:** [Report privately](https://github.com/oblachka81-cloud/neuron-vesting/security/advisories/new)

We will acknowledge receipt within **48 hours** and aim to provide a fix within **7 days**.

### Audit status

- [x] Internal review: two independent code reviews, all critical findings fixed (v2.5.1 / v2.6.1).
- [x] **55 automated sandbox tests** covering happy paths, bounces, access control, time boundaries, and fee handling.
- [ ] **Not yet formally audited externally.** Initial mainnet deployment uses **platform-owned funds only** (self-test locks). A formal external audit is planned **before onboarding third-party projects**.

### Best practices for users

- **Verify the factory address** before sending jettons.
- **Verify the beneficiary address** in the `LockCreated` event.
- **Check `jetton_wallet`** matches your expected jetton master.
- **Do not send jettons directly** to a `LockupWallet` — they will be ignored.

---

## Development

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Install

```bash
npm install
```

### Compile

```bash
npm run check    # type-check only
npm run build    # full build to build/
```

### Test

```bash
npm test
```

### Project structure

~~~
contracts/
├── lockup_factory.tact   # Singleton factory
├── lockup_wallet.tact    # Per-lock wallet
└── messages.tact         # Shared TEP-74 message types
tests/
└── vesting.spec.ts       # 55 sandbox tests
scripts/
├── deployFactory.ts          # Deploy factory to testnet/mainnet
└── verify-jetton-wallets.ts  # Off-chain verifier
```

---

## Deployment

### Testnet

| Contract | Address |
|----------|---------|
| LockupFactory | `<TBD — legacy testnet factory exists; v2.5.1 redeploy pending>` |

### Mainnet

| Contract | Address |
|----------|---------|
| LockupFactory | `<TBD — filled after deploy>` |

### Deploy commands

```bash
# Testnet
npx tsx scripts/deployFactory.ts --network testnet

# Mainnet (platform-owned funds self-test first)
npx tsx scripts/deployFactory.ts --network mainnet
```

---

## Tech stack

- Contracts: Tact 1.5.4 on TON
- Build: tact CLI
- Test: Jest + @ton/sandbox
- CI: GitHub Actions — compile + 55 tests on every push
- Indexer: Express + PostgreSQL
- Frontend: Vite + TonConnect (mini app + public web pages)

---

## Roadmap

- [x] v2.5.1 / v2.6.1 — audit fixes, 55 tests, green CI
- [x] Documentation: README, SECURITY.md, docs/SPEC.md
- [ ] Off-chain jetton-wallet verifier in CI
- [ ] Mainnet deployment (platform-owned funds self-test)
- [ ] Multi-sig treasury
- [ ] Formal external audit
- [ ] Onboarding third-party projects
- [ ] v3: rescue mechanism for stuck jettons (time-locked, factory-only)

---

## License

MIT © NEURON Vesting

---

## Links

- Repository: https://github.com/oblachka81-cloud/neuron-vesting
- Contract spec: [docs/SPEC.md](./docs/SPEC.md)
- Security policy: [SECURITY.md](./SECURITY.md)
