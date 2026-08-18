/**
 * Durable agent-to-agent messages.
 *
 * The ledger lives in host-protected company state (`.qorpera/`), so agents
 * cannot forge or tamper with each other's mail: a message enters the ledger
 * only through the host-brokered `send_agent_message` company operation, and
 * the host delivers it into the recipient's next session context. Delivery is
 * store-and-forward because a company runs at most one agent process at a
 * time — the recipient is woken by the host scheduler rather than addressed
 * live.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type StaffAgentMessageStatus = "queued" | "delivered";

export interface StaffAgentMessage {
	id: string;
	fromAgentId: string;
	toAgentId: string;
	subject?: string;
	body: string;
	createdAt: string;
	status: StaffAgentMessageStatus;
	deliveredAt?: string;
}

export interface QueueStaffAgentMessageInput {
	fromAgentId: string;
	toAgentId: string;
	subject?: string;
	body: string;
}

interface MessageLedger {
	version: 1;
	messages: StaffAgentMessage[];
}

const LEDGER_RELATIVE_PATH = join(".qorpera", "agent-messages.json");
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_MESSAGES = 2_000;
const MAX_QUEUED_PER_RECIPIENT = 64;
export const MAX_AGENT_MESSAGE_BODY_BYTES = 16 * 1024;
export const MAX_AGENT_MESSAGE_SUBJECT_BYTES = 160;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGE_FIELDS = new Set([
	"id",
	"fromAgentId",
	"toAgentId",
	"subject",
	"body",
	"createdAt",
	"status",
	"deliveredAt",
]);
const LEDGER_FIELDS = new Set(["version", "messages"]);

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalRoot(root: string): string {
	const canonical = realpathSync(resolve(root));
	const entry = lstatSync(canonical);
	if (!entry.isDirectory() || entry.isSymbolicLink())
		throw new Error("Agent message ledger requires a physical company root");
	return canonical;
}

export function staffAgentMessagesPath(root: string): string {
	return join(canonicalRoot(root), LEDGER_RELATIVE_PATH);
}

function physicalLedgerPath(root: string, create: boolean): { directory: string; path: string | undefined } {
	const canonical = canonicalRoot(root);
	const directory = join(canonical, ".qorpera");
	if (!existsSync(directory)) {
		if (!create) return { directory, path: undefined };
		mkdirSync(directory);
	}
	const directoryEntry = lstatSync(directory);
	if (
		!directoryEntry.isDirectory() ||
		directoryEntry.isSymbolicLink() ||
		normalizedPath(realpathSync(directory)) !== normalizedPath(directory)
	) {
		throw new Error("Agent message ledger directory must be one physical directory");
	}
	const path = join(directory, "agent-messages.json");
	if (!existsSync(path)) return { directory, path: undefined };
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("Agent message ledger must be one physical file");
	}
	if (entry.size > MAX_LEDGER_BYTES) throw new Error("Agent message ledger exceeds its size limit");
	return { directory, path };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function exactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(record).every((key) => allowed.has(key));
}

function boundedText(value: unknown, field: string, maxBytes: number, multiline: boolean): string {
	if (typeof value !== "string" || value !== value.trim() || !value || value.includes("\0")) {
		throw new Error(`Agent message ${field} is invalid`);
	}
	if (!multiline && /[\r\n]/.test(value)) throw new Error(`Agent message ${field} is invalid`);
	if (Buffer.byteLength(value, "utf-8") > maxBytes) throw new Error(`Agent message ${field} is invalid`);
	return value;
}

function agentIdValue(value: unknown, field: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`Agent message ${field} is invalid`);
	return value;
}

function timestampValue(value: unknown, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error(`Agent message ${field} is invalid`);
	}
	return value;
}

function messageValue(value: unknown): StaffAgentMessage {
	const record = recordValue(value);
	if (!record || !exactFields(record, MESSAGE_FIELDS)) throw new Error("Agent message record is invalid");
	if (record.status !== "queued" && record.status !== "delivered") {
		throw new Error("Agent message status is invalid");
	}
	const subject =
		record.subject === undefined
			? undefined
			: boundedText(record.subject, "subject", MAX_AGENT_MESSAGE_SUBJECT_BYTES, false);
	const deliveredAt = record.deliveredAt === undefined ? undefined : timestampValue(record.deliveredAt, "deliveredAt");
	if (record.status === "delivered" && deliveredAt === undefined) {
		throw new Error("Agent message delivery timestamp is missing");
	}
	return {
		id: agentIdValue(record.id, "id"),
		fromAgentId: agentIdValue(record.fromAgentId, "fromAgentId"),
		toAgentId: agentIdValue(record.toAgentId, "toAgentId"),
		...(subject ? { subject } : {}),
		body: boundedText(record.body, "body", MAX_AGENT_MESSAGE_BODY_BYTES, true),
		createdAt: timestampValue(record.createdAt, "createdAt"),
		status: record.status,
		...(deliveredAt ? { deliveredAt } : {}),
	};
}

function emptyLedger(): MessageLedger {
	return { version: 1, messages: [] };
}

function readLedger(root: string): MessageLedger {
	const { path } = physicalLedgerPath(root, false);
	if (!path) return emptyLedger();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		throw new Error("Agent message ledger is invalid");
	}
	const record = recordValue(parsed);
	if (!record || !exactFields(record, LEDGER_FIELDS) || record.version !== 1 || !Array.isArray(record.messages)) {
		throw new Error("Agent message ledger is invalid");
	}
	if (record.messages.length > MAX_LEDGER_MESSAGES) throw new Error("Agent message ledger is invalid");
	return { version: 1, messages: record.messages.map(messageValue) };
}

function writeLedger(root: string, ledger: MessageLedger): void {
	const { directory } = physicalLedgerPath(root, true);
	const path = join(directory, "agent-messages.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(ledger, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function readStaffAgentMessages(root: string): StaffAgentMessage[] {
	return readLedger(root).messages.map((message) => ({ ...message }));
}

export function pendingStaffAgentMessages(root: string, toAgentId: string): StaffAgentMessage[] {
	return readLedger(root)
		.messages.filter((message) => message.status === "queued" && message.toAgentId === toAgentId)
		.map((message) => ({ ...message }));
}

/** Recently delivered mail stays visible so a context rebuild between
 * delivery and the next founder turn cannot silently drop a message. */
