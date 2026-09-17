export const NETWORK: 'testnet' | 'mainnet' = 'testnet';
export const FACTORY_ADDRESS = 'kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh';
export const API_URL = 'https://neuronvesting.bothost.tech';
export const MANIFEST_URL = 'https://oblachka81-cloud.github.io/neuron-vesting/tonconnect-manifest.json';
export const IS_TEST = FACTORY_ADDRESS.startsWith('kQ') || FACTORY_ADDRESS.startsWith('0Q');
export const EXPLORER = (addr: string) =>
  IS_TEST ? `https://testnet.tonviewer.com/${addr}` : `https://tonviewer.com/${addr}`;
export const TONCENTER = IS_TEST
  ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
  : 'https://toncenter.com/api/v2/jsonRPC';
