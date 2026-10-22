import type { Cloud } from "./client.ts";
import { createKeptReplacements, createSecretCapture, type SecretCaptureTarget } from "./connectors.ts";
import { array, boundedInteger, CloudShapeError, oneOf, record, timestamp, uuid } from "./parse.ts";

/* The company's Digital Post as a member reads it (deploy/first-node/RUNTIME-DIGITAL-POST.md; supabase/CLIENT-CONTRACT.md
 * "Digital Post"): the connection's state (`qorpera_member_digital_post`), the letters the folder holds (its index,
 * digital-post/letters.json, which the platform writes), and an owner's or admin's key saved straight into the company
 * vault (the vault's capture, connector `digital_post`, field `api_key`) or the connection revoked.
 *
 * What a letter says came from a public authority: it is only ever set as text. The index is read leniently: a letter
 * that does not read is left out, never the whole list. */

export const DIGITAL_POST_INDEX_PATH = "digital-post/letters.json";
export const DIGITAL_POST_CONNECTOR = "digital_post";
/** The most the index may be: what the platform's writer keeps it under (240 KiB), with room. */
export const DIGITAL_POST_INDEX_MAX_BYTES = 256 * 1024;
/** The longest `letter.md` the Mailbox shows; a longer letter opens from its folder. */
export const DIGITAL_POST_LETTER_MAX_BYTES = 1024 * 1024;

export type DigitalPostStatus = "waiting" | "current" | "failed" | "refused" | "disconnected";
const STATUSES = ["waiting", "current", "failed", "refused", "disconnected"] as const;

/** What the setup steps show: where to set the system up, the supplier to name and the addresses to list. */
export interface DigitalPostSupplier {
	readonly environment: "test" | "production";
	readonly cvr: string;
	readonly addresses: readonly string[];
}

export interface DigitalPostConnection {
	readonly connected: boolean;
	readonly status: DigitalPostStatus;
	/** The connection's secret, while connected: a new key replaces it, Disconnect revokes it. */
	readonly secretId?: string;
	/** Absent until operators set it: Digital Post can't be connected yet. */
	readonly supplier?: DigitalPostSupplier;
	readonly systemId?: string;
	readonly fetchedAt?: string;
	readonly lastError?: string;
	readonly letters: number;
	readonly waitingForFolder: number;
	readonly held: number;
}

/** A letter as the folder's index lists it. */
export interface DigitalPostLetter {
	readonly messageUuid: string;
	/** Its folder in the company folder, `digital-post/<year>/…`. */
	readonly folder: string;
	readonly title: string;
	readonly sender: string;
	readonly senderId: string;
	readonly created: string;
	readonly received: string;
	readonly mandatory: boolean;
	readonly legalNotification: boolean;
	readonly replyBy?: string;
	readonly caseId?: string;
	readonly files: number;
	/** Whether `letter.md` holds the main document's text. */
	readonly text: boolean;
	readonly snippet?: string;
}

const LETTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FOLDER = /^digital-post\/[0-9]{4}\/[^/]+$/;

function absent(value: unknown): boolean {
	return value === undefined || value === null;
}

function text(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function parseSupplier(value: unknown): DigitalPostSupplier | undefined {
	if (absent(value)) return undefined;
	const input = record(value, "Digital Post supplier");
	const cvr = text(input.cvr, 8);
	if (!cvr || !/^[0-9]{8}$/.test(cvr)) throw new CloudShapeError("Digital Post supplier");
	return {
		environment: oneOf(input.environment, ["test", "production"] as const, "Digital Post environment"),
		cvr,
		addresses: array(input.addresses, "Digital Post addresses").map((address) => {
			const shown = text(address, 64);
			if (!shown) throw new CloudShapeError("Digital Post address");
			return shown;
		}),
	};
}

/** The connection's state; on a cloud without the call, nothing is connected. */
export async function readDigitalPost(cloud: Cloud, environmentId: string): Promise<DigitalPostConnection> {
	const input = record(
		await cloud.rpc("qorpera_member_digital_post", { p_environment_id: environmentId }),
		"Digital Post",
	);
	if (input.schema !== "qorpera.member-digital-post/v1") throw new CloudShapeError("Digital Post");
	const supplier = parseSupplier(input.supplier);
	const lastError = text(input.lastError, 300);
	return {
		connected: input.connected === true,
		status: oneOf(input.status, STATUSES, "Digital Post status"),
		...(absent(input.secretId) ? {} : { secretId: uuid(input.secretId, "Digital Post connection") }),
		...(supplier ? { supplier } : {}),
		...(absent(input.systemId) ? {} : { systemId: uuid(input.systemId, "Digital Post system") }),
		...(absent(input.fetchedAt) ? {} : { fetchedAt: timestamp(input.fetchedAt, "Digital Post fetch time") }),
		...(lastError ? { lastError } : {}),
		letters: boundedInteger(input.letters, "Digital Post letters", 0, Number.MAX_SAFE_INTEGER),
		waitingForFolder: boundedInteger(input.waitingForFolder, "Digital Post letters", 0, Number.MAX_SAFE_INTEGER),
		held: boundedInteger(input.held, "Digital Post held letters", 0, Number.MAX_SAFE_INTEGER),
	};
}

function parseLetter(value: unknown): DigitalPostLetter | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const messageUuid = typeof input.messageUuid === "string" ? input.messageUuid : "";
	const folder = typeof input.folder === "string" ? input.folder : "";
	const title = text(input.title, 2000);
	const sender = text(input.sender, 2000);
	const received = typeof input.received === "string" ? input.received : "";
	if (
		!LETTER_ID.test(messageUuid) ||
		!FOLDER.test(folder) ||
		!title ||
		!sender ||
		Number.isNaN(Date.parse(received)) ||
		typeof input.mandatory !== "boolean" ||
		typeof input.legalNotification !== "boolean"
	)
		return null;
	const replyBy = text(input.replyBy, 2000);
	const caseId = text(input.caseId, 2000);
	const snippet = text(input.snippet, 1000);
	return {
		messageUuid,
		folder,
		title,
		sender,
		senderId: text(input.senderId, 2000) ?? "",
		created: text(input.created, 2000) ?? received,
		received,
		mandatory: input.mandatory,
		legalNotification: input.legalNotification,
		...(replyBy ? { replyBy } : {}),
		...(caseId ? { caseId } : {}),
		files: typeof input.files === "number" && Number.isSafeInteger(input.files) ? input.files : 0,
		text: input.text === true,
		...(snippet ? { snippet } : {}),
	};
}

