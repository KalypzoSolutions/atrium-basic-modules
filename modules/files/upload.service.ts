/**
 * Gemeinsamer Upload-Ablauf für den internen Upload (`upload.endpoints.ts`) und den öffentlichen Upload-Link
 * (`links.service.ts`), damit beide dieselben Prüfungen durchlaufen.
 * VERTRAG (Umbau 0003) – Implementierung: Welle A2. Signaturen nicht ändern.
 *
 * Ablauf (aus dem bisherigen `upload.endpoints.ts` übernommen):
 *   Tx 1: `recheck(tx)` (Zugriff), optional `ensureFolderPath(relativeFolders)`, Zielname (`normalizeName` + `nodeName`),
 *         Konflikt `rename` → `uniqueName`, `replace` → vorhandene Datei ersetzen (Ordner → 409), `assertQuota` (Eigentümer*in),
 *         Node-ID reservieren.
 *   Storage: `storeContent` (außerhalb jeder Transaktion).
 *   Tx 2: `recheck(tx)` erneut, Ersetzen nur, wenn die Datei noch am selben Ort liegt (`FOR UPDATE`), sonst neu anlegen;
 *         `assertQuota` mit echter Größe; Insert/Update inkl. `uploaded_by_name`/`uploaded_via_link`; Unique-Verletzung →
 *         einmal neu mit `uniqueName` in neuer Transaktion. Fehler → hochgeladene Objekte per `removeObjects` entfernen.
 *   Danach: alte Objekte beim Ersetzen entfernen.
 * Kein Audit hier – das macht der Aufrufer (intern `files.node.uploaded`, öffentlich `files.link.uploaded`).
 * Alle Knoten haben `space = 'personal'` (eine Ansicht); `ownerId` = Eigentümer*in des Zielordners bzw. der Wurzel.
 */
import { sql } from 'drizzle-orm';
import { errors, isUniqueViolation, rowsOf, type Tx } from '$lib/sdk/server';
import { mdb } from './db';
import { normalizeName, uniqueName } from './names';
import { ensureFolderPath, siblingNames } from './nodes.service';
import { assertQuota, removeObjects, storeContent, type StoredContent } from './storage';
import { INVISIBLE_CHARS, MAX_UPLOADER_NAME, nodeName } from './schemas';

export interface StoreIntoFolderInput {
	/** Zielordner (`null` = Wurzel von `ownerId`), Zugriff vom Aufrufer bereits geprüft */
	parentId: string | null;
	/** Eigentümer*in neuer Knoten (= Eigentümer*in des Zielordners bzw. der Wurzel) */
	ownerId: string;
	bytes: Uint8Array;
	/** Dateiname (wird normalisiert und geprüft, 422 bei ungültigem Namen) */
	name: string;
	/** Browser-Typ (oder `null`) */
	contentType: string | null;
	/** Unterordner relativ zum Zielordner (Ordner-Upload), werden angelegt/wiederverwendet */
	relativeFolders?: readonly string[];
	conflict: 'rename' | 'replace';
	/** Benutzer-ID der hochladenden Person; `null` bei öffentlichem Upload */
	createdBy: string | null;
	/** Öffentlicher Upload: angegebener Name (bereinigt) und Link-ID */
	uploadedByName?: string | null;
	viaLinkId?: string | null;
	/** Kontingent der Eigentümer*in (`filesSettings().quotaBytes`, VOR der Transaktion gelesen) */
	quotaBytes: number | null;
	/** Zugriffsprüfung, läuft in Tx 1 und Tx 2 (wirft 403/404, wenn der Ordner weg/gesperrt ist) */
	recheck: (tx: Tx) => Promise<void>;
}

export interface StoredNode {
	nodeId: string;
	name: string;
	sizeBytes: number;
	contentType: string;
	/** Vorhandene Datei ersetzt */
	replaced: boolean;
}

/** Unsichtbare Zeichen (global) und Steuerzeichen zum Entfernen aus dem Namen der hochladenden Person */
const INVISIBLE_ALL_RE = new RegExp(INVISIBLE_CHARS.source, 'gu');
// eslint-disable-next-line no-control-regex
const CONTROL_ALL_RE = /[\u0000-\u001f\u007f]/gu;

