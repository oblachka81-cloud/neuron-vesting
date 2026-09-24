// ═══════════════════════════════════════════════════════════════════════════
// gen-rescue.ts — генерирует base64 bodies для multisig.ton.org
// ═══════════════════════════════════════════════════════════════════════════
// Запускается через workflow `Gen Rescue Orders` (workflow_dispatch).
// В логе печатает готовые строки для Arbitrary order → Body.
//
// Что делает:
//   1. Для каждой фабрики из списка читает balance и tonFees (getter).
//   2. Формирует ORDER A (WithdrawTonFees, op 0x22) на сумму tonFees.
//   3. Формирует ORDER B (RescueTon, op 0x23) на весь баланс минус газ.
//   4. Печатает base64 и параметры (Target, Value) для копипаста.
// ═══════════════════════════════════════════════════════════════════════════

import { Address, beginCell, toNano } from '@ton/core';

const RPC = 'https://toncenter.com/api/v2/jsonRPC';

// Куда выводим. По умолчанию — твой основной кошелёк.
const TO = Address.parse('UQBniD_M-MTeVqUbWshZrXdQcz0m8lPstG3mQg1AL5KKCGSv');

// Газ, который оставляем на фабрике (чтобы контракт не сдох от нуля).
const RESERVE_GAS = toNano('0.05');

// Газ для мультисига, чтобы он сам мог отправить ордер.
const MULTISIG_VALUE = toNano('0.2');

// Какие фабрики обрабатываем. ВАЖНО:
//  - salt3 = текущая v4 (TEP-89, RescueTon есть)
//  - salt2 = старая v4 (RescueTon есть)
//  - salt1 (v2.5.1/v2.6.0) НЕ включаем — там RescueTon НЕТ, деньги заперты.
//    Если хочешь попробовать — добавь через env SALT1, но учти риск газа впустую.
const FACTORIES: [string, string][] = [
    ['salt3', 'EQBh5qfBk5q_du4aw4pBnxee0_FFKTmBkVIiS2G2ZkWgqhZL'],
    ['salt2', 'EQDchgRlQ02H69hwys9ZGdQiiagvt60VVekQvNb6LWljO5Sz'],
];

// ─── RPC helper ────────────────────────────────────────────────────────────

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

// ─── Utils ─────────────────────────────────────────────────────────────────

function parseNumStackEntry(entry: any): bigint {
    // toncenter возвращает [type, value] где value либо "0x...", либо уже число
    if (!entry || entry.length < 2) return 0n;
    const raw = entry[1];
    if (typeof raw === 'string') {
        if (raw.startsWith('0x') || raw.startsWith('0X')) return BigInt(raw);
        return BigInt(raw);
    }
    if (typeof raw === 'number') return BigInt(raw);
    return 0n;
}

// Оба сообщения (WithdrawTonFees 0x22 и RescueTon 0x23) имеют одинаковый layout:
//   op(32) + query_id(64) + amount(coins) + destination(Address)
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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    const apiKey = process.env.TONCENTER_API_KEY || undefined;

    let qid = 900n;

    for (const [name, addr] of FACTORIES) {
        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log(`FACTORY ${name}: ${addr}`);
        console.log('═══════════════════════════════════════════════════════════════');

        // 1. balance
        const balRes = await rpc('getAddressBalance', { address: addr }, apiKey);
        const bal = BigInt(balRes);
        console.log(`balance      : ${Number(bal) / 1e9} TON`);

        // 2. tonFees (getter без аргументов)
        let tf = 0n;
        try {
            const g = await rpc(
                'runGetMethod',
                { address: addr, method: 'tonFees', stack: [] },
                apiKey,
            );
            tf = parseNumStackEntry(g.stack[0]);
            console.log(`tonFees      : ${Number(tf) / 1e9} TON`);
        } catch (e) {
            console.log(`tonFees      : getter failed (${(e as Error).message}) — assuming 0`);
        }

        // 3. ORDER A — WithdrawTonFees на сумму tonFees
        const feeAmount = tf < bal - RESERVE_GAS ? tf : (bal > RESERVE_GAS ? bal - RESERVE_GAS : 0n);
        if (feeAmount > 0n) {
            const body = buildBody(0x22, qid++, feeAmount, TO);
            console.log('\n--- ORDER A: WithdrawTonFees ---');
            console.log(`Target : ${addr}`);
            console.log(`Value  : ${Number(MULTISIG_VALUE) / 1e9}`);
            console.log(`Amount : ${Number(feeAmount) / 1e9} TON → ${TO.toString()}`);
            console.log(`Body   : ${body}`);
        } else {
            console.log('\nORDER A: skipped (tonFees = 0 или баланс слишком мал)');
        }

        // 4. ORDER B — RescueTon на весь баланс минус газ
        const rest = bal - RESERVE_GAS;
        if (rest > 0n) {
            const body = buildBody(0x23, qid++, rest, TO);
            console.log('\n--- ORDER B: RescueTon ---');
            console.log(`Target : ${addr}`);
            console.log(`Value  : ${Number(MULTISIG_VALUE) / 1e9}`);
            console.log(`Amount : ${Number(rest) / 1e9} TON → ${TO.toString()}`);
            console.log(`Body   : ${body}`);
        } else {
            console.log('\nORDER B: skipped (баланс слишком мал)');
        }
    }

    console.log('\n───────────────────────────────────────────────────────────────');
    console.log('Скопируй Body в multisig.ton.org → Create new order → Arbitrary order.');
    console.log('Value всегда 0.2 TON — это газ мультисига, не сумма вывода.');
    console.log('Подпиши двумя из трёх signers.');
    console.log('После исполнения — запусти workflow снова, чтобы добить остатки.');
    console.log('───────────────────────────────────────────────────────────────');
}

main().catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
});
