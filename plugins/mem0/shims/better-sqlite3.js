// The subset of better-sqlite3 that Mem0 uses, on node:sqlite (Node >= 22.5).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export default class Database {
  constructor(file) {
    if (file && file !== ':memory:' && !String(file).startsWith('file:')) fs.mkdirSync(path.dirname(file), { recursive: true });
    this._db = new DatabaseSync(file || ':memory:');
  }
  prepare(sql) { const st = this._db.prepare(sql); return { run: (...a) => st.run(...a), get: (...a) => st.get(...a), all: (...a) => st.all(...a) }; }
  exec(sql) { this._db.exec(sql); return this; }
  pragma(p) { return this._db.prepare(`PRAGMA ${p}`).all(); }
  transaction(fn) { return (...a) => { this._db.exec('BEGIN'); try { const r = fn(...a); this._db.exec('COMMIT'); return r; } catch (e) { this._db.exec('ROLLBACK'); throw e; } }; }
  close() { this._db.close(); }
}
