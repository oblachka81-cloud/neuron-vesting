import { Address } from '@ton/core';

export const NETWORK: 'testnet' | 'mainnet' = 'mainnet';
export const FACTORY_ADDRESS = 'EQCMcVc-pvcr9J5U7pFqDfO7YoSoi8lg_MJpS-0rB4PBnjyI';
export const API_URL = 'https://neuronvesting.bothost.tech';
export const MANIFEST_URL = 'https://oblachka81-cloud.github.io/neuron-vesting/tonconnect-manifest.json';
export const IS_TEST = FACTORY_ADDRESS.startsWith('kQ') || FACTORY_ADDRESS.startsWith('0Q');
export const EXPLORER = (addr: string) => {
  try {
    const parsed = Address.parse(addr).toString({ urlSafe: true });
    const main = parsed.startsWith('EQ') || parsed.startsWith('UQ') || parsed.startsWith('Ef') || parsed.startsWith('Uf');
    return main ? `https://tonviewer.com/${parsed}` : `https://testnet.tonviewer.com/${parsed}`;
  } catch (e) {
    return `https://tonviewer.com/${addr}`;
  }
};
export const TONCENTER = IS_TEST
  ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
  : 'https://toncenter.com/api/v2/jsonRPC';
