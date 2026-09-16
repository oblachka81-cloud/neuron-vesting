import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
(globalThis as any).process = (globalThis as any).process || { env: {} };