export function recentDeliveredStaffAgentMessages(root: string, toAgentId: string, limit: number): StaffAgentMessage[] {
	return readLedger(root)
		.messages.filter((message) => message.status === "delivered" && message.toAgentId === toAgentId)
		.slice(-Math.max(0, limit))
		.map((message) => ({ ...message }));
}

export function queueStaffAgentMessage(root: string, input: QueueStaffAgentMessageInput): StaffAgentMessage {
	const record = input as unknown as Record<string, unknown>;
	if (!exactFields(record, new Set(["fromAgentId", "toAgentId", "subject", "body"]))) {
		throw new Error("Agent message input is invalid");
	}
	const fromAgentId = agentIdValue(record.fromAgentId, "fromAgentId");
	const toAgentId = agentIdValue(record.toAgentId, "toAgentId");
	if (fromAgentId === toAgentId) throw new Error("Agent message cannot target its own sender");
	const subject =
		record.subject === undefined
			? undefined
			: boundedText(record.subject, "subject", MAX_AGENT_MESSAGE_SUBJECT_BYTES, false);
	const body = boundedText(record.body, "body", MAX_AGENT_MESSAGE_BODY_BYTES, true);
	const ledger = readLedger(root);
	const queuedForRecipient = ledger.messages.filter(
		(message) => message.status === "queued" && message.toAgentId === toAgentId,
	).length;
	if (queuedForRecipient >= MAX_QUEUED_PER_RECIPIENT) {
		throw new Error("Recipient already has too many undelivered messages");
	}
	const message: StaffAgentMessage = {
		id: randomUUID(),
		fromAgentId,
		toAgentId,
		...(subject ? { subject } : {}),
		body,
		createdAt: new Date().toISOString(),
		status: "queued",
	};
	ledger.messages.push(message);
	// Cap the ledger by retiring the oldest delivered mail first; queued
	// messages are never dropped silently.
	while (ledger.messages.length > MAX_LEDGER_MESSAGES) {
		const index = ledger.messages.findIndex((candidate) => candidate.status === "delivered");
		if (index === -1) throw new Error("Agent message ledger is full of undelivered messages");
		ledger.messages.splice(index, 1);
	}
	writeLedger(root, ledger);
	return { ...message };
}

export function markStaffAgentMessagesDelivered(root: string, ids: readonly string[]): void {
	if (ids.length === 0) return;
	const wanted = new Set(ids);
	const ledger = readLedger(root);
	const deliveredAt = new Date().toISOString();
	let changed = false;
	for (const message of ledger.messages) {
		if (!wanted.has(message.id) || message.status !== "queued") continue;
		message.status = "delivered";
		message.deliveredAt = deliveredAt;
		changed = true;
	}
	if (changed) writeLedger(root, ledger);
}
