# 🛡️ Security Policy

**Project:** NEURON Vesting  
**Current Version:** v5.0.0  
**Last Updated:** 2026  

---

## 📩 Reporting a Vulnerability

Please **do not** report security issues through public GitHub issues. 

Instead, use one of the following secure channels:

1. **GitHub Security Advisories**: [Submit a private report](https://github.com/oblachka81-cloud/neuron-vesting/security/advisories/new) *(Recommended)*
2. **Email**: [oblacka81@gmail.com](mailto:oblacka81@gmail.com)
3. **Telegram**: NEURON Support — [@animaneuri](https://t.me/animaneuri)

### What to include in your report:
- 📝 **Description** of the vulnerability.
- 🔄 **Steps to reproduce** (Proof of Concept / code snippet if possible).
- ⚠️ **Impact assessment** (who is affected, what can be lost or disrupted).
- 💡 **Suggested fix** (optional, but highly appreciated).

---

## ⏱️ Response Timeline

| Stage | Timeline |
| :--- | :--- |
| **Acknowledgement** | Within 48 hours |
| **Initial Assessment** | Within 5 business days |
| **Fix or Mitigation** | Within 7–14 days (depending on severity) |
| **Public Disclosure** | After the fix is deployed and users are notified |

> *We will publicly credit security researchers in our release notes, unless they prefer to remain anonymous.*

---

## 🎯 Scope

### ✅ In Scope
- `LockupFactory` and `LockupWallet` Tact smart contracts.
- Deploy scripts and GitHub Actions CI configuration.
- Off-chain indexer, REST API, and verifier scripts (`bot/` directory).

### ❌ Out of Scope
- Frontend UI/UX issues (report to frontend maintainers).
- Vulnerabilities in third-party TEP-74 jetton masters or wallets.
- The TON network protocol itself.
- Social engineering or phishing attempts targeting team members.

---

## 🛡️ Trust Model Summary

For detailed invariants, see [docs/SPEC.md § 9. Trust Model](docs/SPEC.md).

| Party | Capabilities | Limitations |
| :--- | :--- | :--- |
| **Treasury** | Whitelist jettons, withdraw accumulated fees. | **Cannot** steal locked jettons or modify existing locks. |
| **Factory** | Deploy wallets, forward jettons, refund overpay. | **Cannot** withdraw jettons from a deployed `LockupWallet`. |
| **Creator** | Extend unlock date forward (while locked). | **Cannot** withdraw, shorten time, or extend after unlock. |
| **Beneficiary** | Claim after `unlock_at`, reset stuck pending claims. | **Cannot** claim before unlock or if the lock is unfunded. |

> **⚠️ Treasury Compromise Impact:** A compromised treasury can cause a DoS on *new* lock creation (by registering bad addresses). It **cannot** steal already locked jettons. Mitigated by a live **2-of-3 multisig** setup.

---

## 🐛 Bug Bounty

No formal paid bug bounty program is currently active. We aim to launch one after the external formal audit is completed. Until then, we strongly encourage **responsible disclosure** and will publicly credit all verified researchers who help us secure the protocol.

---

## 🔍 Audit & Security Status

- ✅ **Internal Review:** Independent code reviews conducted by four AI code-analysis agents. All critical findings were addressed and resolved in versions leading up to `v5.0.0`.
- ✅ **Automated Testing:** 51 comprehensive sandbox tests covering happy paths, bounce handling, access control, time boundaries, and fee logic.
- ✅ **Treasury Security:** Live 2-of-3 multisig wallet controlling whitelisting and fee withdrawals.
- 🔜 **External Formal Audit:** Planned and scheduled before onboarding any third-party projects to the whitelist.

---

*For a detailed list of known limitations and design trade-offs, please refer to [README.md § Known Limitations](README.md) and [docs/SPEC.md § 8](docs/SPEC.md).*