/**
 * Namen der hochladenden Person bereinigen: NFC, unsichtbare Zeichen und Steuerzeichen entfernen,
 * Leerraum zusammenfassen, trimmen, auf `MAX_UPLOADER_NAME` Zeichen (Codepoints) kürzen; leer → `null`.
 */
export function cleanUploaderName(name: string | null | undefined): string | null {
	if (typeof name !== 'string') return null;
	const clean = name
		.normalize('NFC')
		.replace(INVISIBLE_ALL_RE, '')
		.replace(CONTROL_ALL_RE, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
	const cut = Array.from(clean).slice(0, MAX_UPLOADER_NAME).join('').trim();
	return cut || null;
}

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Ergebnis von Tx 1: alles, was Tx 2 zum Anlegen/Ersetzen braucht */
interface UploadPlan {
	ownerId: string;
	parentId: string | null;
	name: string;
	/** Bei `conflict = replace`: vorhandene Datei, die ersetzt wird */
	replaceId: string | null;
	nodeId: string;
}

/** Bedingung „liegt direkt im Ordner“ (Wurzel = `parent_id IS NULL` der Eigentümer*in) */
function placeCondition(where: { ownerId: string; parentId: string | null }) {
	return where.parentId
		? sql`n.parent_id = ${where.parentId}`
		: sql`n.parent_id IS NULL AND n.owner_id = ${where.ownerId}`;
}

/** Nicht gelöschte Datei/Ordner mit gleichem Namen (ohne Groß/Klein) im Zielordner */
async function sameNamed(
	tx: Tx,
	where: { ownerId: string; parentId: string | null },
	name: string
): Promise<{ id: string; kind: string; sizeBytes: number } | null> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT n.id, n.kind, n.size_bytes FROM nodes n
			WHERE ${placeCondition(where)} AND n.deleted_at IS NULL AND lower(n.name) = lower(${name})
			LIMIT 1`
	);
	if (!row) return null;
	return { id: String(row.id), kind: String(row.kind), sizeBytes: Number(row.size_bytes ?? 0) };
}

/** Dateiname normalisieren und prüfen (422, Pfad `file`) */
function checkedName(raw: string): string {
	const checked = nodeName.safeParse(normalizeName(raw));
	if (!checked.success) {
		const message = checked.error.issues[0]?.message ?? 'Ungültiger Dateiname';
		throw errors.validation([{ path: ['file'], message }], message);
	}
	return checked.data;
}

export async function storeIntoFolder(input: StoreIntoFolderInput): Promise<StoredNode> {
	const wantedName = checkedName(input.name);
	const uploadedByName = cleanUploaderName(input.uploadedByName);
	const viaLinkId = input.viaLinkId ?? null;
	const size = input.bytes.byteLength;

	// Tx 1: Zugriff, Ordnerpfad, Name/Konflikt, Kontingent (Vorprüfung; Tx 2 prüft mit der echten Größe erneut).
	const plan: UploadPlan = await mdb().transaction(async (tx) => {
		await input.recheck(tx);
		const parentId = await ensureFolderPath(tx, {
			ownerId: input.ownerId,
			parentId: input.parentId,
			folders: input.relativeFolders ?? [],
			createdBy: input.createdBy
		});
		const where = { ownerId: input.ownerId, parentId };
		let name = wantedName;
		let replaceId: string | null = null;
		let replacedSize = 0;
		const existing = await sameNamed(tx, where, name);
		if (existing) {
			if (input.conflict === 'replace') {
				if (existing.kind !== 'file') {
					throw errors.conflict(`Es gibt hier schon einen Ordner „${name}“`);
				}
				replaceId = existing.id;
				replacedSize = existing.sizeBytes;
			} else {
				name = uniqueName(await siblingNames(tx, where), name);
			}
		}
		await assertQuota(tx, input.ownerId, size - replacedSize, input.quotaBytes);
		return {
			ownerId: input.ownerId,
			parentId,
			name,
			replaceId,
			nodeId: replaceId ?? crypto.randomUUID()
		};
	});

	// Storage außerhalb der Transaktion
	const stored: StoredContent = await storeContent({
		nodeId: plan.nodeId,
		bytes: input.bytes,
		name: plan.name,
		contentType: input.contentType
	});

	// Tx 2: anlegen bzw. ersetzen; bei Namenskonflikt durch parallelen Upload einmal neu versuchen.
	// Fehler hier (auch Kontingent) → hochgeladene Objekte werden unten wieder entfernt.
	const commit = () =>
		mdb().transaction(async (tx) => {
			// Zielordner kann inzwischen gelöscht/verschoben oder der Zugriff entzogen sein
			await input.recheck(tx);
			// Nur ersetzen, wenn die Datei noch genau an diesem Ort und bei derselben Eigentümer*in liegt
			// (nicht verschoben/gelöscht); sonst als neue Datei anlegen.
			let old: Record<string, unknown> | undefined;
			if (plan.replaceId) {
				[old] = await rowsOf(
					tx,
					sql`SELECT name, storage_path, thumb_path, size_bytes FROM nodes
						WHERE id = ${plan.replaceId} AND kind = 'file' AND deleted_at IS NULL
							AND parent_id IS NOT DISTINCT FROM ${plan.parentId}
							AND owner_id = ${plan.ownerId}
						FOR UPDATE`
				);
			}
			const replacedSize = old ? Number(old.size_bytes ?? 0) : 0;
			await assertQuota(tx, plan.ownerId, stored.sizeBytes - replacedSize, input.quotaBytes);
			if (plan.replaceId && old) {
				await tx.execute(
					sql`UPDATE nodes SET storage_path = ${stored.storagePath},
						thumb_path = ${stored.thumbPath}, thumb_attempted_at = now(), content_type = ${stored.contentType},
						size_bytes = ${stored.sizeBytes}, uploaded_by_name = ${uploadedByName},
						uploaded_via_link = ${viaLinkId}, updated_at = now()
						WHERE id = ${plan.replaceId}`
				);
				return {
					id: plan.replaceId,
					name: String(old.name),
					replaced: true,
					old: [
						old.storage_path == null ? null : String(old.storage_path),
						old.thumb_path == null ? null : String(old.thumb_path)
					]
				};
			}
			// ersetzte Datei ist inzwischen weg (gelöscht/im Papierkorb/verschoben) → als neue Datei mit neuer ID
			const insertId = plan.replaceId ? crypto.randomUUID() : plan.nodeId;
			let name = plan.name;
			const names = await siblingNames(tx, { ownerId: plan.ownerId, parentId: plan.parentId });
			if (names.some((n) => sameKey(n, name))) name = uniqueName(names, name);
			await tx.execute(
				sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, storage_path,
						thumb_path, thumb_attempted_at, content_type, size_bytes, created_by, uploaded_by_name,
						uploaded_via_link)
					VALUES (${insertId}, ${plan.parentId}, 'file', 'personal', ${plan.ownerId},
						${name}, ${stored.storagePath}, ${stored.thumbPath}, now(), ${stored.contentType},
						${stored.sizeBytes}, ${input.createdBy}, ${uploadedByName}, ${viaLinkId})`
			);
			return { id: insertId, name, replaced: false, old: [] as (string | null)[] };
		});

	let result: Awaited<ReturnType<typeof commit>>;
	try {
		result = await commit().catch((e: unknown) => {
			// eigene, neue Transaktion: die fehlgeschlagene ist nach der Unique-Verletzung abgebrochen
			if (isUniqueViolation(e)) return commit();
			throw e;
		});
	} catch (e) {
		await removeObjects([stored.storagePath, stored.thumbPath]);
		throw e;
	}

	// alte Objekte erst nach erfolgreichem Ersetzen entfernen
	if (result.replaced) await removeObjects(result.old);

	return {
		nodeId: result.id,
		name: result.name,
		sizeBytes: stored.sizeBytes,
		contentType: stored.contentType,
		replaced: result.replaced
	};
}
