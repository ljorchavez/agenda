import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './client.js';
import { decryptSecret, encryptSecret, needsReencrypt } from '../lib/crypto.js';

/**
 * Moves every encrypted value to the DATA_ENCRYPTION_KEY format ("v2:"). Runs on each deploy;
 * once everything is moved it finds nothing to do. Safe to stop and rerun at any point.
 */
export const ENCRYPTED_COLUMNS: Array<[table: string, column: string, key?: string]> = [
  ['tenants', 'mp_access_token_enc'],
  ['tenants', 'invoicing_enc'],
  ['users', 'totp_secret_enc'],
  ['customer_records', 'allergies_enc', 'customer_id'],
  ['customer_records', 'conditions_enc', 'customer_id'],
  ['record_notes', 'body_enc'],
  ['record_photos', 'note_enc'],
  ['form_responses', 'answers_enc'],
  ['clinical_notes', 'content_enc'],
];

export async function reencryptAll(): Promise<number> {
  if (!process.env.DATA_ENCRYPTION_KEY?.trim()) {
    console.log('DATA_ENCRYPTION_KEY not set: nothing to re-encrypt');
    return 0;
  }
  const db = getDb();
  let moved = 0;
  for (const [table, column, key = 'id'] of ENCRYPTED_COLUMNS) {
    for (;;) {
      const res = await db.execute<{ id: string; v: string }>(sql`
        select ${sql.identifier(key)}::text as id, ${sql.identifier(column)} as v from ${sql.identifier(table)}
        where ${sql.identifier(column)} is not null and ${sql.identifier(column)} not like 'v2:%'
        limit 500`);
      const rows = res.rows.filter((r) => needsReencrypt(r.v));
      if (!rows.length) break;
      for (const r of rows) {
        const next = encryptSecret(decryptSecret(r.v));
        await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${next}
          where ${sql.identifier(key)}::text = ${r.id} and ${sql.identifier(column)} = ${r.v}`);
        moved++;
      }
    }
  }
  console.log(`Re-encrypted ${moved} values`);
  return moved;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reencryptAll()
    .catch((e) => {
      console.error('Re-encryption failed:', e);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
