export const NETWORK: 'testnet' | 'mainnet' = 'mainnet';
export const FACTORY_ADDRESS = 'EQCMcVc-pvcr9J5U7pFqDfO7YoSoi8lg_MJpS-0rB4PBnjyI'; 
export const API_URL = 'https://neuronvesting.bothost.tech';
export const MANIFEST_URL = 'https://oblachka81-cloud.github.io/neuron-vesting/tonconnect-manifest.json';
export const IS_TEST = FACTORY_ADDRESS.startsWith('kQ') || FACTORY_ADDRESS.startsWith('0Q');
export const EXPLORER = (addr: string) => {
  const main = addr.startsWith('EQ') || addr.startsWith('UQ') || addr.startsWith('Ef') || addr.startsWith('Uf');
  return main ? `https://tonviewer.com/${addr}` : `https://testnet.tonviewer.com/${addr}`;
};
export const TONCENTER = IS_TEST
  ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
  : 'https://toncenter.com/api/v2/jsonRPC';
