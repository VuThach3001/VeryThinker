import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({ schemaVersion: 1, port: 8080, logLevel: 'info' });

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Configuration must be an object.');
  }
  if (Object.keys(value).sort().join(',') !== 'logLevel,port,schemaVersion') {
    throw new TypeError('Configuration must contain only schemaVersion, port, and logLevel.');
  }
  if (value.schemaVersion !== 1) throw new RangeError('Unsupported configuration schemaVersion.');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new RangeError('port must be an integer from 1 to 65535.');
  }
  if (!['debug', 'info', 'warn', 'error'].includes(value.logLevel)) {
    throw new RangeError('logLevel must be debug, info, warn, or error.');
  }
  return { schemaVersion: 1, port: value.port, logLevel: value.logLevel };
}

export async function loadConfig(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw error;
  }
  return validateConfig(JSON.parse(text));
}

export async function saveConfig(file, value) {
  const config = validateConfig(value);
  const destination = resolve(file);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return config;
}
