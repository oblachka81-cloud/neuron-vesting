import './price'; 
import './polyfills';
import { TonConnectUI } from '@tonconnect/ui';
import { MANIFEST_URL } from './config';
import { mountWizard } from './wizard';
import { mountCabinet } from './cabinet';

const tc = new TonConnectUI({
  manifestUrl: MANIFEST_URL,
  buttonRootId: 'ton-connect',
});

mountWizard(tc);
mountCabinet(tc);

// ===== Tab switcher =====
document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = (btn as HTMLElement).dataset.tab!;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector(`[data-panel="${tab}"]`)!.classList.add('active');
    if (tab === 'locks') (window as any).__nv.refreshLocks();
    if (tab === 'apps') (window as any).__nv.refreshApps();
    if (tab === 'whitelist') (window as any).__nv.refreshWhitelist();
  });
});
