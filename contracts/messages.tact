// ═══════════════════════════════════════════════════════════════════════════
// NEURON Vesting — shared TEP-74 message types
// ═══════════════════════════════════════════════════════════════════════════
// Imported by both LockupFactory and LockupWallet.
// Tact automatically strips Either Cell Slice for `Slice as remaining`,
// so downstream code receives the Cell's content directly in the slice.
// ═══════════════════════════════════════════════════════════════════════════

message(0x0f8a7ea5) JettonTransfer {
    query_id: Int as uint64;
    amount: Int as coins;
    destination: Address;
    response_destination: Address;
    custom_payload: Cell?;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x7362d09c) JettonNotification {
    query_id: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forward_payload: Slice as remaining;
}
