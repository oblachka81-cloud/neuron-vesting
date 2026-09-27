# 🛡️ NEURON Vesting

**On-chain vesting module of the NEURON Blockchain Ecosystem.**  
Lock any TEP-74 jetton on TON with public on-chain proof. Non-custodial. Immutable schedule. Zero custody.

[Live App](https://oblachka81-cloud.github.io/neuron-vesting/) · [Telegram Bot](https://t.me/NeuronEcosystemBot) · [Whitepaper v4.0](https://neuron.bothost.tech/whitepaper.html) · [Specification](docs/SPEC.md) · [Security](SECURITY.md)

[![TON Mainnet](https://img.shields.io/badge/network-TON%20Mainnet-0098EA?logo=ton&logoColor=white)](https://tonviewer.com/EQBAbjNhuYAfWcZ6cnYXHCNhwOf1VH_OBNfkiAzEPvf7S6iE)
[![Tact 1.6.13](https://img.shields.io/badge/tact-1.6.13-blue)](https://tact-lang.org/)
[![Tests](https://img.shields.io/github/actions/workflow/status/oblachka81-cloud/neuron-vesting/compile-tact.yml?branch=main&label=tests)](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/compile-tact.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌐 Part of NEURON Ecosystem
NEURON is a blockchain ecosystem in Telegram with its internal utility token **COGNIQ** on the TON network. It includes a quiz game, the IMPULSE gaming hub, NEURON Bank (staking and transfers), NEURON Exchange (crypto + xStocks), Fiat On-Ramp, and more — all inside a single Telegram mini app.

**NEURON Vesting** is the dedicated on-chain lock module of this ecosystem. It lets any project or holder lock TEP-74 jettons with a transparent, immutable unlock schedule and publish a verifiable on-chain proof. Locked tokens cannot be withdrawn until the `unlock_at` timestamp. That is the whole point.

---

## ✨ Why NEURON Vesting
- **Non-custodial:** Neither the factory, nor the creator, nor the platform can withdraw locked jettons.
- **Immutable schedule:** The beneficiary can claim only after `unlock_at`. The unlock date is fixed at creation and cannot be changed on-chain in v5.0.0.
- **On-chain proof:** Every lock is verifiable via the factory's `LockCreated` event and the public Vaults dashboard.
- **TEP-89 discovery:** Both the factory and the wallet resolve jetton-wallet addresses through the jetton master (`provide_wallet_address`) — no assumptions about any specific TEP-74 wallet implementation or its internal `c4` layout.
- **Self-destruct on completion:** After the final claim, the `LockupWallet` sweeps its remaining TON to the beneficiary and destroys itself (`mode: 128 + 32 + 2`), reclaiming the storage deposit and leaving no dead dust.
- **Treasury multisig:** On-chain whitelisting, fee withdrawals and emergency rescue are signed via a 2-of-3 multisig.

---

## 🚀 Live on Mainnet

| Contract | Address |
| :--- | :--- |
| **LockupFactory** | `EQBAbjNhuYAfWcZ6cnYXHCNhwOf1VH_OBNfkiAzEPvf7S6iE` |
| **Treasury (2-of-3 multisig)** | `EQAODQiP22xLiu_ZGxCfaY6o358FX4-G9bE8D_DTKVzjWwEl` |
| **COGNIQ jetton master** | `EQDOjRZ5rbSnBBvhsv4g0JNN67p89617_2pNc_AO1dTEkaNg` |

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
| `LockupWallet` | One instance per lock. Holds the jettons, enforces the schedule, releases to the beneficiary on claim, and self-destructs after the final claim. |
| `messages.tact` | Shared TEP-74 / TEP-89 message types (imported by both contracts). |

### Flow
```text
┌──────────   JettonTransfer + CreateLock payload   ┌───────────────┐
│  User    │ ──────────────────────────────────────▶ │ LockupFactory │
└──────────                                          └──────────────┘
                                                              │
              ┌───────────────┬─────────────────┬─────────────┘
              ▼               ▼                 ▼
        ┌──────────┐    ┌──────────────┐   ┌──────────────┐
        │  Deploy  │    │  TEP-89      │   │   Refund     │
        │  Lockup  │───▶│  discovery   │   │   overpay    │
        │  Wallet  │    │  + forward   │   │   to creator │
        └────┬─────    └──────────────   └──────────────
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
- **Attached TON:** ≥ 1.1 TON (1 TON platform fee + 0.1 TON gas buffer). *Overpay is refunded instantly.*

The factory:
1. Validates the sender is a whitelisted jetton wallet (reverse map `wallet_to_master`).
2. Charges the configurable jetton fee (default 0.5%, cap 10% — see [Fee structure](#-fee-structure)).
3. Deploys a new `LockupWallet` for this lock (with `DEPLOY_GAS`) and kicks off TEP-89 discovery (`StartDiscovery`).
4. Asks the jetton master for the child wallet's jetton address (`TakeWalletAddress`), then forwards the locked jettons to it.
5. Emits `LockCreated`.

### 2. Claim
After `unlock_at`, the beneficiary sends a `Claim` message to the `LockupWallet`:
- `amount = 0` → claim everything available.
- `amount > 0` → partial claim.

The wallet asks the master (TEP-89) for the beneficiary's jetton wallet, then sends the jettons. Settlement is confirmed by `JettonExcesses` (success) or by a bounce (rollback of `claimed`).  
**Final claim:** when `claimed == total_amount`, the wallet sweeps all remaining TON to the beneficiary and self-destructs (`mode: 128 + 32 + 2`).

> ⚠️ There is no manual reset of an in-flight claim in v5.0.0. If a settlement message never arrives, the wallet stays `pending` and further claims are blocked until it does. Treat `Claim` as fire-and-settle, not fire-and-retry.

### 3. Withdraw fees
The treasury can withdraw:
- **Jetton fees:** accumulated per jetton master (`WithdrawFees`, `0x20`).
- **TON fees:** accumulated platform TON (`WithdrawTonFees`, `0x22`).

Emergency rescue of stray TON / jettons held by the factory is available to the treasury via `RescueTon` (`0x23`) / `RescueJetton` (`0x24`), which never touch funds reserved for pending fee payouts.

---

## 💰 Fee structure

Fees are **configuration parameters set at factory deployment** and adjustable by the treasury via `SetFeeBps` (`0x25`) and `SetFeeTon` (`0x26`). The values below are the current mainnet defaults, not hard-coded bytecode.

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
| **Creator** | Receive the overpay refund and, on a failed deployment, the platform-fee + gas-buffer refund from the factory. | Touch an existing funded lock. Withdraw jettons. Change the unlock date (no on-chain extension in v5.0.0). |
| **Factory** | Deploy `LockupWallet`. Deposit jettons once via TEP-89. Refund overpay / failed-create funds. | Withdraw jettons from a funded `LockupWallet`. Reset a pending claim. |
| **Treasury** | Whitelist jetton masters. Withdraw accumulated fees. Emergency-rescue stray factory funds. | Steal locked jettons. Modify existing locks. |
| **Anyone** | Send TON (gas) to contracts. | Interfere with locks. (Stray jetton deposits to a wallet revert unless they match the expected funding amount.) |

**Treasury is trusted for:** Whitelisting jetton masters and withdrawing accumulated platform fees.  
**Treasury compromise impact:** DoS on new lock creation (bad addresses registered). *No theft of locked jettons.*  
**Mitigation:** 2-of-3 multisig treasury + off-chain verifier.

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
npm test         # 51 sandbox tests via Jest + @ton/sandbox
```

### Add a jetton to the on-chain whitelist
```bash
FACTORY_ADDRESS=EQBAbjNhuYAfWcZ6cnYXHCNhwOf1VH_OBNfkiAzEPvf7S6iE \
npx tsx scripts/add-jetton.ts <JETTON_MASTER_ADDRESS>
```
*Prints a ready-to-sign `SetJettonWallet` body for multisig.ton.org. Sign with 2 of 3 treasury keys. The script is also wired as a manual GitHub Action (`check-jetton.yml`) so the body can be generated in CI without a local toolchain.*

---

## 📂 Project structure

```text
contracts/
├── lockup_factory.tact       # LockupFactory v5.0.0
├── lockup_wallet.tact        # LockupWallet v5.0.0
└── messages.tact             # Shared TEP-74 / TEP-89 messages

tests/
└── vesting.spec.ts           # 51 sandbox tests

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

.github/workflows/
├── compile-tact.yml          # Build & test on every push
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

**Current:** `v5.0.0` (LockupFactory + LockupWallet).

### Changelog v5.0.0
- **LockupWallet:** Added automatic sweep of all remaining TON to the beneficiary and contract self-destruct after the final claim (`mode: 128 + 32 + 2`), eliminating the ~0.3 TON dead-dust that accumulated in v4.1.0. Jetton-wallet resolution is via TEP-89 `provide_wallet_address` (no `StateInit`/`c4` assumptions); funding is reconciled through `fund_sender` when a notification arrives before discovery completes. *Note: on-chain forward-only extension and manual pending-claim reset are **not** present in this revision.*
- **LockupFactory:** `DEPLOY_GAS` reduced from 0.15 → 0.12 TON (internal child-deploy gas); bounce refund now returns both the platform fee and the gas buffer to the creator; `JettonExcesses` accepted silently (no-op); added treasury rescue messages (`RescueTon` `0x23`, `RescueJetton` `0x24`) and fee-config messages (`SetFeeBps` `0x25`, `SetFeeTon` `0x26`).
- **TEP-89 discovery:** Unchanged in spirit — both contracts resolve jetton wallets via the master, no `StateInit` assumptions.

*See [docs/SPEC.md](docs/SPEC.md) for the full specification, invariants, message opcodes, and per-contract verification status.*

---

## 🗺️ Roadmap

### ✅ Shipped (v5.0.0)
- LockupFactory + LockupWallet on TON mainnet
- COGNIQ on-chain whitelisted via treasury multisig
- TEP-89 jetton-wallet discovery (factory + wallet)
- Self-destruct after final claim (no dead dust)
- Configurable platform fees (jetton bps + TON) with treasury setters
- Treasury emergency rescue (TON + jetton) at the factory
- Partial claim (`Claim` accepts `amount > 0`)
- `add-jetton.ts` CLI + admin multisig body generator + CI workflow
- Public Vaults dashboard
- Indexer + REST API + Telegram bot
- 51 automated sandbox tests
- CI: build + test on every push, Pages auto-deploy

### 🔜 Next
- **Partial claim UI:** Contract supports `amount > 0`; UI currently sends full claim only.
- **Multi-jetton UI:** End-to-end flow for onboarding new jettons without manual multisig steps.
- **Universal Vaults pricing:** Per-jetton price in the public dashboard (currently COGNIQ-only on the backend).
- **Off-chain jetton-wallet verifier:** CI check that `own_wallets[master]` matches the actual jetton wallet.
- **Formal external audit:** Planned before onboarding third-party projects.

### 🔮 Future (v6+)
- **On-chain forward-only extension** (`unlock_at` push-out) — *not implemented in wallet v5.0.0*
- **Manual pending-claim reset** for stuck settlements — *not implemented in wallet v5.0.0*
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
- **Backend:** Node.js 22 · Express · PostgreSQL
- **Frontend:** Vite · TypeScript · TonConnect UI
- **Hosting:** GitHub Pages (frontend) · Bothost (backend)

---

## 🔒 Security
Security policy, scope, and reporting instructions: [SECURITY.md](SECURITY.md).

**Current status:**
- **Internal review:** Independent review by four AI code-analysis agents. All critical findings addressed across v2.5.1 / v2.6.1 / v5.0.0.
- **Automated tests:** 51 sandbox tests covering happy paths, bounces, access control, time boundaries, and fee handling.
- **External audit:** Not yet performed. Planned before onboarding third-party projects.

---

## 📚 Documentation
- [docs/SPEC.md](docs/SPEC.md) — Full contract specification, invariants, message opcodes, per-contract verification status.
- [SECURITY.md](SECURITY.md) — Vulnerability reporting, scope, current audit status.
- [NEURON Whitepaper](https://neuron.bothost.tech/whitepaper.html) — Full ecosystem documentation.

---

## 📄 License
MIT © NEURON Blockchain Ecosystem — see [LICENSE](LICENSE).
