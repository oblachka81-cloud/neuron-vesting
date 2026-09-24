import { Address, beginCell, toNano } from '@ton/core';

const RPC = 'https://toncenter.com/api/v2/jsonRPC';
const TO = Address.parse('UQBniD_M-MTeVqUbWshZrXdQcz0m8lPstG3mQg1AL5KKCGSv');

const RESERVE_GAS = toNano('0.06');
const MULTISIG_VALUE = toNano('0.2');

const FACTORIES: [string, string][] = [
    ['salt3',  'EQBh5qfBk5q_du4aw4pBnxee0_FFKTmBkVIiS2G2ZkWGqhZL'],
    ['salt2',  'EQDchgRlQ02H69hwys9ZGdQiiaqvt6OVVeKQvNb6LWlj0S5z'],
];

async function rpc(method: string, params: any, apiKey?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const r = await fetch(RPC, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: '1', jsonrpc: '2.0', method, params }),
    });
    const j: any = await r.json();
    if (!j.ok) throw new Error(`${method}: ${JSON.stringify(j)}`);
    return j.result;
}

function parseNumStackEntry(entry: any): bigint {
    if (!entry || entry.length < 2) return 0n;
    const raw = entry[1];
    if (typeof raw === 'string') {
        if (raw.startsWith('0x') || raw.startsWith('0X')) return BigInt(raw);
        return BigInt(raw);
    }
    if (typeof raw === 'number') return BigInt(raw);
    return 0n;
}

function buildBody(op: number, queryId: bigint, amount: bigint, dest: Address): string {
    return beginCell()
        .storeUint(op, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(dest)
        .endCell()
        .toBoc()
        .toString('base64');
}

async function main() {
    const apiKey = process.env.TONCENTER_API_KEY || undefined;
    let qid = BigInt(Date.now());

    let first = true;
for (const [name, addr] of FACTORIES) {
    if (!first) {
        console.log('\n(пауза 3 сек перед следующей фабрикой, чтобы не ловить rate limit)');
        await new Promise((r) => setTimeout(r, 3000));
    }
    first = false;
    console.log('\n═══════════════════════════════════════════════════════════════');
        console.log(`FACTORY ${name}: ${addr}`);
        console.log('═══════════════════════════════════════════════════════════════');

        const rawAddr = Address.parse(addr).toRawString();

        let bal: bigint = 0n;
        try {
            const balRes = await rpc('getAddressBalance', { address: rawAddr }, apiKey);
            const balStr = typeof balRes === 'string' ? balRes : (balRes?.result ?? '0');
            bal = BigInt(balStr);
            console.log(`balance      : ${Number(bal) / 1e9} TON`);
        } catch (e) {
            console.log(`balance      : FAILED (${(e as Error).message})`);
            continue;
        }

        let tf = 0n;
        try {
            const g = await rpc('runGetMethod', { address: rawAddr, method: 'tonFees', stack: [] }, apiKey);
            tf = parseNumStackEntry(g.stack[0]);
            console.log(`tonFees      : ${Number(tf) / 1e9} TON`);
        } catch (e) {
            console.log(`tonFees      : getter failed — assuming 0`);
        }

        // ORDER A: WithdrawTonFees — только если tonFees > 0
        const feeAmount = tf < bal - RESERVE_GAS ? tf : (bal > RESERVE_GAS ? bal - RESERVE_GAS : 0n);
        if (feeAmount > 0n) {
            const body = buildBody(0x22, qid++, feeAmount, TO);
            console.log('\n--- ORDER A: WithdrawTonFees ---');
            console.log(`Target : ${addr}`);
            console.log(`Value  : ${Number(MULTISIG_VALUE) / 1e9}`);
            console.log(`Amount : ${Number(feeAmount) / 1e9} TON → ${TO.toString()}`);
            console.log(`Body   : ${body}`);
        } else {
            console.log('\nORDER A: skipped (tonFees = 0)');
        }

        // ORDER B: RescueTon — вывести всё сверх reserve
        const rest = bal - RESERVE_GAS;
        if (rest > 0n) {
            const body = buildBody(0x23, qid++, rest, TO);
            console.log('\n--- ORDER B: RescueTon ---');
            console.log(`Target : ${addr}`);
            console.log(`Value  : ${Number(MULTISIG_VALUE) / 1e9}`);
            console.log(`Amount : ${Number(rest) / 1e9} TON → ${TO.toString()}`);
            console.log(`Body   : ${body}`);
        } else {
            console.log('\nORDER B: skipped (balance too small)');
        }
    }

    console.log('\n───────────────────────────────────────────────────────────────');
    console.log('Copy Body → multisig.ton.org → Create new order → Arbitrary order.');
    console.log('Value always 0.2 TON — это газ мультисига, не сумма вывода.');
    console.log('Sign with 2 of 3 signers.');
    console.log('───────────────────────────────────────────────────────────────');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
