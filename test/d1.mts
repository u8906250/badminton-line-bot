// 用 Node 內建 SQLite 模擬 D1 介面（prepare/bind/first/all/run/batch），只給測試用。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createTestDb(schemaPath: string) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(readFileSync(schemaPath, 'utf8'));
  const stmt = (sql: string, vals: unknown[] = []): any => {
    const exec = () => raw.prepare(sql).all(...(vals as any[]));
    return {
      bind: (...v: unknown[]) => stmt(sql, v),
      first: async () => exec()[0] ?? null,
      all: async () => ({ results: exec(), success: true }),
      run: async () => {
        exec();
        return { results: [], success: true };
      },
      _exec: exec,
    };
  };
  const DB: any = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: any[]) => {
      raw.exec('BEGIN');
      try {
        const out = list.map((s) => ({ results: s._exec(), success: true }));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const q = (sql: string, ...v: any[]) => raw.prepare(sql).all(...v) as any[];
  return { DB, q };
}
