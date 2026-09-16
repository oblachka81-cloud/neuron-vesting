# NEURON Vesting

[![Build & Test Contracts](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/build.yml/badge.svg)](https://github.com/oblachka81-cloud/neuron-vesting/actions/workflows/build.yml)

Token Lock & Vesting platform on TON — lock any TEP-74 jetton with public on-chain proof.

## What is it

A non-custodial smart contract system that lets any TON project or token holder lock their jettons with a transparent, immutable schedule. Locked tokens cannot be withdrawn until the unlock date — that is the whole point.

**For projects:** lock team tokens, LP tokens, or advisor allocations and publish a verifiable proof for investors.

**For holders:** lock your tokens for personal discipline or to participate in platform incentives.

## Architecture

Two Tact contracts:

- **`LockupFactory`** — singleton factory that receives jetton transfers and deploys per-user lockup wallets
- **`LockupWallet`** — one instance per lock, holds the tokens, enforces the schedule, releases to the beneficiary on time

See the full contract specification in [`docs/SPEC.md`](docs/SPEC.md).

## Testnet deployment (v1)

- **LockupFactory:** `kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh`
- **Explorer:** [testnet.tonviewer.com/kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh](https://testnet.tonviewer.com/kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh)
- **Deploy pipeline:** GitHub Actions, workflow `Deploy to Testnet` (workflow_dispatch)
- **CI:** build + 10 sandbox tests on every push

## Tech stack

- **Contracts:** [Tact](https://tact-lang.org/) on TON
- **Build & test:** [Blueprint](https://github.com/ton-org/blueprint)
- **CI:** GitHub Actions (compiles and tests contracts on every push)
- **Server:** Express + PostgreSQL (indexer, API)
- **Frontend:** React + TonConnect (mini app + public web pages)

## Repository layout
