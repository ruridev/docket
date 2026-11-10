import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const DATA_DIR = path.resolve(process.env.DOCKET_PORTAL_DATA || path.join(ROOT, 'data'));
export const LOG_DIR = path.join(DATA_DIR, 'logs');

export function portFromArgs(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--port='));
  const v = Number(arg ? arg.slice(7) : process.env.DOCKET_PORTAL_PORT || 4600);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : 4600;
}
