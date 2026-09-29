# 🛡️ NEURON Vesting

> Vesting module of the **NEURON** blockchain ecosystem.
> Lock any TEP-74 jetton on TON with public on-chain proof. Non-custodial. Immutable schedule. Zero custody.

[Mini app (live)](https://oblachka81-cloud.github.io/neuron-vesting) · [Telegram bot](https://t.me/NeuronEcosystemBot) · [Whitepaper v4.0](https://neuron.bothost.tech/whitepaper.html) · [Spec](docs/SPEC.md) · [Security](SECURITY.md)

![Mainnet TON](https://img.shields.io/badge/network-TON%20Mainnet-0098EA)
![Tact 1.6.13](https://img.shields.io/badge/language-Tact%201.6.13-8a2be2)
![Tests 70/70](https://img.shields.io/badge/tests-70%2F70%20passing-brightgreen)
![Misti clean](https://img.shields.io/badge/Misti-no%20errors%20(42%20detectors)-brightgreen)
![TON Dev Skills](https://img.shields.io/badge/TON%20Dev%20Skills-0%20critical%2Fhigh-yellow)
![License MIT](https://img.shields.io/badge/license-MIT-blue)

---

## 🌐 Part of the NEURON ecosystem

**NEURON** is a blockchain ecosystem inside Telegram with its native utility token **COGNIQ** on TON. It includes a quiz, the IMPULSE game center, NEURON Bank (staking + transfers), NEURON Exchange (crypto + xStocks), a fiat on-ramp and more — all in a single Telegram mini app.

**NEURON Vesting** is the on-chain lockup module of that ecosystem. It lets any project or holder lock TEP-74 tokens with a transparent, immutable unlock schedule and publish a verifiable on-chain proof. Locked tokens cannot be withdrawn before `unlock_at`. That is the whole point.

---

## ✨ Why NEURON Vesting

- **Non-custodial** — neither the factory, the creator, nor the platform can pull locked jettons out of a funded wallet.
- **Immutable schedule** — the beneficiary can claim only after `unlock_at`. The unlock date is fixed at creation and cannot be changed on-chain.
- **Settlement-only accounting** — a payout is booked only when the transfer is confirmed on-chain (`ClaimSettled`). A dispatch alone never counts as paid, so balances stay honest under any failure mode.
- **On-chain escape hatch** — a stuck pending claim is no longer irreversible: the beneficiary can reset it after a timeout, with no effect on accounted balances.
- **On-chain proof** — every lock is verifiable via the factory `LockCreated` event and the public Vaults dashboard.
- **TEP-89 discovery** — both factory and wallet resolve jetton-wallet addresses through the jetton master (`provide_wallet_address`) — no assumption about any TEP-74 wallet's internal layout.
- **Configurable fees** — platform fees (jetton bps + fixed TON) are live contract parameters, retunable by the treasury via `SetFeeBps` / `SetFeeTon` — no redeploy.
- **Multisig treasury** — on-chain whitelisting, fee withdrawal and emergency rescue run through a **2-of-3** multisig.
- **Self-destruct on completion** — after the final confirmed claim the wallet sweeps all remaining TON to the beneficiary and self-destructs, reclaiming the storage deposit with no residue.

---

## 🚀 Live on mainnet

| Contract | Address |
|---|---|
| **LockupFactory** | [`EQD_dSnLqcBiQyT2LRyNPIUpqAY9Qr9VoMgUCKtHN5xpSCTN`](https://tonviewer.com/EQD_dSnLqcBiQyT2LRyNPIUpqAY9Qr9VoMgUCKtHN5xpSCTN) |
| **Treasury** (2-of-3 multisig) | [`EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl`](https://tonviewer.com/EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl) |
| **COGNIQ jetton master** | [`EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg`](https://tonviewer.com/EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg) |

| Resource | URL |
|---|---|
| Mini app (lock / claim / vaults) | `oblachka81-cloud.github.io/neuron-vesting` |
| Admin panel | `oblachka81-cloud.github.io/neuron-vesting/admin.html` |
| REST API | `neuronvesting.bothost.tech` |
| Telegram bot | `@NeuronEcosystemBot` |
| Whitepaper | `neuron.bothost.tech/whitepaper.html` |

*Currently whitelisted: COGNIQ.*

---

## 🏗️ Architecture

| Contract | Purpose |
|---|---|
| **LockupFactory** | Singleton. Receives jetton transfers carrying a `CreateLock` payload, deploys a `LockupWallet` per lock, forwards locked jettons via TEP-89 discovery, accumulates platform fees. |
| **LockupWallet** | One instance per lock. Holds jettons, enforces the schedule, releases to the beneficiary on claim, self-destructs on the final confirmed claim. |
| **messages.tact** | Shared TEP-74 / TEP-89 message types (imported by both contracts). |

### Flow

```
┌──────────   JettonTransfer + CreateLock payload   ┌───────────────┐
│   User   │ ──────────────────────────────────────▶ │ LockupFactory │
└──────────┘                                          └───────┬───────┘
                                                              │
              ┌───────────────┬─────────────────┬─────────────┘
              ▼               ▼                 ▼
        ┌──────────┐    ┌──────────────┐   ┌──────────────┐
        │  Deploy  │    │  TEP-89      │   │   Refund     │
        │  Lockup  │───▶│  discovery   │   │   overpay    │
        │  Wallet  │    │  + forward   │   │   to creator │
        └────┬─────┘    └──────────────┘   └──────────────┘
             │  (funded via JettonNotification)
             ▼
        ┌──────────────┐
        │ LockupWallet │  ◀── Beneficiary claims after unlock_at
        │ (1 per lock) │  ◀── Self-destructs on final confirmed claim
        └──────────────┘
```

---

## ⚙️ How it works

### 1. Create a lock

Any user sends a **jetton transfer** to `LockupFactory`:

- **Amount:** the jetton quantity to lock.
- **Forward payload:** a `CreateLock` struct (`jetton_master`, `beneficiary`, `unlock_at`).
- **Attached TON:** ≥ `fee_ton + GAS_BUFFER_TON` (currently **1 + 0.1 = 1.1 TON**). Overpay is refunded instantly.

The factory verifies the sender is a whitelisted jetton wallet, charges the configurable jetton fee, deploys a fresh `LockupWallet`, resolves the child wallet via TEP-89, forwards the locked jettons to it exactly once, and emits `LockCreated`.

### 2. Claim

After `unlock_at` the beneficiary sends `Claim` to the `LockupWallet`:

- `amount = 0` → claim all available.
- `amount > 0` → **partial** claim (the wallet stays alive until fully claimed).

The wallet resolves the beneficiary's jetton wallet via TEP-89 and dispatches the jettons. The payout is booked only on on-chain confirmation (`ClaimSettled`); a dispatch alone never counts as paid. A failed transfer rolls back cleanly without touching accounted balances, and a stuck claim can be reset by the beneficiary after a timeout. On the final confirmed claim the wallet sweeps all remaining TON to the beneficiary and self-destructs.

### 3. Withdraw fees

The treasury withdraws accrued jetton fees (`WithdrawFees`) and platform TON (`WithdrawTonFees`). Emergency rescue of stray factory funds is available via `RescueTon` / `RescueJetton`, never touching funds reserved for pending payouts.

### 4. Retune fees

Platform fees are live contract parameters: `SetFeeBps` (jetton fee, cap 10%) and `SetFeeTon` (fixed TON fee per lock). No redeploy required.

---

## 💰 Fee structure

Fees are configuration parameters adjustable by the treasury, not hard-coded bytecode.

| Fee | Value | Paid by | Destination |
|---|---|---|---|
| Platform fee (TON) | **1 TON** per lock (`fee_ton`) | Creator | Factory `ton_fees` → treasury |
| Gas buffer | 0.1 TON per lock (`GAS_BUFFER_TON`) | Creator | Consumed by gas / refunded on overpay |
| Platform fee (jetton) | 0.5% of locked amount (`fee_bps`, cap 10%) | Deducted from lock | Factory `fees[master]` → treasury |

Overpay (attach above `fee_ton + GAS_BUFFER_TON`) is refunded to the creator immediately. On a failed deployment the bounce refund returns both the platform fee and the gas buffer.

---

## 🛡️ Trust model

| Party | Can | Cannot |
|---|---|---|
| **Beneficiary** | Claim after `unlock_at` (full or partial). Reset a stuck pending claim after the timeout. | Claim before unlock. Claim if unfunded. Inflate accounted balances via reset. |
| **Creator** | Receive the overpay refund and, on a failed deployment, the platform-fee + gas-buffer refund. | Touch an existing funded lock. Withdraw jettons. Change the unlock date. |
| **Factory** | Deploy `LockupWallet`. Deposit jettons once via TEP-89. Refund overpay / failed-create funds. | Withdraw jettons from a funded `LockupWallet`. |
| **Treasury** | Whitelist jetton masters. Withdraw accumulated fees. Emergency-rescue stray factory funds. Retune fees on the live contract. | Steal locked jettons. Modify existing locks. |
| **Anyone** | Send TON (gas) to contracts. | Interfere with locks. |

**Treasury compromise impact:** DoS on new lock creation (bad addresses registered). No theft of locked jettons. **Mitigation:** 2-of-3 multisig treasury + off-chain verifier.

---

## ✅ Verification

| Layer | Tool | Result |
|---|---|---|
| Unit tests | Jest + `@ton/sandbox` | **70 / 70 passing** |
| Static analysis (Tact) | Misti `--all-detectors` + Soufflé | No errors found (42 detectors) |
| Static analysis (rules) | TON Dev Skills — 50+ rules | 0 critical / high on executable logic |
| Mainnet — full lifecycle | TON mainnet | create → funded → claim → settle → destroy · `43da42f2…64319f00` |
| Mainnet — partial lifecycle | TON mainnet | partial → alive → remainder → destroy · `f25ce1b2…8e30d2ae`, `afc8c488…9b41f110` |
| Mainnet — single-forward guard | TON mainnet | exactly one forward per lock · `1ff2b7c0…68a65764` |

Full invariant matrix, opcode tables and per-branch coverage ledger: [`docs/SPEC.md`](docs/SPEC.md). Audit reports: [`docs/audit/`](docs/audit/).

---

## 🚀 Quick start

### Prerequisites

- Node.js ≥ 20.0.0
- npm ≥ 10.0.0

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
npm test         # 70 sandbox tests via Jest + @ton/sandbox
```

### Add a jetton to the on-chain whitelist

```bash
FACTORY_ADDRESS=EQD_dSnLqcBiQyT2LRyNPIUpqAY9Qr9VoMgUCKtHN5xpSCTN \
npx tsx scripts/add-jetton.ts <JETTON_MASTER_ADDRESS>
```

Prints a ready-to-sign `SetJettonWallet` body for multisig.ton.org. Sign with 2 of 3 treasury keys. The script is also wired as a manual GitHub Action (`check-jetton.yml`) so the body can be generated in CI without a local toolchain.

---

## 📂 Project structure

```
contracts/
├── lockup_factory.tact       # LockupFactory v5.0.3
├── lockup_wallet.tact        # LockupWallet v5.1.1
└── messages.tact             # Shared TEP-74 / TEP-89 messages

tests/
└── vesting.spec.ts           # 70 sandbox tests

scripts/
├── deploy-mainnet.ts         # Deploy LockupFactory to mainnet
├── add-jetton.ts             # Generate SetJettonWallet body for multisig
└── gen-rescue.ts             # Generate treasury withdraw / rescue orders

bot/
├── index.cjs                 # Entry: HTTP + Telegram bot + indexer
├── indexer.js                # Polls factory + wallet events → PostgreSQL
├── api.js                    # REST API (locks, whitelist, admin, prices, jetton meta)
├── auth.js                   # Admin session management
└── db.js                     # PostgreSQL schema + queries

web/
├── index.html                # Main mini app
├── admin.html                # Admin panel
├── main.ts                   # Entry: TonConnect + tabs
├── wizard.ts                 # Create lock UI
├── cabinet.ts                # My Locks / Applications / Whitelist / Vaults
├── admin.ts                  # Admin panel logic
├── ton.ts                    # Claim body builder + jetton wallet resolver
├── price.ts                  # Live prices for whitelist cards
└── config.ts                 # API URL, factory address, network

docs/
├── SPEC.md                   # Full contract specification
└── audit/
    ├── misti-report.txt
    └── ton-dev-skills-audit.txt

.github/workflows/
├── compile-tact.yml          # Build & test on every push
├── misti.yml                 # Misti static analysis on every push
├── ton-dev-audit.yml         # TON Dev Skills audit on every push
├── deploy-mainnet.yml        # Manual factory deployment
├── deploy-pages.yml          # Publish mini app to GitHub Pages
└── check-jetton.yml          # Manual on-chain whitelist body generation
```

---

## 🔌 REST API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Service status + factory address |
| `/api/locks?wallet=` | GET | Locks where the wallet is creator or beneficiary (includes `decimals`) |
| `/api/locks/public` | GET | Public vaults summary + COGNIQ price (STON.fi, 5m cache) |
| `/api/locks/by-jetton?master=` | GET | Locks for a specific jetton master |
| `/api/whitelist` | GET | Approved jettons |
| `/api/jetton/:master/icon` | GET | Jetton icon (via TonAPI) |
| `/api/jetton/:master/meta` | GET | Jetton symbol / name / decimals (via TonAPI) |
| `/api/applications` | POST | Submit a whitelist application (address + length validated) |
| `/api/applications/status/:id` | GET | Application status |
| `/api/admin/*` | various | Admin operations (login, approve, reject, fee-withdraw bodies) |

---

## 📜 Contract versions

**Current:** LockupFactory **v5.0.3** + LockupWallet **v5.1.1**.

- **v5.1.1 (wallet):** added `ClaimSettled` (0x128) — confirmed payouts are now an explicit on-chain event, distinct from the dispatch event `Claimed` (0x125). Indexers and UIs read 0x128 as "paid".
- **v5.1.0 (wallet):** settlement-only accounting (`claimed` moves only on confirmation) + on-chain `ResetPendingClaim` escape hatch for stuck claims.
- **v5.0.3 (factory + wallet):** replay guards — one forward per lock on the factory (`consumed_forward`), one dispatch per claim cycle on the wallet (`consumed_claim`); bounce sender checks.
- **v5.0.1 (wallet):** `JettonExcesses` accepts the success callback from either real wallet of the TEP-74 chain; `beneficiary_wallet` cached during claim.
- **v5.0.0 (factory + wallet):** TEP-89 jetton-wallet discovery, configurable fees, treasury rescue, self-destruct on final claim.

Full specification, invariants, opcode tables and verification status per contract: [`docs/SPEC.md`](docs/SPEC.md).

---

## 🗺️ Roadmap

**Shipped (mainnet-verified)**
- LockupFactory v5.0.3 + LockupWallet v5.1.1 on TON mainnet
- COGNIQ whitelisted on-chain via 2-of-3 treasury multisig
- TEP-89 jetton-wallet discovery (factory + wallet)
- Configurable platform fees (jetton bps + TON) with treasury retune — no redeploy
- Treasury emergency rescue (TON + jetton) on the factory
- Full and partial claim lifecycle, settlement-only accounting, self-destruct on completion
- On-chain reset for stuck claims
- Public Vaults dashboard · indexer · REST API · Telegram bot
- 70 sandbox tests · Misti clean · TON Dev Skills 0 critical/high
- CI: build + test + static analysis on every push, auto Pages deploy

**Next**
- Multi-jetton onboarding UX (streamlined new-master registration without manual multisig)
- Universal per-jetton pricing on the public Vaults board
- Off-chain jetton-wallet authenticity check for `own_wallets[master]`

**Future (v6+)**
- Batch lock creation
- Multi-beneficiary vesting schedules
- Standalone on-chain proof explorer

---

## 🛠️ Tech stack

- **Contracts:** Tact 1.6.13 on TON
- **Build:** `tact` CLI
- **Tests:** Jest + `@ton/sandbox`
- **CI:** GitHub Actions
- **Backend:** Node.js ≥ 20 · Express · PostgreSQL
- **Frontend:** Vite · TypeScript · TonConnect UI
- **Hosting:** GitHub Pages (frontend) · Bothost (backend)

---

## 🔒 Security

Security policy, scope and reporting instructions: [`SECURITY.md`](SECURITY.md).

Verification status:
- ✅ **Automated tests:** 70 sandbox tests covering happy paths, rejections, access control, timing, payment handling and the full over-limit matrix.
- ✅ **Static analysis (Misti):** `--all-detectors` with Soufflé — no findings across 42 detectors. Report: [`docs/audit/misti-report.txt`](docs/audit/misti-report.txt).
- ✅ **Static analysis (TON Dev Skills):** 50+ rules — 0 critical/high on executable logic. Report: [`docs/audit/ton-dev-skills-audit.txt`](docs/audit/ton-dev-skills-audit.txt).
- ✅ **Mainnet-verified:** full and partial claim lifecycles, single-forward guard and self-destruct proven on TON mainnet (29 Sep 2026) — transactions cited in [Verification](#-verification).

---

## 📚 Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — full contract specification, invariants, message opcodes, per-branch verification status.
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting, scope, current audit status.
- [NEURON Whitepaper](https://neuron.bothost.tech/whitepaper.html) — ecosystem documentation.

---

## 📄 License

MIT © NEURON Blockchain Ecosystem — see [LICENSE](LICENSE).
