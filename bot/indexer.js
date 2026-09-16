// bot/indexer.js — polls factory transactions, parses events, writes to DB
const { Address, beginCell, Cell } = require('@ton/core');
const { TonClient } = require('@ton/ton');
const db = require('./db');

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const NETWORK = process.env.NETWORK || 'testnet';

const client = new TonClient({
  endpoint: `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api/v2/jsonRPC`,
  apiKey: process.env.TONCENTER_API_KEY,
});

function parseLockCreated(body) {
  // opcode 0x100, lock_id (uint64), creator (Address), beneficiary (Address), jetton (Address), amount (coins), unlock_at (uint64)
  const slice = body.beginParse();
  const opcode = slice.loadUint(32);
  if (opcode !== 0x100) return null;
  const lock_id = slice.loadUintBig(64);
  const creator = slice.loadAddress().toString();
  const beneficiary = slice.loadAddress().toString();
  const jetton = slice.loadAddress().toString();
  const amount = slice.loadCoins().toString();
  const unlock_at = slice.loadUintBig(64);
  return { lock_id: Number(lock_id), creator, beneficiary, jetton, amount, unlock_at: Number(unlock_at) };
}

function parseClaimed(body) {
  // opcode 0x101, lock_id (uint64), amount (coins), beneficiary (Address)
  const slice = body.beginParse();
  const opcode = slice.loadUint(32);
  if (opcode !== 0x101) return null;
  const lock_id = slice.loadUintBig(64);
  const amount = slice.loadCoins().toString();
  const beneficiary = slice.loadAddress().toString();
  return { lock_id: Number(lock_id), amount, beneficiary };
}

function parseExtended(body) {
  // opcode 0x102, lock_id (uint64), old_unlock_at (uint64), new_unlock_at (uint64)
  const slice = body.beginParse();
  const opcode = slice.loadUint(32);
  if (opcode !== 0x102) return null;
  const lock_id = slice.loadUintBig(64);
  const old_unlock_at = slice.loadUintBig(64);
  const new_unlock_at = slice.loadUintBig(64);
  return { lock_id: Number(lock_id), old_unlock_at: Number(old_unlock_at), new_unlock_at: Number(new_unlock_at) };
}

async function pollFactory() {
  try {
    const cursor = await db.getCursor();
    const address = Address.parse(FACTORY_ADDRESS);
    const txs = await client.getTransactions(address, { limit: 50, lt: cursor.toString() });
    
    for (const tx of txs.reverse()) {
      const lt = tx.lt;
      if (lt <= cursor) continue;
      
      const txHash = tx.hash().toString('hex');
      
      // Parse out_messages for LockCreated events
      for (const outMsg of tx.outMessages.values()) {
        if (outMsg.info.type === 'external-out') {
          const body = outMsg.body;
          const lockCreated = parseLockCreated(body);
          if (lockCreated) {
            // Compute LockupWallet address (initOf from contract)
            const factory = Address.parse(FACTORY_ADDRESS);
            const jetton = Address.parse(lockCreated.jetton);
            const beneficiary = Address.parse(lockCreated.beneficiary);
            const creator = Address.parse(lockCreated.creator);
            const amount = BigInt(lockCreated.amount);
            const unlock_at = BigInt(lockCreated.unlock_at);
            const lock_id = BigInt(lockCreated.lock_id);
            
            const lockupWallet = client.open({
              address: Address.parse(FACTORY_ADDRESS), // placeholder, we need initOf
            });
            
            await db.insertLock({
              ...lockCreated,
              lockup_wallet: 'COMPUTED_VIA_INITOF', // TODO: compute properly
              factory: FACTORY_ADDRESS,
            });
            
            await db.insertEvent({
              lock_id: lockCreated.lock_id,
              event_type: 'LockCreated',
              event_data: lockCreated,
              tx_hash: txHash + '-' + lockCreated.lock_id,
            });
            
            console.log('Indexed LockCreated:', lockCreated.lock_id);
          }
        }
      }
      
      await db.setCursor(lt);
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

async function loop() {
  for (;;) {
    await pollFactory();
    await new Promise((r) => setTimeout(r, 3000));
  }
}

module.exports = { loop };
