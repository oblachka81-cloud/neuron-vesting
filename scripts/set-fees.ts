// scripts/set-fees.ts — generate a ready-to-sign treasury fee-retune body.
// Modes (one per run):
//   --bps=<0..1000>   SetFeeBps  (op 0x25) — jetton fee in basis points (COGNIQ cut)
//   --ton=<X>         SetFeeTon  (op 0x26) — fixed TON fee per lock, in TON
// Prints target/value/body_base64 for multisig.ton.org. Does NOT sign.
// Treasury ops use a plain qid (high bit CLEAR) per spec F6 — do not OR HIGH_BIT.
import { beginCell, toNano } from '@ton/core';

const FACTORY =
  process.env.FACTORY_ADDRESS ||
  'EQD_dSnLqcBiQyT2LRyNPIUpqAY9Qr9VoMgUCKtHN5xpSCTN';

function arg(name: string): string | undefined {
  const eq = `--${name}=`;
  const a = process.argv.find((s) => s.startsWith(eq));
  if (a) return a.slice(eq.length);
  return process.env[name.toUpperCase()]; // Action passes env
}

function mkQid(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

const bpsRaw = arg('bps');
const tonRaw = arg('ton');

if (bpsRaw == null && tonRaw == null) {
  console.error('usage: tsx scripts/set-fees.ts --bps=<0..1000> | --ton=<TON>');
  process.exit(1);
}
if (bpsRaw != null && tonRaw != null) {
  console.error('pick ONE mode: --bps OR --ton (two bodies confuse the multisig order)');
  process.exit(1);
}

let op: number;
let label: string;
let body: ReturnType<typeof beginCell> extends never ? never : import('@ton/core').Cell;
let qid = mkQid();

if (bpsRaw != null) {
  const bps = Number(bpsRaw);
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
    console.error(`--bps must be integer 0..1000 (MAX_FEE_BPS=1000), got "${bpsRaw}"`);
    process.exit(1);
  }
  op = 0x25;
  label = `SetFeeBps -> ${bps} bps (${(bps / 100).toFixed(2)}% jetton cut)`;
  body = beginCell().storeUint(op, 32).storeUint(qid, 64).storeUint(bps, 16).endCell();
} else {
  const ton = Number(tonRaw);
  if (!Number.isFinite(ton) || ton < 0) {
    console.error(`--ton must be a non-negative number of TON, got "${tonRaw}"`);
    process.exit(1);
  }
  op = 0x26;
  const nano = toNano(String(ton));
  label = `SetFeeTon -> ${ton} TON per lock (${nano} nano)`;
  body = beginCell().storeUint(op, 32).storeUint(qid, 64).storeCoins(nano).endCell();
}

const out = {
  note: 'Sign on multisig.ton.org with 2 of 3 treasury keys. Body is inert without those sigs.',
  op: '0x' + op.toString(16),
  label,
  target: FACTORY,
  value: '0.1', // gas; overpay refunded by the factory
  query_id: qid.toString(),
  body_base64: body.toBoc().toString('base64'),
};

console.log('=== ' + label + ' ===');
console.log(JSON.stringify(out, null, 2));

// GitHub Actions: surface the copy-paste block in the run summary (tablet-friendly).
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const fs = require('fs');
  fs.appendFileSync(
    summary,
    `### ${label}\n\n\`\`\`json\n${JSON.stringify(out, null, 2)}\n\`\`\`\n\n` +
      `Copy \`body_base64\` into multisig.ton.org → new order → target \`${FACTORY}\`, value \`0.1\`, payload = the base64. Sign 2-of-3.\n`,
  );
}