/** The letters of the folder's index, newest first; an index that is not one lists none. */
export function parseDigitalPostLetters(textOfIndex: string): DigitalPostLetter[] {
	let input: unknown;
	try {
		input = JSON.parse(textOfIndex);
	} catch {
		return [];
	}
	const index = input as { schema?: unknown; letters?: unknown } | null;
	if (index?.schema !== "qorpera.digital-post-letters/v1" || !Array.isArray(index.letters)) return [];
	const seen = new Set<string>();
	return index.letters
		.map(parseLetter)
		.filter(
			(letter): letter is DigitalPostLetter =>
				letter !== null && !seen.has(letter.messageUuid) && !!seen.add(letter.messageUuid),
		)
		.sort((a, b) => Date.parse(b.received) - Date.parse(a.received));
}

/** A letter's `letter.md` as the Mailbox shows it: its text, and its documents by name. */
export interface DigitalPostLetterText {
	readonly text: string;
	readonly documents: readonly string[];
}

/** The `## Text` section and the `## Documents` names of a letter's `letter.md` (digital-post-letter-files.ts). The
 * text is the file's last section and may hold any line, a heading too: it runs from the first `## Text` to the end.
 * Every line before it is the platform's own, one line per item. */
export function parseDigitalPostLetterText(markdown: string): DigitalPostLetterText {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const textAt = lines.indexOf("## Text");
	const head = textAt < 0 ? lines : lines.slice(0, textAt);
	const documentsAt = head.indexOf("## Documents");
	const documents: string[] = [];
	for (const line of documentsAt < 0 ? [] : head.slice(documentsAt + 1)) {
		if (line.startsWith("## ")) break;
		const link = /^- \[.*\]\(<([^>]*)>\)/.exec(line);
		if (!link) continue;
		let name: string;
		try {
			name = decodeURIComponent(link[1] ?? "");
		} catch {
			continue;
		}
		// A document is a file of the letter's own folder.
		if (name && !name.includes("/") && name !== "." && name !== "..") documents.push(name);
	}
	return {
		text:
			textAt < 0
				? ""
				: lines
						.slice(textAt + 1)
						.join("\n")
						.trim(),
		documents,
	};
}

/**
 * Whether a pasted key reads as one Administrativ Adgang shows: the Basic credential of the system's id and its key,
 * base64. The vault checks it again before it seals it; this only spares a member a round trip with a typo.
 */
export function digitalPostKeyLooksValid(pasted: string): boolean {
	const compact = pasted.replace(/^\s*Basic\s+/i, "").replace(/\s+/g, "");
	if (
		compact.length < 8 ||
		compact.length > 1024 ||
		compact.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
	)
		return false;
	let decoded: string;
	try {
		decoded = atob(compact);
	} catch {
		return false;
	}
	const colon = decoded.indexOf(":");
	return (
		colon > 0 &&
		LETTER_ID.test(decoded.slice(0, colon).toLowerCase()) &&
		/^[\x21-\x7e]{8,512}$/.test(decoded.slice(colon + 1))
	);
}

/** Administrativ Adgang, where a member with Digital Post's system administrator right sets the system up. */
export function digitalPostAdminUrl(environment: DigitalPostSupplier["environment"]): string {
	return environment === "test" ? "https://admin.test.digitalpost.dk/login" : "https://admin.digitalpost.dk/login";
}

/** An owner's or admin's calls: the key into the company vault (replacing `existingSecretId`'s), and Disconnect. */
export interface DigitalPostKeys {
	save(apiKey: string, existingSecretId: string | undefined, signal?: AbortSignal): Promise<void>;
	disconnect(secretId: string, signal?: AbortSignal): Promise<void>;
}

export function createDigitalPostKeys(
	cloud: Cloud,
	profile: { profileId: string; environmentId: string },
	fetchImplementation: typeof fetch = fetch,
): DigitalPostKeys {
	const capture = createSecretCapture(cloud, profile, fetchImplementation);
	// A new key whose send failed keeps its ticket for the next try (connectors.ts): SQL allows one open replacement.
	const replace = createKeptReplacements(capture);
	return {
		async save(apiKey, existingSecretId, signal) {
			signal?.throwIfAborted();
			const target: SecretCaptureTarget = {
				ownerKind: "company",
				ownerUserId: null,
				connectorId: DIGITAL_POST_CONNECTOR,
				secretName: "primary",
				purpose: "Digital Post",
				existingSecretId,
			};
			const fields = { api_key: apiKey.trim() };
			// A first connection asks for a fresh ticket each try: one an earlier try saved is refused at the start
			// (23505), and Settings reads the connection again either way.
			if (existingSecretId === undefined) await capture.send(await capture.ticket(target), fields, signal);
			else await replace(existingSecretId, target, fields, signal);
		},
		async disconnect(secretId, signal) {
			signal?.throwIfAborted();
			await cloud.rpc("qorpera_revoke_cloud_secret", { p_profile_id: profile.profileId, p_secret_id: secretId });
		},
	};
}
