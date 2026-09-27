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
- **Immutable schedule:** The beneficiary can claim only after `unlock_at`.
- **Forward-only extension:** The creator can only push the unlock date forward, never shorten it.
- **On-chain proof:** Every lock is verifiable via the factory's `LockCreated` event and the public Vaults dashboard.
- **TEP-89 discovery:** The wallet resolves its jetton wallet through the jetton master — no assumptions about specific jetton-wallet implementations.
- **Self-destruct on completion:** After the final claim, the `LockupWallet` sweeps its remaining TON to the beneficiary and destroys itself (reclaims storage deposit, leaving no dead dust).
- **Treasury multisig:** On-chain whitelisting and fee withdrawals are secured via a 2-of-3 multisig.

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
| `LockupFactory` | Singleton. Receives jetton transfers with a `CreateLock` payload, deploys per-lock `LockupWallet` instances, forwards locked jettons, and accumulates platform fees. |
| `LockupWallet` | One instance per lock. Holds the jettons, enforces the schedule, releases to the beneficiary on time, and self-destructs after the final claim. |
| `messages.tact` | Shared TEP-74 / TEP-89 message types (imported by both contracts). |

### Flow
```text
┌──────────┐   JettonTransfer + CreateLock payload   ┌───────────────┐
│  User    │ ──────────────────────────────────────▶ │ LockupFactory │
└──────────┘                                          └───────┬───────┘
                                                              │
              ┌───────────────┬─────────────────┬─────────────┘
              ▼               ▼                 ▼
        ┌──────────┐    ┌──────────────┐   ┌──────────────┐
        │  Deploy  │    │  Forward     │   │   Refund     │
        │  Lockup  │───▶│  jettons to  │   │   overpay    │
        │  Wallet  │    │  LockupWallet│   │   to creator │
        └────┬─────┘    └──────────────┘   └──────────────┘
             │  (funded)
             ▼
        ┌──────────────┐
        │ LockupWallet │  ◀── Beneficiary claims after unlock_at
        │ (1 per lock) │  ◀── Creator extends (forward-only)
        └──────────────┘
```

---

## ⚙️ How it works

### 1. Create a lock
Any user sends a jetton transfer to the `LockupFactory` with:
- **Amount:** Number of jettons to lock.
- **Forward payload:** `CreateLock` structure (`jetton_master`, `beneficiary`, `unlock_at`).
- **Attached TON:** ≥ 1.12 TON (1 TON platform fee + 0.12 TON gas buffer). *Overpay is refunded instantly.*

The factory:
1. Validates the sender is a whitelisted jetton wallet.
2. Charges a 0.5% jetton fee (sent to platform treasury).
3. Deploys a new `LockupWallet` for this lock.
4. Forwards the locked jettons to it.
5. Emits `LockCreated`.

### 2. Claim
After `unlock_at`, the beneficiary sends a `Claim` message to the `LockupWallet`:
- `amount = 0` → claim everything available.
- `amount > 0` → partial claim.

The wallet transfers jettons to the beneficiary. If the transfer bounces, accounting rolls back automatically.  
**Final claim bonus:** When `claimed == total_amount`, the `LockupWallet` sweeps all remaining TON to the beneficiary and self-destructs (`mode: 128 + 32 + 2`).

### 3. Extend
While the lock is still locked (`now() < unlock_at`), the creator can send `Extend` to push the unlock date forward. Maximum horizon: 10 years from the message timestamp. Cannot shorten.

### 4. Withdraw fees
The treasury can withdraw:
- **Jetton fees:** 0.5% accumulated per jetton master (`WithdrawFees`).
- **TON fees:** 1 TON per lock (`WithdrawTonFees`).

---

## 💰 Fee structure

| Fee | Amount | Paid by | Destination |
| :--- | :--- | :--- | :--- |
| **Platform fee (TON)** | 1 TON per lock | Creator | Factory `ton_fees` → treasury |
| **Gas buffer** | 0.12 TON per lock | Creator | Consumed by gas / refunded on overpay |
| **Platform fee (jetton)** | 0.5% of locked amount | Deducted from lock | Factory `fees[master]` → treasury |

