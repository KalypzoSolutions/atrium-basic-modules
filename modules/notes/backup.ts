/**
 * Datensicherung der Notizen: `note_links.token_hash` (`core.crypto.forModule('notes').hash(token)`, siehe
 * `links.service.ts`) nach dem Wiederherstellen mit dem Schlüssel des Zielservers aus `token_enc` neu berechnen.
 *
 * Links ohne entschlüsselbares `token_enc` lassen sich nicht mehr auflösen: Sie werden widerrufen (`revoked_at = now()`)
 * und als `unrecoverable` gezählt; `token_hash` bleibt (NOT NULL UNIQUE).
 * Bereits widerrufene Links ohne Quelle werden nicht erneut gezählt. Passwort-Hashes (scrypt mit Salz) und die
 * Zugriffstoken nach dem Entsperren sind nicht betroffen bzw. nicht gespeichert.
 * Idempotent: Zeilen mit bereits korrektem Hash werden nicht geändert.
 */
import { sql } from 'drizzle-orm';
import type { ModuleBackupHooks } from '$lib/sdk/server';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const notesBackup: ModuleBackupHooks = {
	async rehash(tx, helpers) {
		const res = await tx.execute(
			sql`SELECT id, token_hash, token_enc, revoked_at IS NOT NULL AS revoked FROM note_links`
		);
		let updated = 0;
		let unrecoverable = 0;
		for (const r of res.rows as Record<string, unknown>[]) {
			const id = String(r.id);
			const enc = str(r.token_enc);
			let next: string | null = null;
			if (enc) {
				try {
					next = helpers.hash(helpers.decrypt(enc));
				} catch {
					next = null;
				}
			}
			if (next === null) {
				const revoked = r.revoked === true || r.revoked === 't';
				if (!revoked) {
					await tx.execute(sql`UPDATE note_links SET revoked_at = now() WHERE id = ${id}`);
					unrecoverable++;
				}
				continue;
			}
			if (next === str(r.token_hash)) continue;
			await tx.execute(sql`UPDATE note_links SET token_hash = ${next} WHERE id = ${id}`);
			updated++;
		}
		return { updated, unrecoverable };
	}
};
