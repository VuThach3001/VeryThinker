import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadRecords, safePath, sourceHash } from './storage.js';

function open(root: string): DatabaseSync {
  const path = safePath(root, '.verythinker/cache/index.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,owner TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS links(source TEXT NOT NULL,type TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(source,type,target));
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,title,body);`);
  return db;
}
export function rebuildIndex(root: string): { records: number; source_hash: string } {
  const records = loadRecords(root);
  const fingerprint = sourceHash(root);
  const db = open(root);
  try {
    db.exec('BEGIN IMMEDIATE; DELETE FROM records; DELETE FROM links; DELETE FROM search;');
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?)');
    const link = db.prepare('INSERT INTO links VALUES(?,?,?)');
    const search = db.prepare('INSERT INTO search VALUES(?,?,?)');
    for (const record of records) {
      const m = record.meta;
      insert.run(
        m.id,
        m.type,
        m.title,
        m.owner,
        m.status,
        m.revision,
        record.path,
        record.body,
        JSON.stringify(m.data),
      );
      search.run(m.id, m.title, record.body);
      for (const l of m.links) link.run(m.id, l.type, l.target);
    }
    db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('source_hash', fingerprint);
    db.exec('COMMIT;');
    return { records: records.length, source_hash: fingerprint };
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
export function ensureIndex(root: string): { rebuilt: boolean; source_hash: string } {
  const fingerprint = sourceHash(root);
  const db = open(root);
  let indexed: unknown;
  try {
    indexed = db.prepare('SELECT value FROM meta WHERE key=?').get('source_hash')?.value;
  } finally {
    db.close();
  }
  if (indexed !== fingerprint) {
    rebuildIndex(root);
    return { rebuilt: true, source_hash: fingerprint };
  }
  return { rebuilt: false, source_hash: fingerprint };
}
export function searchMemory(root: string, query: string, limit = 20): unknown[] {
  ensureIndex(root);
  const db = open(root);
  try {
    const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 30);
    if (!words.length) return [];
    const expression = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(' AND ');
    return db
      .prepare(
        "SELECT r.id,r.type,r.title,r.status,r.path,snippet(search,2,'','',' … ',24) AS excerpt FROM search JOIN records r ON r.id=search.id WHERE search MATCH ? ORDER BY bm25(search) LIMIT ?",
      )
      .all(expression, Math.min(100, Math.max(1, limit)));
  } finally {
    db.close();
  }
}