*Overpay (attach > 1.12 TON) is refunded to the creator immediately.*

---

## 🛡️ Trust model

| Party | Can | Cannot |
| :--- | :--- | :--- |
| **Beneficiary** | Claim after unlock. | Claim before unlock. Claim if not funded. |
| **Creator** | Extend unlock forward (while locked). | Withdraw jettons. Shorten unlock. Extend after unlock. |
| **Factory** | Deploy `LockupWallet`. Deposit jettons once. Forward overpay. | Withdraw jettons from `LockupWallet`. Reset pending claims. |
| **Treasury** | Whitelist jetton masters. Withdraw accumulated fees. | Steal locked jettons. Modify existing locks. |
| **Anyone** | Send TON (gas) to contracts. Send jettons (accepted but ignored). | Interfere with locks. |

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
*Prints a ready-to-sign `SetJettonWallet` body for multisig.ton.org. Sign with 2 of 3 treasury keys.*

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
└── check-jetton.yml          # Manual on-chain whitelist check
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
| `/api/applications` | POST | Submit a whitelist application |
| `/api/applications/status/:id` | GET | Application status |
| `/api/admin/*` | various | Admin operations (login, approve, reject, withdraw bodies) |

*(Note: Frontend Whitelist cards fetch live prices dynamically via GeckoTerminal API with a STON.fi fallback, independent of the Vaults summary endpoint).*

---

## 📜 Contract versions

**Current:** `v5.0.0` (LockupFactory + LockupWallet).

### Changelog v5.0.0
- **LockupWallet:** Self-destruct after final claim; remaining TON swept to beneficiary (`mode: 128 + 32 + 2`).
- **LockupFactory:** `DEPLOY_GAS` reduced from 0.15 → 0.12 TON; bounce refund now returns both platform fee and gas buffer; `JettonExcesses` accepted silently (no-op).
- **TEP-89 discovery:** Unchanged — wallet resolves its own jetton wallet via master, no `StateInit` assumptions.

*See [docs/SPEC.md](docs/SPEC.md) for the full specification, invariants, and known limitations.*

---

## 🗺️ Roadmap

### ✅ Shipped (v5.0.0)
- LockupFactory + LockupWallet on TON mainnet
- COGNIQ on-chain whitelisted via treasury multisig
- TEP-89 jetton-wallet discovery
- Self-destruct after final claim (no dead dust)
- `add-jetton.ts` CLI + admin multisig body generator
- Public Vaults dashboard
- Indexer + REST API + Telegram bot
- 51 automated sandbox tests
- CI: build + test on every push, Pages auto-deploy

### 🔜 Next
- **Extend UI:** Contract supports forward-only extension; UI for it is pending.
- **Partial claim UI:** Contract supports `amount > 0`; UI currently sends full claim only.
- **Multi-jetton UI:** End-to-end flow for onboarding new jettons without manual multisig steps.
- **Off-chain jetton-wallet verifier:** CI check that `own_wallets[master]` matches the actual jetton wallet.
- **Formal external audit:** Planned before onboarding third-party projects.

### 🔮 Future (v6+)
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
- **Internal review:** Independent review by four AI code-analysis agents. All critical findings addressed in v2.5.1 / v2.6.1 / v5.0.0.
- **Automated tests:** 51 sandbox tests covering happy paths, bounces, access control, time boundaries, and fee handling.
- **External audit:** Not yet performed. Planned before onboarding third-party projects.

---

## 📚 Documentation
- [docs/SPEC.md](docs/SPEC.md) — Full contract specification, invariants, message opcodes.
- [SECURITY.md](SECURITY.md) — Vulnerability reporting, scope, current audit status.
- [NEURON Whitepaper](https://neuron.bothost.tech/whitepaper.html) — Full ecosystem documentation.

---

## 📄 License
MIT © NEURON Blockchain Ecosystem — see [LICENSE](LICENSE).
```
