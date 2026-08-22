import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA = "qorpera.cloud-prompt-outbox/v3";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CloudPromptOutboxImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface CloudPromptOutboxEnvelope {
	message: string;
	displayText?: string;
	images?: CloudPromptOutboxImage[];
	executionSponsor?: {
		sponsorBindingId: string;
		sponsorVersion: number;
		computeIdentityId: string;
		workerClass: "managed_sandbox" | "company_computer";
	};
}

export interface CloudPromptOutboxRecord {
	schema: typeof SCHEMA;
	id: string;
	profileId: string;
	staffAgentId: string;
	sessionId: string;
	digest: string;
	status: "pending" | "accepted";
	envelope: CloudPromptOutboxEnvelope;
	createdAt: string;
}

function requiredUuid(value: string, label: string): string {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value.toLowerCase();
}

function outboxPath(userData: string, profileId: string, staffAgentId: string): string {
	return join(
		userData,
		"cloud-prompt-outbox",
		requiredUuid(profileId, "Prompt outbox profile"),
		`${requiredUuid(staffAgentId, "Prompt outbox staff member")}.json`,
	);
}

function envelopeDigest(envelope: CloudPromptOutboxEnvelope): string {
	return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

function parseRecord(value: unknown, expected: { profileId: string; staffAgentId: string }): CloudPromptOutboxRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Prompt outbox record is invalid");
	const record = value as Partial<CloudPromptOutboxRecord>;
	const envelope = record.envelope;
	const executionSponsor = envelope?.executionSponsor;
	if (
		record.schema !== SCHEMA ||
		!record.id ||
		!UUID_PATTERN.test(record.id) ||
		record.profileId !== expected.profileId.toLowerCase() ||
		record.staffAgentId !== expected.staffAgentId.toLowerCase() ||
		!record.sessionId ||
		!UUID_PATTERN.test(record.sessionId) ||
		!record.digest ||
		!SHA256_PATTERN.test(record.digest) ||
		(record.status !== "pending" && record.status !== "accepted") ||
		!record.createdAt ||
		!envelope ||
		typeof envelope.message !== "string" ||
		(envelope.displayText !== undefined && typeof envelope.displayText !== "string") ||
		(envelope.images !== undefined &&
			(!Array.isArray(envelope.images) ||
				envelope.images.some(
					(image) =>
						!image ||
						image.type !== "image" ||
						typeof image.data !== "string" ||
						typeof image.mimeType !== "string",
				))) ||
		(executionSponsor !== undefined &&
			(!UUID_PATTERN.test(executionSponsor.sponsorBindingId) ||
				!Number.isSafeInteger(executionSponsor.sponsorVersion) ||
				executionSponsor.sponsorVersion < 1 ||
				!UUID_PATTERN.test(executionSponsor.computeIdentityId) ||
				(executionSponsor.workerClass !== "managed_sandbox" &&
					executionSponsor.workerClass !== "company_computer"))) ||
		envelopeDigest(envelope) !== record.digest
	) {
		throw new Error("Prompt outbox record is invalid");
	}
	return record as CloudPromptOutboxRecord;
}

async function readRecord(
	userData: string,
	profileId: string,
	staffAgentId: string,
): Promise<CloudPromptOutboxRecord | undefined> {
	const path = outboxPath(userData, profileId, staffAgentId);
	let serialized: string;
	try {
		serialized = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return parseRecord(JSON.parse(serialized) as unknown, { profileId, staffAgentId });
}

async function writeRecord(userData: string, record: CloudPromptOutboxRecord): Promise<void> {
	const path = outboxPath(userData, record.profileId, record.staffAgentId);
	await mkdir(join(userData, "cloud-prompt-outbox", record.profileId), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf-8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export async function stageCloudPromptOutbox(options: {
	userData: string;
	profileId: string;
	staffAgentId: string;
	sessionId: string;
	id: string;
	envelope: CloudPromptOutboxEnvelope;
}): Promise<CloudPromptOutboxRecord> {
	const digest = envelopeDigest(options.envelope);
	const requestedId = requiredUuid(options.id, "Prompt outbox message");
	const requestedSessionId = requiredUuid(options.sessionId, "Prompt outbox session");
	const existing = await readRecord(options.userData, options.profileId, options.staffAgentId);
	if (existing?.status === "pending") {
		if (existing.id !== requestedId || existing.digest !== digest) {
			throw new Error("A previous message is still waiting for cloud acknowledgement");
		}
		if (existing.sessionId === requestedSessionId) return existing;
		const rebound = { ...existing, sessionId: requestedSessionId };
		await writeRecord(options.userData, rebound);
		return rebound;
	}
	const record: CloudPromptOutboxRecord = {
		schema: SCHEMA,
		id: requestedId,
		profileId: requiredUuid(options.profileId, "Prompt outbox profile"),
		staffAgentId: requiredUuid(options.staffAgentId, "Prompt outbox staff member"),
		sessionId: requestedSessionId,
		digest,
		status: "pending",
		envelope: options.envelope,
		createdAt: new Date().toISOString(),
	};
	await writeRecord(options.userData, record);
	return record;
}

export async function pendingCloudPromptOutbox(options: {
	userData: string;
	profileId: string;
	staffAgentId: string;
}): Promise<CloudPromptOutboxRecord | undefined> {
	const record = await readRecord(options.userData, options.profileId, options.staffAgentId);
	return record?.status === "pending" ? record : undefined;
}

export async function acknowledgeCloudPromptOutbox(options: {
	userData: string;
	profileId: string;
	staffAgentId: string;
	sessionId: string;
	id: string;
}): Promise<boolean> {
	const existing = await readRecord(options.userData, options.profileId, options.staffAgentId);
	if (!existing) return true;
	if (existing.id !== requiredUuid(options.id, "Prompt outbox message")) return false;
	if (existing.sessionId !== requiredUuid(options.sessionId, "Prompt outbox session")) return false;
	if (existing.status === "accepted") return true;
	await writeRecord(options.userData, { ...existing, status: "accepted" });
	return true;
}
