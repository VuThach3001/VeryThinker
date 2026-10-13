import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite, hash, readConfig, safePath, withOperationLock } from './storage.js';

const registryPath = '.verythinker/native/trust.json';
const backupPath = '.verythinker/cache/native/trust-backup.json';
const privatePath = '.verythinker/cache/native/private-key.pem';
interface TrustBackup {
  schema_version: 1;
  project_id: string;
  key_id: string;
  trust_bytes: string;
  public_keys: Record<string, string>;
  signature: string;
}
function registry(bytes: string): { schema_version: 1; keys: string[] } {
  const value = JSON.parse(bytes);
  if (
    value.schema_version !== 1 ||
    !Array.isArray(value.keys) ||
    !value.keys.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
  )
    throw new Error('Native trust registry is malformed; automatic recovery will not replace it.');
  return value;
}
function unsigned(backup: TrustBackup): string {
  const { signature: _signature, ...payload } = backup;
  return JSON.stringify(payload);
}

/** Restore missing public trust files from corroborated local state, without enrolling a key. */
export function ensureNativeTrustFiles(root: string, snapshot = false): string[] {
  return withOperationLock(root, 'native-trust-files', () => {
    const privateFile = safePath(root, privatePath);
    if (!existsSync(privateFile))
      throw new Error(
        'Native trust recovery requires the original local signing key; no replacement key was generated.',
      );
    const privateKey = createPrivateKey(readFileSync(privateFile, 'utf8'));
    const publicKey = createPublicKey(privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const keyId = hash(publicKey);
    const trustFile = safePath(root, registryPath);
    const backupFile = safePath(root, backupPath);
    let backup: TrustBackup | undefined;
    if (existsSync(backupFile))
      try {
        const bytes = readFileSync(backupFile, 'utf8');
        if (bytes.length > 1024 * 1024)
          throw new Error('Native trust backup exceeds its size limit.');
        backup = JSON.parse(bytes) as TrustBackup;
        if (
          backup.schema_version !== 1 ||
          backup.project_id !== readConfig(root).project_id ||
          backup.key_id !== keyId ||
          !backup.public_keys ||
          backup.public_keys[keyId] !== publicKey ||
          typeof backup.signature !== 'string' ||
          !verify(
            null,
            Buffer.from(unsigned(backup)),
            createPublicKey(publicKey),
            Buffer.from(backup.signature, 'base64'),
          )
        )
          throw new Error('Native trust backup is not a matching verified project backup.');
        registry(backup.trust_bytes);
        for (const [id, key] of Object.entries(backup.public_keys))
          if (!/^[a-f0-9]{64}$/.test(id) || typeof key !== 'string' || hash(key) !== id)
            throw new Error('Native trust backup contains an invalid public key.');
      } catch (error) {
        // An intact current registry and all its public keys are authoritative.
        // A corrupt cache can be rebuilt from them, never used to replace them.
        if (!existsSync(trustFile)) throw error;
        const current = registry(readFileSync(trustFile, 'utf8'));
        if (
          !current.keys.includes(keyId) ||
          current.keys.some(
            (id) =>
              id !== keyId && !existsSync(safePath(root, `.verythinker/native/keys/${id}.pem`)),
          )
        )
          throw error;
        backup = undefined;
      }
    const trustBytes = existsSync(trustFile)
      ? readFileSync(trustFile, 'utf8')
      : backup?.trust_bytes;
    if (!trustBytes)
      throw new Error(
        'Native trust registry is missing and no verified local backup exists. Restore the original public trust metadata; the signing key and receipts were preserved.',
      );
    const trusted = registry(trustBytes);
    if (!trusted.keys.includes(keyId))
      throw new Error(
        'Native signing key is not trusted; automatic recovery never enrolls or re-enrolls it.',
      );
    const publicKeys: Record<string, string> = {};
    const missing: [string, string][] = [];
    for (const id of trusted.keys) {
      const path = `.verythinker/native/keys/${id}.pem`;
      const file = safePath(root, path);
      const key = existsSync(file)
        ? readFileSync(file, 'utf8')
        : id === keyId
          ? publicKey
          : backup?.public_keys[id];
      if (!key || hash(key) !== id || (id === keyId && key !== publicKey))
        throw new Error(
          `Native public trust key ${id} is missing or mismatched; automatic recovery preserves existing trust decisions.`,
        );
      publicKeys[id] = key;
      if (!existsSync(file)) missing.push([path, key]);
    }
    // Validate every existing trust decision before any restoration writes.
    for (const [path, key] of missing) atomicWrite(safePath(root, path), key);
    const restored = missing.map(([path]) => path);
    if (!existsSync(trustFile)) {
      atomicWrite(trustFile, trustBytes);
      restored.push(registryPath);
    }
    if (snapshot || restored.length) {
      const next: TrustBackup = {
        schema_version: 1,
        project_id: readConfig(root).project_id,
        key_id: keyId,
        trust_bytes: trustBytes,
        public_keys: publicKeys,
        signature: '',
      };
      next.signature = sign(null, Buffer.from(unsigned(next)), privateKey).toString('base64');
      const bytes = JSON.stringify(next, null, 2) + '\n';
      if (!existsSync(backupFile) || readFileSync(backupFile, 'utf8') !== bytes)
        atomicWrite(backupFile, bytes);
    }
    return restored;
  });
}
