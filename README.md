# 🛡️ NEURON Vesting

**On-chain vesting module of the [NEURON Blockchain Ecosystem](https://neuron.bothost.tech/whitepaper.html).**  
Lock any TEP-74 jetton on TON with public on-chain proof. Non-custodial. Immutable schedule. Zero custody.

[Live App](https://oblachka81-cloud.github.io/neuron-vesting/) · [Telegram Bot](https://t.me/NeuronEcosystemBot) · [Whitepaper v4.0](https://neuron.bothost.tech/whitepaper.html) · [Specification](docs/SPEC.md) · [Security](SECURITY.md)

[![TON Mainnet](https://img.shields.io/badge/network-TON%20Mainnet-0098EA?logo=ton&logoColor=white)](https://tonviewer.com/EQC1Y_OfkDqKiBh0nBzuKvbvSqIipcbswf_x7nuglJ9LZdBp)
[![Tact 1.6.13](https://img.shields.io/badge/tact-1.6.13-blue)](https://tact-lang.org/)
[![Tests](https://img.shields.io/github/actions/workflow/status/oblachka81-cloud/neuron-vesting/compile-tact.yml?branch=main&label=tests)](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/compile-tact.yml)
[![Misti](https://img.shields.io/github/actions/workflow/status/oblachka81-cloud/neuron-vesting/misti.yml?branch=main&label=misti)](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/misti.yml)
[![TON Dev Skills](https://img.shields.io/github/actions/workflow/status/oblachka81-cloud/neuron-vesting/ton-dev-audit.yml?branch=main&label=ton%20dev%20skills)](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/ton-dev-audit.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌐 Part of NEURON Ecosystem

NEURON is a blockchain ecosystem in Telegram with its internal utility token **COGNIQ** on the TON network. It includes a quiz game, the IMPULSE gaming hub, NEURON Bank (staking and transfers), NEURON Exchange (crypto + xStocks), Fiat On-Ramp, and more — all inside a single Telegram mini app.

**NEURON Vesting** is the dedicated on-chain lock module of this ecosystem. It lets any project or holder lock TEP-74 jettons with a transparent, immutable unlock schedule and publish a verifiable on-chain proof. Locked tokens cannot be withdrawn until the `unlock_at` timestamp. That is the whole point.

---

## ✨ Why NEURON Vesting

- **Non-custodial:** Neither the factory, nor the creator, nor the platform can withdraw locked jettons.
- **Immutable schedule:** The beneficiary can claim only after `unlock_at`. The unlock date is fixed at creation and cannot be changed on-chain in v5.0.1.
- **On-chain proof:** Every lock is verifiable via the factory's `LockCreated` event and the public Vaults dashboard.
- **TEP-89 discovery:** Both the factory and the wallet resolve jetton-wallet addresses through the jetton master (`provide_wallet_address`) — no assumptions about any specific TEP-74 wallet implementation or its internal `c4` layout.
- **Configurable fees:** Platform fees (jetton bps and fixed TON) are live contract parameters, adjustable by the treasury via `SetFeeBps` / `SetFeeTon` — no redeploy needed.
- **Treasury multisig:** On-chain whitelisting, fee withdrawals, and emergency rescue are signed via a 2-of-3 multisig.
- **Self-destruct on completion:** After the final claim, the wallet sweeps all remaining TON to the beneficiary and destroys itself, reclaiming the storage deposit with zero dust left. **Mainnet-verified.**

---

## 🚀 Live on Mainnet

| Contract | Address |
| :--- | :--- |
| **LockupFactory** | [`EQC1Y_OfkDqKiBh0nBzuKvbvSqIipcbswf_x7nuglJ9LZdBp`](https://tonviewer.com/EQC1Y_OfkDqKiBh0nBzuKvbvSqIipcbswf_x7nuglJ9LZdBp) |
| **Treasury (2-of-3 multisig)** | [`EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl`](https://tonviewer.com/EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl) |
| **COGNIQ jetton master** | [`EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg`](https://tonviewer.com/EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg) |

| Resource | URL |
| :--- | :--- |
| **Mini App** (lock / claim / vaults) | [oblachka81-cloud.github.io/neuron-vesting](https://oblachka81-cloud.github.io/neuron-vesting/) |
| **Admin Panel** | [oblachka81-cloud.github.io/neuron-vesting/admin.html](https://oblachka81-cloud.github.io/neuron-vesting/admin.html) |
| **REST API** | [neuronvesting.bothost.tech](https://neuronvesting.bothost.tech) |
| **Telegram Bot** | [@NeuronEcosystemBot](https://t.me/NeuronEcosystemBot) |
| **Whitepaper** | [neuron.bothost.tech/whitepaper.html](https://neuron.bothost.tech/whitepaper.html) |

*Currently whitelisted: COGNIQ.*

---

## 🏗️ Architecture

Three core Tact contracts:

| Contract | Purpose |
| :--- | :--- |
| `LockupFactory` | Singleton. Receives jetton transfers with a `CreateLock` payload, deploys per-lock `LockupWallet` instances, forwards locked jettons via TEP-89 discovery, and accumulates platform fees. |
| `LockupWallet` | One instance per lock. Holds the jettons, enforces the schedule, releases to the beneficiary on claim, and self-destructs on final claim. |
| `messages.tact` | Shared TEP-74 / TEP-89 message types (imported by both contracts). |

### Flow

```text
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
        │ (1 per lock) │  ◀── Self-destructs on final claim
        └──────────────┘
```

---

## ⚙️ How it works

### 1. Create a lock
Any user sends a jetton transfer to the `LockupFactory` with:
- **Amount:** Number of jettons to lock.
- **Forward payload:** `CreateLock` structure (`jetton_master`, `beneficiary`, `unlock_at`).
- **Attached TON:** ≥ `fee_ton` + `GAS_BUFFER_TON` (currently 1 TON + 0.1 TON = 1.1 TON). *Overpay is refunded instantly.*

The factory:
1. Validates the sender is a whitelisted jetton wallet (reverse map `wallet_to_master`).
2. Charges the configurable jetton fee (default 0.5%, cap 10%).
3. Deploys a new `LockupWallet` for this lock and kicks off TEP-89 discovery (`StartDiscovery`).
4. Asks the jetton master for the child wallet's jetton address (`TakeWalletAddress`), then forwards the locked jettons to it.
5. Emits `LockCreated`.

### 2. Claim
After `unlock_at`, the beneficiary sends a `Claim` message to the `LockupWallet`:
- `amount = 0` → claim everything available.
- `amount > 0` → partial claim.

The wallet asks the master (TEP-89) for the beneficiary's jetton wallet, then sends the jettons. Settlement is confirmed by the `JettonExcesses` callback from either real wallet of the TEP-74 transfer chain (own wallet or beneficiary's wallet), or by a bounce that rolls back `claimed`. On the final claim the wallet sweeps all remaining TON to the beneficiary and self-destructs (`mode: 128 + 32 + 2`).

**Mainnet proof:** claim tx [`de15fd59…a94b4fcb`](https://tonviewer.com/transaction/de15fd59a94b4fcb) (28 Sep 2026) — excess accepted (exit 0), full 0.152551844 GRAM sweep, wallet balance 0, status `Nonexist`.

### 3. Withdraw fees
The treasury can withdraw:
- **Jetton fees:** accumulated per jetton master (`WithdrawFees`, `0x20`).
- **TON fees:** accumulated platform TON (`WithdrawTonFees`, `0x22`).

Emergency rescue of stray TON / jettons held by the factory is available to the treasury via `RescueTon` (`0x23`) / `RescueJetton` (`0x24`). These never touch funds reserved for pending fee payouts.

### 4. Retune fees
Platform fees are live contract parameters, adjustable by the treasury:
- `SetFeeBps` (`0x25`) — jetton fee in basis points (cap 10%).
- `SetFeeTon` (`0x26`) — fixed TON fee per lock.

No redeploy is required to change fees.

---

## 💰 Fee structure

Fees are configuration parameters adjustable by the treasury, not hard-coded bytecode. Values below are current mainnet defaults.

| Fee | Current value | Paid by | Destination |
| :--- | :--- | :--- | :--- |
| **Platform fee (TON)** | 1 TON per lock (`fee_ton`) | Creator | Factory `ton_fees` → treasury |
| **Gas buffer** | 0.1 TON per lock (`GAS_BUFFER_TON`) | Creator | Consumed by gas / refunded on overpay |
| **Platform fee (jetton)** | 0.5% of locked amount (`fee_bps`, cap 10%) | Deducted from lock | Factory `fees[master]` → treasury |

*Overpay (attach > `fee_ton` + 0.1 TON) is refunded to the creator immediately. On a failed deployment the bounce refund returns both the platform fee and the gas buffer to the creator.*

---

## 🛡️ Trust model

| Party | Can | Cannot |
| :--- | :--- | :--- |
| **Beneficiary** | Claim after `unlock_at` (full or partial). | Claim before unlock. Claim if the lock is unfunded. |
| **Creator** | Receive the overpay refund and, on a failed deployment, the platform-fee + gas-buffer refund. | Touch an existing funded lock. Withdraw jettons. Change the unlock date (no on-chain extension in v5.0.1). |
| **Factory** | Deploy `LockupWallet`. Deposit jettons once via TEP-89. Refund overpay / failed-create funds. | Withdraw jettons from a funded `LockupWallet`. |
| **Treasury** | Whitelist jetton masters. Withdraw accumulated fees. Emergency-rescue stray factory funds. Retune fees on the live contract. | Steal locked jettons. Modify existing locks. |
| **Anyone** | Send TON (gas) to contracts. | Interfere with locks. |

**Treasury is trusted for:** whitelisting jetton masters, withdrawing accumulated platform fees, and retuning fees.  
**Treasury compromise impact:** DoS on new lock creation (bad addresses registered). No theft of locked jettons.  
**Mitigation:** 2-of-3 multisig treasury + off-chain verifier.

---

## ✅ Verification

Every claim below is backed by a public, re-runnable artifact. Click any badge or link to reproduce.

| Layer | Tool | Result | Artifact |
| :--- | :--- | :--- | :--- |
| Unit tests | Jest + `@ton/sandbox` | 55 / 55 passing | [tests/vesting.spec.ts](tests/vesting.spec.ts) · [CI run](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/compile-tact.yml) |
| Static analysis (Tact) | Misti `--all-detectors` + Soufflé | No errors found (42 detectors) | [CI run](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/misti.yml) · [report](docs/audit/misti-report.txt) |
| Static analysis (rules) | TON Dev Skills — 50+ rules | 0 findings on factory · 1 MEDIUM on wallet (false positive, see below) | [CI run](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/ton-dev-audit.yml) · [report](docs/audit/ton-dev-skills-audit.txt) |
| Mainnet end-to-end | TON mainnet | Self-destruct + sweep verified | [tx de15fd59…a94b4fcb](https://tonviewer.com/transaction/de15fd59a94b4fcb) |

### TON Dev Skills — acknowledged finding

**TON-GAS-001** (Cross-contract send path without visible gas/value checks, MEDIUM) — acknowledged as a false positive, no code change.

- The finding locates to `lockup_wallet.tact:10`, which is a file-header comment, not a send.
- The three genuine cross-contract sends are already constrained:
  - `StartDiscovery` → `ProvideWalletAddress` is gated by `require(sender() == self.factory)`, and the factory always ships `DEPLOY_GAS = 0.12` TON.
  - `Claim`'s discovery is funded from the wallet balance (`SendPayGasSeparately`).
  - `TakeWalletAddress` flow 2 → `JettonTransfer` is a TEP-89 master response whose value (0.049428798 GRAM in mainnet trace `9523c81f`) is **below** `CLAIM_GAS = 0.05`, so an explicit `require(context().value >= CLAIM_GAS)` would break a working mainnet claim path.
- Insufficient balance is already handled: the send reverts without state change, and any claim rollback is covered by the `bounced<JettonTransfer>` handler.

Full technical rationale: [docs/audit/ton-dev-skills-audit.txt](docs/audit/ton-dev-skills-audit.txt).

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
npm test         # 55 sandbox tests via Jest + @ton/sandbox
```

### Add a jetton to the on-chain whitelist
```bash
FACTORY_ADDRESS=EQC1Y_OfkDqKiBh0nBzuKvbvSqIipcbswf_x7nuglJ9LZdBp \
npx tsx scripts/add-jetton.ts <JETTON_MASTER_ADDRESS>
```
*Prints a ready-to-sign `SetJettonWallet` body for multisig.ton.org. Sign with 2 of 3 treasury keys. The script is also wired as a manual GitHub Action (`check-jetton.yml`) so the body can be generated in CI without a local toolchain.*

---

## 📂 Project structure

```text
contracts/
├── lockup_factory.tact       # LockupFactory v5.0.0
├── lockup_wallet.tact        # LockupWallet v5.0.1
└── messages.tact             # Shared TEP-74 / TEP-89 messages

tests/
└── vesting.spec.ts           # 55 sandbox tests

scripts/
├── deploy-mainnet.ts         # Deploy LockupFactory to mainnet
├── add-jetton.ts             # Generate SetJettonWallet body for multisig
└── gen-rescue.ts             # Generate treasury withdraw / rescue orders

bot/
├── index.cjs                 # Entry: HTTP + Telegram bot + indexer
├── indexer.js                # Polls factory + wallet events → PostgreSQL
├── api.js                    # REST API (locks, whitelist, admin, prices)
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
├── price.ts                  # Live prices for whitelist cards (GeckoTerminal → STON.fi fallback)
└── config.ts                 # API URL, factory address, network

docs/
├── SPEC.md                   # Full contract specification
└── audit/
    ├── misti-report.txt      # Misti static analysis report
    └── ton-dev-skills-audit.txt  # TON Dev Skills audit report

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
| :--- | :--- | :--- |
| `/health` | GET | Service status + factory address |
| `/api/locks?wallet=` | GET | Locks where the wallet is creator or beneficiary |
| `/api/locks/public` | GET | Public vaults summary + COGNIQ price (STON.fi, 5m cache) |
| `/api/locks/by-jetton?master=` | GET | Locks for a specific jetton master |
| `/api/whitelist` | GET | Approved jettons |
| `/api/jetton/:master/icon` | GET | Jetton icon (via TonAPI) |
| `/api/applications` | POST | Submit a whitelist application (address + length validated) |
| `/api/applications/status/:id` | GET | Application status |
| `/api/admin/*` | various | Admin operations (login, approve, reject, withdraw bodies) |

*Note: Frontend Whitelist cards fetch live prices dynamically via GeckoTerminal API with a STON.fi fallback (`web/price.ts`), independent of the Vaults summary endpoint, which currently prices COGNIQ only.*

---

## 📜 Contract versions

**Current:** `LockupFactory v5.0.0` + `LockupWallet v5.0.1`.

### Changelog v5.0.1 (wallet)
- 🔥 **Fix (mainnet, exit 36235):** `JettonExcesses` now accepts the success callback from either real wallet of the TEP-74 transfer chain — the sending-side (own jetton wallet) or the receiving-side (beneficiary's jetton wallet). Per TEP-74, `response_destination` is copied into `internal_transfer`, so the receiving-side wallet also returns excesses; COGNIQ's sending-side wallet returns none. The v5.0.0 `sender() == jetton_wallet` guard reverted the only excess that ever arrived, leaving `pending_claim` stuck and ~0.25 TON of dust per completed lock.
- **Added:** `beneficiary_wallet` state field, cached from the TEP-89 `TakeWalletAddress` response during claim flow 2, used as the second valid sender in the excesses check.
- **Mainnet-verified:** tx [`de15fd59…a94b4fcb`](https://tonviewer.com/transaction/de15fd59a94b4fcb) (28 Sep 2026) — excess from `EQDhjRqP…` accepted (exit 0), full 0.152551844 GRAM sweep, wallet balance 0, status `Nonexist`.

### Changelog v5.0.0 (factory + initial wallet)
- **LockupWallet:** Jetton-wallet resolution via TEP-89 `provide_wallet_address` (no `StateInit`/`c4` assumptions); funding reconciled through `fund_sender` when a notification arrives before discovery completes.
- **LockupFactory:** `DEPLOY_GAS` reduced 0.15 → 0.12 TON (internal child-deploy gas); bounce refund now returns both platform fee and gas buffer to the creator; `JettonExcesses` accepted silently (no-op); added treasury rescue messages (`RescueTon` `0x23`, `RescueJetton` `0x24`) and fee-config messages (`SetFeeBps` `0x25`, `SetFeeTon` `0x26`).
- **TEP-89 discovery:** Both contracts resolve jetton wallets via the master, no `StateInit` assumptions.

See [docs/SPEC.md](docs/SPEC.md) for the full specification, invariants, message opcodes, and per-contract verification status.

---

## 🗺️ Roadmap

### ✅ Shipped (mainnet-verified)
- LockupFactory v5.0.0 + LockupWallet v5.0.1 on TON mainnet
- COGNIQ on-chain whitelisted via treasury multisig
- TEP-89 jetton-wallet discovery (factory + wallet)
- Configurable platform fees (jetton bps + TON) with treasury setters — no redeploy needed to retune
- Treasury emergency rescue (TON + jetton) at the factory
- Partial claim (`Claim` accepts `amount > 0`)
- 🔥 Self-destruct on final claim (full TON sweep + storage deposit reclaim, wallet balance 0) — mainnet-verified in v5.0.1
- `add-jetton.ts` CLI + admin multisig body generator + CI workflow
- Public Vaults dashboard
- Indexer + REST API + Telegram bot
- 55 automated sandbox tests (incl. v5.0.1 excesses-from-either-side suite)
- Misti static analysis — `--all-detectors` with Soufflé: no findings
- TON Dev Skills static analysis — 50+ rules: 0 findings on factory, 1 acknowledged FP on wallet
- CI: build + test + static analysis on every push, Pages auto-deploy

### 🔜 Next
- Partial claim UI: Contract supports `amount > 0`; UI currently sends full claim only.
- Multi-jetton UI: End-to-end flow for onboarding new jettons without manual multisig steps.
- Universal Vaults pricing: Per-jetton price in the public dashboard (currently COGNIQ-only on the backend).
- Off-chain jetton-wallet verifier: CI check that `own_wallets[master]` matches the actual jetton wallet.

### 🔮 Future (v6+)
- On-chain forward-only extension (`unlock_at` push-out) — not implemented in wallet v5.0.1
- Manual pending-claim reset for stuck settlements — not implemented in wallet v5.0.1
- Batch lock creation
- Time-locked admin rescue for stuck jettons
- Multi-beneficiary vesting schedules
- On-chain proof explorer (standalone)

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

Security policy, scope, and reporting instructions: [SECURITY.md](SECURITY.md).

**Verification status:**
- ✅ **Automated tests:** 55 sandbox tests covering happy paths, bounces, access control, time boundaries, fee handling, and the full v5.0.1 excesses-from-either-side matrix.
- ✅ **Static analysis (Misti):** `--all-detectors` with Soufflé, no findings across 42 detectors. Report: [docs/audit/misti-report.txt](docs/audit/misti-report.txt).
- ✅ **Static analysis (TON Dev Skills):** 50+ rules; 0 findings on `lockup_factory.tact`, 1 acknowledged false positive on `lockup_wallet.tact` (see [Verification](#-verification)). Report: [docs/audit/ton-dev-skills-audit.txt](docs/audit/ton-dev-skills-audit.txt).
- ✅ **Mainnet-verified:** v5.0.1 self-destruct and excesses-handling confirmed on mainnet — tx [`de15fd59…a94b4fcb`](https://tonviewer.com/transaction/de15fd59a94b4fcb), 28 Sep 2026.

---

## 📚 Documentation
- [docs/SPEC.md](docs/SPEC.md) — Full contract specification, invariants, message opcodes, per-contract verification status.
- [SECURITY.md](SECURITY.md) — Vulnerability reporting, scope, current audit status.
- [NEURON Whitepaper](https://neuron.bothost.tech/whitepaper.html) — Full ecosystem documentation.

---

## 📄 License
MIT © NEURON Blockchain Ecosystem — see [LICENSE](LICENSE).
