# Security Policy

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues.**

Instead, use one of the following channels:

- **GitHub Security Advisories:** [Submit privately](https://github.com/oblachka81-cloud/neuron-vesting/security/advisories/new)
- **Email:** oblacka81@gmail.com
- **Telegram:** NEURON Support — [@animaneuri](https://t.me/animaneuri)

### What to include

- Description of the vulnerability
- Steps to reproduce (PoC if possible)
- Impact assessment (who is affected, what can be lost)
- Suggested fix (optional)

### Response timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgement | Within **48 hours** |
| Initial assessment | Within **5 days** |
| Fix or mitigation | Within **7–14 days** depending on severity |
| Public disclosure | After fix is deployed and users are notified |

We will **credit** reporters in the release notes unless they prefer to remain anonymous.

---

## Scope

### In scope

- `LockupFactory` and `LockupWallet` smart contracts
- Deploy scripts and CI configuration
- Off-chain indexer and verifier scripts

### Out of scope

- Frontend — report to the frontend maintainers
- Third-party jetton masters or wallets
- TON network itself
- Social engineering of team members

---

## Known security considerations

See [README.md § Known Limitations](./README.md#known-limitations) for documented trade-offs.

### Trust model summary

- **Treasury:** trusted for whitelisting jettons and withdrawing fees. A compromised treasury can DoS new locks but **cannot steal** locked jettons.
- **Factory:** cannot withdraw jettons from `LockupWallet`.
- **Creator:** can only extend unlock forward. Cannot withdraw.
- **Beneficiary:** can claim after unlock. Cannot claim early.

### Bug bounty

**No formal bug bounty is currently in place.** We aim to launch one after mainnet deployment and external audit. Until then, we encourage responsible disclosure and will credit researchers publicly.

---

## Audit status

- [x] Internal review: two independent code reviews, all critical findings fixed (v2.5.1 / v2.6.1).
- [x] 55 automated sandbox tests.
- [ ] Multi-sig treasury: **planned**.
- [ ] External formal audit: **planned before onboarding third-party projects**.
