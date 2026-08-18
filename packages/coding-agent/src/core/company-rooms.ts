import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export type CompanyRoomStatus = "active" | "archived";

export interface CompanyRoom {
	id: string;
	participantIds: string[];
	historicalParticipantIds: string[];
	title?: string;
	status: CompanyRoomStatus;
	createdAt: string;
	updatedAt: string;
}

export interface CompanyRoomImage {
	mimeType: string;
	data: string;
}

export type CompanyRoomSpeaker = { kind: "founder" } | { kind: "staff"; staffAgentId: string };

export interface CompanyRoomMessage {
	id: string;
	roomId: string;
	sequence: number;
	speaker: CompanyRoomSpeaker;
	text: string;
	images?: CompanyRoomImage[];
	targetStaffAgentIds?: string[];
	sourceTrailFile?: string;
	createdAt: string;
	previousHash: string | null;
	hash: string;
}

/** Bounded delegation-graph position carried by a queued delegation so the
 * depth and cycle limits survive restarts instead of resetting to a fresh
 * root context. */
export interface CompanyRoomDeliveryDelegation {
	depth: number;
	ancestorStaffAgentIds: string[];
}

export interface QueuedCompanyRoomDelivery {
	id: string;
	roomId: string;
	messageId: string;
	targetStaffAgentIds: string[];
	attempts: number;
	nextAttemptAt: string;
	lastError?: string;
	delegation?: CompanyRoomDeliveryDelegation;
	createdAt: string;
	updatedAt: string;
}

export interface CreateCompanyRoomInput {
	participantIds: string[];
	title?: string;
}

export interface UpdateCompanyRoomInput {
	participantIds?: string[];
	title?: string | null;
}

export interface AppendCompanyRoomMessageInput {
	speaker: CompanyRoomSpeaker;
	text?: string;
	images?: CompanyRoomImage[];
	targetStaffAgentIds?: string[];
	sourceTrailFile?: string;
}

export interface QueueCompanyRoomDeliveryInput {
	messageId: string;
	targetStaffAgentIds: string[];
	delegation?: CompanyRoomDeliveryDelegation;
}

interface CompanyRoomRegistry {
	version: 1;
	rooms: Record<string, CompanyRoom>;
}

interface CompanyRoomDeliveryRegistry {
	version: 1;
	deliveries: Record<string, QueuedCompanyRoomDelivery>;
}

const ROOM_REGISTRY_RELATIVE_PATH = join(".qorpera", "rooms.json");
const ROOM_DELIVERY_REGISTRY_RELATIVE_PATH = join(".qorpera", "room-deliveries.json");
const ROOM_TRANSCRIPT_DIRECTORY = join(".qorpera", "rooms");
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_DELIVERY_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_ROOMS = 10_000;
const MAX_QUEUED_DELIVERIES = 10_000;
const MAX_PARTICIPANTS = 128;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOM_FIELDS = new Set([
	"id",
	"participantIds",
	"historicalParticipantIds",
	"title",
	"status",
	"createdAt",
	"updatedAt",
]);
const REGISTRY_FIELDS = new Set(["version", "rooms"]);
const DELIVERY_FIELDS = new Set([
	"id",
	"roomId",
	"messageId",
	"targetStaffAgentIds",
	"attempts",
	"nextAttemptAt",
	"lastError",
	"delegation",
	"createdAt",
	"updatedAt",
]);
const DELIVERY_REGISTRY_FIELDS = new Set(["version", "deliveries"]);

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalRoot(root: string): string {
	const canonical = realpathSync(resolve(root));
	const entry = lstatSync(canonical);
	if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Room storage requires a physical company root");
	return canonical;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function exactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(record).every((key) => allowed.has(key));
}

function boundedText(value: unknown, field: string, maximumBytes: number, optional = false): string | undefined {
	if (value === undefined && optional) return undefined;
	if (typeof value !== "string" || value !== value.trim() || !value || value.includes("\0")) {
		throw new Error(`Company room ${field} is invalid`);
	}
	if (Buffer.byteLength(value, "utf-8") > maximumBytes) throw new Error(`Company room ${field} is invalid`);
	return value;
}

function timestampValue(value: unknown, field: "nextAttemptAt" | "createdAt" | "updatedAt", subject = "room"): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error(`Company ${subject} ${field} is invalid`);
	}
	return value;
}

function delegationValue(value: unknown): CompanyRoomDeliveryDelegation | undefined {
	if (value === undefined) return undefined;
	const record = recordValue(value);
	if (
		!record ||
		!exactFields(record, new Set(["depth", "ancestorStaffAgentIds"])) ||
		typeof record.depth !== "number" ||
		!Number.isInteger(record.depth) ||
		record.depth < 0 ||
		record.depth > 32
	) {
		throw new Error("Company room delivery delegation is invalid");
	}
	return { depth: record.depth, ancestorStaffAgentIds: staffIdsValue(record.ancestorStaffAgentIds, 1) };
}

function staffIdsValue(value: unknown, minimum: number): string[] {
	if (
		!Array.isArray(value) ||
		value.length < minimum ||
		value.length > MAX_PARTICIPANTS ||
		value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
		new Set(value).size !== value.length
	) {
		throw new Error("Company room participants are invalid");
	}
	return [...value] as string[];
}

function participantIdsValue(value: unknown): string[] {
	return staffIdsValue(value, 2);
}

function roomValue(value: unknown, key: string): CompanyRoom {
	const record = recordValue(value);
	if (!record || !exactFields(record, ROOM_FIELDS) || !UUID_PATTERN.test(key) || record.id !== key) {
		throw new Error("Company room record is invalid");
	}
	if (record.status !== "active" && record.status !== "archived") {
		throw new Error("Company room status is invalid");
	}
	const createdAt = timestampValue(record.createdAt, "createdAt");
	const updatedAt = timestampValue(record.updatedAt, "updatedAt");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Company room timestamps are invalid");
	const title = boundedText(record.title, "title", 320, true);
	const participantIds = participantIdsValue(record.participantIds);
	const historicalParticipantIds =
		record.historicalParticipantIds === undefined
			? [...participantIds]
			: staffIdsValue(record.historicalParticipantIds, 2);
	if (participantIds.some((id) => !historicalParticipantIds.includes(id))) {
		throw new Error("Company room participant history is invalid");
	}
	return {
		id: key,
		participantIds,
		historicalParticipantIds,
		...(title ? { title } : {}),
		status: record.status,
		createdAt,
		updatedAt,
	};
}

function physicalDirectory(root: string, relativePath: string, create: boolean): string | undefined {
	const canonical = canonicalRoot(root);
	let current = canonical;
	for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
		current = join(current, segment);
		if (!existsSync(current)) {
			if (!create) return undefined;
			mkdirSync(current);
		}
		const entry = lstatSync(current);
		if (
			!entry.isDirectory() ||
			entry.isSymbolicLink() ||
			normalizedPath(realpathSync(current)) !== normalizedPath(current)
		) {
			throw new Error("Room storage must use physical directories");
		}
	}
	return current;
}

function registryPath(root: string): string | undefined {
	const directory = physicalDirectory(root, ".qorpera", false);
	if (!directory) return undefined;
	const path = join(directory, "rooms.json");
	if (!existsSync(path)) return undefined;
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		entry.size > MAX_REGISTRY_BYTES ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("Company room registry must be one physical file");
	}
	return path;
}

function deliveryRegistryPath(root: string): string | undefined {
	const directory = physicalDirectory(root, ".qorpera", false);
	if (!directory) return undefined;
	const path = join(directory, "room-deliveries.json");
	if (!existsSync(path)) return undefined;
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		entry.size > MAX_DELIVERY_REGISTRY_BYTES ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("Company room delivery registry must be one physical file");
	}
	return path;
}

function emptyRegistry(): CompanyRoomRegistry {
	return { version: 1, rooms: {} };
}

function readRegistry(root: string): CompanyRoomRegistry {
	const path = registryPath(root);
	if (!path) return emptyRegistry();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		throw new Error("Company room registry is invalid");
	}
	const record = recordValue(parsed);
	if (!record || !exactFields(record, REGISTRY_FIELDS) || record.version !== 1) {
		throw new Error("Company room registry is invalid");
	}
	const roomsRecord = recordValue(record.rooms);
	if (!roomsRecord || Object.keys(roomsRecord).length > MAX_ROOMS) {
		throw new Error("Company room registry rooms are invalid");
	}
	const rooms: Record<string, CompanyRoom> = {};
	for (const [id, value] of Object.entries(roomsRecord)) rooms[id] = roomValue(value, id);
	return { version: 1, rooms };
}

function writeRegistry(root: string, registry: CompanyRoomRegistry): void {
	const directory = physicalDirectory(root, ".qorpera", true)!;
	const path = join(directory, "rooms.json");
	if (existsSync(path)) registryPath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(registry, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function deliveryValue(value: unknown, key: string): QueuedCompanyRoomDelivery {
	const record = recordValue(value);
	if (
		!record ||
		!exactFields(record, DELIVERY_FIELDS) ||
		!UUID_PATTERN.test(key) ||
		record.id !== key ||
		typeof record.roomId !== "string" ||
		!UUID_PATTERN.test(record.roomId) ||
		typeof record.messageId !== "string" ||
		!UUID_PATTERN.test(record.messageId) ||
		typeof record.attempts !== "number" ||
		!Number.isInteger(record.attempts) ||
		record.attempts < 0 ||
		record.attempts > 1_000
	) {
		throw new Error("Company room delivery is invalid");
	}
	const nextAttemptAt = timestampValue(record.nextAttemptAt, "nextAttemptAt", "room delivery");
	const createdAt = timestampValue(record.createdAt, "createdAt", "room delivery");
	const updatedAt = timestampValue(record.updatedAt, "updatedAt", "room delivery");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Company room delivery timestamps are invalid");
	const lastError = boundedText(record.lastError, "delivery error", 1_024, true);
	const delegation = delegationValue(record.delegation);
	return {
		id: key,
		roomId: record.roomId,
		messageId: record.messageId,
		targetStaffAgentIds: staffIdsValue(record.targetStaffAgentIds, 1),
		attempts: record.attempts,
		nextAttemptAt,
		...(lastError ? { lastError } : {}),
		...(delegation ? { delegation } : {}),
		createdAt,
		updatedAt,
	};
}

function emptyDeliveryRegistry(): CompanyRoomDeliveryRegistry {
	return { version: 1, deliveries: {} };
}

function readDeliveryRegistry(root: string): CompanyRoomDeliveryRegistry {
	const path = deliveryRegistryPath(root);
	if (!path) return emptyDeliveryRegistry();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		throw new Error("Company room delivery registry is invalid");
	}
	const record = recordValue(parsed);
	if (!record || !exactFields(record, DELIVERY_REGISTRY_FIELDS) || record.version !== 1) {
		throw new Error("Company room delivery registry is invalid");
	}
	const deliveriesRecord = recordValue(record.deliveries);
	if (!deliveriesRecord || Object.keys(deliveriesRecord).length > MAX_QUEUED_DELIVERIES) {
		throw new Error("Company room delivery registry entries are invalid");
	}
	const deliveries: Record<string, QueuedCompanyRoomDelivery> = {};
	for (const [id, value] of Object.entries(deliveriesRecord)) deliveries[id] = deliveryValue(value, id);
	return { version: 1, deliveries };
}

function writeDeliveryRegistry(root: string, registry: CompanyRoomDeliveryRegistry): void {
	const directory = physicalDirectory(root, ".qorpera", true)!;
	const path = join(directory, "room-deliveries.json");
	if (existsSync(path)) deliveryRegistryPath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(registry, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function cloneDelivery(delivery: QueuedCompanyRoomDelivery): QueuedCompanyRoomDelivery {
	return {
		...delivery,
		targetStaffAgentIds: [...delivery.targetStaffAgentIds],
		...(delivery.delegation
			? {
					delegation: {
						depth: delivery.delegation.depth,
						ancestorStaffAgentIds: [...delivery.delegation.ancestorStaffAgentIds],
					},
				}
			: {}),
	};
}

function cloneRoom(room: CompanyRoom): CompanyRoom {
	return {
		...room,
		participantIds: [...room.participantIds],
		historicalParticipantIds: [...room.historicalParticipantIds],
	};
}

function checkedRoomId(roomId: string): string {
	if (!UUID_PATTERN.test(roomId)) throw new Error("Company room identity is invalid");
	return roomId;
}

function transcriptPath(root: string, roomId: string, create: boolean): string | undefined {
	const directory = physicalDirectory(root, ROOM_TRANSCRIPT_DIRECTORY, create);
	if (!directory) return undefined;
	const path = join(directory, `${checkedRoomId(roomId)}.jsonl`);
	if (!existsSync(path)) return create ? path : undefined;
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		entry.size > MAX_TRANSCRIPT_BYTES ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("Company room transcript must be one physical file");
	}
	return path;
}

function imagesValue(value: unknown): CompanyRoomImage[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 8) throw new Error("Company room images are invalid");
	const images = value.map((image) => {
		const record = recordValue(image);
		if (
			!record ||
			!exactFields(record, new Set(["mimeType", "data"])) ||
			typeof record.mimeType !== "string" ||
			!/^image\/[a-z0-9.+-]{1,64}$/i.test(record.mimeType) ||
			typeof record.data !== "string" ||
			!record.data ||
			Buffer.byteLength(record.data, "utf-8") > MAX_IMAGE_BYTES
		) {
			throw new Error("Company room images are invalid");
		}
		return { mimeType: record.mimeType, data: record.data };
	});
	return images.length ? images : undefined;
}

function speakerValue(value: unknown): CompanyRoomSpeaker {
	const record = recordValue(value);
	if (!record || (record.kind !== "founder" && record.kind !== "staff")) {
		throw new Error("Company room speaker is invalid");
	}
	if (record.kind === "founder" && exactFields(record, new Set(["kind"]))) return { kind: "founder" };
	if (
		record.kind === "staff" &&
		exactFields(record, new Set(["kind", "staffAgentId"])) &&
		typeof record.staffAgentId === "string" &&
		UUID_PATTERN.test(record.staffAgentId)
	) {
		return { kind: "staff", staffAgentId: record.staffAgentId };
	}
	throw new Error("Company room speaker is invalid");
}

function roomMessageHash(message: Omit<CompanyRoomMessage, "hash">): string {
	return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

function messageValue(
	value: unknown,
	room: CompanyRoom,
	expected?: { sequence: number; previousHash: string | null },
): CompanyRoomMessage {
	const record = recordValue(value);
	if (
		!record ||
		!exactFields(
			record,
			new Set([
				"id",
				"roomId",
				"sequence",
				"speaker",
				"text",
				"images",
				"targetStaffAgentIds",
				"sourceTrailFile",
				"createdAt",
				"previousHash",
				"hash",
			]),
		) ||
		typeof record.id !== "string" ||
		!UUID_PATTERN.test(record.id) ||
		record.roomId !== room.id ||
		(expected
			? record.sequence !== expected.sequence || record.previousHash !== expected.previousHash
			: typeof record.sequence !== "number" ||
				!Number.isInteger(record.sequence) ||
				record.sequence < 1 ||
				(record.previousHash !== null &&
					(typeof record.previousHash !== "string" || !/^[a-f0-9]{64}$/.test(record.previousHash)))) ||
		typeof record.hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.hash)
	) {
		throw new Error("Company room transcript is invalid");
	}
	const speaker = speakerValue(record.speaker);
	if (speaker.kind === "staff" && !room.historicalParticipantIds.includes(speaker.staffAgentId)) {
		throw new Error("Company room transcript speaker is not a participant");
	}
	const text = record.text === "" ? "" : boundedText(record.text, "message text", MAX_TEXT_BYTES)!;
	const images = imagesValue(record.images);
	if (!text && !images?.length) throw new Error("Company room message is empty");
	const targets = record.targetStaffAgentIds === undefined ? undefined : staffIdsValue(record.targetStaffAgentIds, 1);
	if (targets?.some((id) => !room.historicalParticipantIds.includes(id))) {
		throw new Error("Company room message target is not a participant");
	}
	const sourceTrailFile = boundedText(record.sourceTrailFile, "source trail", 512, true);
	if (sourceTrailFile && (basename(sourceTrailFile) !== sourceTrailFile || !sourceTrailFile.endsWith(".jsonl"))) {
		throw new Error("Company room source trail is invalid");
	}
	const createdAt = timestampValue(record.createdAt, "createdAt");
	const unsigned: Omit<CompanyRoomMessage, "hash"> = {
		id: record.id,
		roomId: room.id,
		sequence: expected ? expected.sequence : (record.sequence as number),
		speaker,
		text,
		...(images ? { images } : {}),
		...(targets ? { targetStaffAgentIds: targets } : {}),
		...(sourceTrailFile ? { sourceTrailFile } : {}),
		createdAt,
		previousHash: expected ? expected.previousHash : (record.previousHash as string | null),
	};
	if (record.hash !== roomMessageHash(unsigned)) throw new Error("Company room transcript hash is invalid");
	return { ...unsigned, hash: record.hash };
}

export function companyRoomRegistryPath(root: string): string {
	return join(canonicalRoot(root), ROOM_REGISTRY_RELATIVE_PATH);
}

export function companyRoomDeliveryRegistryPath(root: string): string {
	return join(canonicalRoot(root), ROOM_DELIVERY_REGISTRY_RELATIVE_PATH);
}

export function readCompanyRooms(root: string): CompanyRoom[] {
	return Object.values(readRegistry(root).rooms)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.map(cloneRoom);
}

export function readCompanyRoom(root: string, roomId: string): CompanyRoom | undefined {
	const room = readRegistry(root).rooms[checkedRoomId(roomId)];
	return room ? cloneRoom(room) : undefined;
}

export function createCompanyRoom(root: string, input: CreateCompanyRoomInput): CompanyRoom {
	const record = input as unknown as Record<string, unknown>;
	if (!exactFields(record, new Set(["participantIds", "title"])))
		throw new Error("Company room creation input is invalid");
	const registry = readRegistry(root);
	if (Object.keys(registry.rooms).length >= MAX_ROOMS) throw new Error("Company room registry is full");
	const now = new Date().toISOString();
	const title = boundedText(record.title, "title", 320, true);
	const room: CompanyRoom = {
		id: randomUUID(),
		participantIds: participantIdsValue(record.participantIds),
		historicalParticipantIds: participantIdsValue(record.participantIds),
		...(title ? { title } : {}),
		status: "active",
		createdAt: now,
		updatedAt: now,
	};
	registry.rooms[room.id] = room;
	writeRegistry(root, registry);
	return cloneRoom(room);
}

function setRoomStatus(root: string, roomId: string, status: CompanyRoomStatus): CompanyRoom {
	const registry = readRegistry(root);
	const current = registry.rooms[checkedRoomId(roomId)];
	if (!current) throw new Error(`Unknown company room: ${roomId}`);
	if (current.status === status) return cloneRoom(current);
	const room: CompanyRoom = { ...current, status, updatedAt: new Date().toISOString() };
	registry.rooms[room.id] = room;
	writeRegistry(root, registry);
	return cloneRoom(room);
}

export function archiveCompanyRoom(root: string, roomId: string): CompanyRoom {
	return setRoomStatus(root, roomId, "archived");
}

export function restoreCompanyRoom(root: string, roomId: string): CompanyRoom {
	return setRoomStatus(root, roomId, "active");
}

export function updateCompanyRoom(root: string, roomId: string, input: UpdateCompanyRoomInput): CompanyRoom {
	const record = input as unknown as Record<string, unknown>;
	if (
		!Object.keys(record).length ||
		!exactFields(record, new Set(["participantIds", "title"])) ||
		(record.title !== undefined && record.title !== null && typeof record.title !== "string")
	) {
		throw new Error("Company room update input is invalid");
	}
	const registry = readRegistry(root);
	const current = registry.rooms[checkedRoomId(roomId)];
	if (!current || current.status !== "active") throw new Error("Company room is unavailable");
	const participantIds =
		record.participantIds === undefined ? [...current.participantIds] : participantIdsValue(record.participantIds);
	const title = record.title === null ? undefined : boundedText(record.title, "title", 320, true);
	const room: CompanyRoom = {
		...current,
		participantIds,
		historicalParticipantIds: [
			...current.historicalParticipantIds,
			...participantIds.filter((id) => !current.historicalParticipantIds.includes(id)),
		],
		...(record.title === undefined ? (current.title ? { title: current.title } : {}) : title ? { title } : {}),
		updatedAt: new Date().toISOString(),
	};
	if (record.title === null) delete room.title;
	registry.rooms[room.id] = room;
	writeRegistry(root, registry);
	return cloneRoom(room);
}

export function readCompanyRoomMessages(root: string, roomId: string): CompanyRoomMessage[] {
	const room = readCompanyRoom(root, roomId);
	if (!room) throw new Error(`Unknown company room: ${roomId}`);
	const path = transcriptPath(root, room.id, false);
	if (!path) return [];
	const messages: CompanyRoomMessage[] = [];
	let previousHash: string | null = null;
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error("Company room transcript is invalid");
		}
		const message = messageValue(parsed, room, { sequence: messages.length + 1, previousHash });
		messages.push(message);
		previousHash = message.hash;
	}
	return messages.map((message) => ({
		...message,
		speaker: { ...message.speaker },
		...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
		...(message.targetStaffAgentIds ? { targetStaffAgentIds: [...message.targetStaffAgentIds] } : {}),
	}));
}

/** Last transcript entry, self-hash-verified without replaying the whole
 * chain. Appends only need the tail's sequence and hash; full-chain
 * verification stays on the read paths, keeping appends O(1) in messages
 * instead of O(n) parse-and-hash over transcripts that may carry images. */
function transcriptTail(root: string, room: CompanyRoom): { sequence: number; hash: string } | null {
	const path = transcriptPath(root, room.id, false);
	if (!path) return null;
	const content = readFileSync(path, "utf-8");
	let end = content.length;
	while (end > 0) {
		const start = content.lastIndexOf("\n", end - 1);
		const line = content.slice(start + 1, end).trim();
		if (line) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new Error("Company room transcript is invalid");
			}
			const message = messageValue(parsed, room);
			return { sequence: message.sequence, hash: message.hash };
		}
		if (start < 0) break;
		end = start;
	}
	return null;
}

/** Locate one message by id without verifying the whole chain: lines are
 * prefiltered by an id substring scan and only the match is validated
 * against its own hash. */
export function readCompanyRoomMessage(
	root: string,
	roomId: string,
	messageId: string,
): CompanyRoomMessage | undefined {
	const room = readCompanyRoom(root, roomId);
	if (!room) throw new Error(`Unknown company room: ${roomId}`);
	if (!UUID_PATTERN.test(messageId)) throw new Error("Company room message identity is invalid");
	const path = transcriptPath(root, room.id, false);
	if (!path) return undefined;
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
		if (!line || !line.includes(messageId)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error("Company room transcript is invalid");
		}
		const message = messageValue(parsed, room);
		if (message.id !== messageId) continue;
		return {
			...message,
			speaker: { ...message.speaker },
			...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
			...(message.targetStaffAgentIds ? { targetStaffAgentIds: [...message.targetStaffAgentIds] } : {}),
		};
	}
	return undefined;
}

export function appendCompanyRoomMessage(
	root: string,
	roomId: string,
	input: AppendCompanyRoomMessageInput,
): CompanyRoomMessage {
	const record = input as unknown as Record<string, unknown>;
	if (!exactFields(record, new Set(["speaker", "text", "images", "targetStaffAgentIds", "sourceTrailFile"]))) {
		throw new Error("Company room message input is invalid");
	}
	const registry = readRegistry(root);
	const room = registry.rooms[checkedRoomId(roomId)];
	if (!room || room.status !== "active") throw new Error("Company room is unavailable");
	const tail = transcriptTail(root, room);
	const speaker = speakerValue(record.speaker);
	if (speaker.kind === "staff" && !room.participantIds.includes(speaker.staffAgentId)) {
		throw new Error("Company room speaker is not a participant");
	}
	const text = record.text === undefined ? "" : boundedText(record.text, "message text", MAX_TEXT_BYTES)!;
	const images = imagesValue(record.images);
	if (!text && !images?.length) throw new Error("Company room message is empty");
	let targets: string[] | undefined;
	if (record.targetStaffAgentIds !== undefined) {
		if (
			!Array.isArray(record.targetStaffAgentIds) ||
			!record.targetStaffAgentIds.length ||
			record.targetStaffAgentIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
			new Set(record.targetStaffAgentIds).size !== record.targetStaffAgentIds.length ||
			record.targetStaffAgentIds.some((id) => !room.participantIds.includes(id))
		) {
			throw new Error("Company room message targets are invalid");
		}
		targets = [...record.targetStaffAgentIds] as string[];
	}
	const sourceTrailFile = boundedText(record.sourceTrailFile, "source trail", 512, true);
	if (sourceTrailFile && (basename(sourceTrailFile) !== sourceTrailFile || !sourceTrailFile.endsWith(".jsonl"))) {
		throw new Error("Company room source trail is invalid");
	}
	const unsigned: Omit<CompanyRoomMessage, "hash"> = {
		id: randomUUID(),
		roomId: room.id,
		sequence: (tail?.sequence ?? 0) + 1,
		speaker,
		text,
		...(images ? { images } : {}),
		...(targets ? { targetStaffAgentIds: targets } : {}),
		...(sourceTrailFile ? { sourceTrailFile } : {}),
		createdAt: new Date().toISOString(),
		previousHash: tail?.hash ?? null,
	};
	const message: CompanyRoomMessage = { ...unsigned, hash: roomMessageHash(unsigned) };
	const path = transcriptPath(root, room.id, true)!;
	appendFileSync(path, `${JSON.stringify(message)}\n`, { encoding: "utf-8", flag: "a" });
	try {
		registry.rooms[room.id] = { ...room, updatedAt: message.createdAt };
		writeRegistry(root, registry);
	} catch {
		// The transcript line above is already durable; failing the append now
		// would make callers retry and duplicate the message over a best-effort
		// recency bump.
	}
	return {
		...message,
		speaker: { ...message.speaker },
		...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
		...(message.targetStaffAgentIds ? { targetStaffAgentIds: [...message.targetStaffAgentIds] } : {}),
	};
}

export function readQueuedCompanyRoomDeliveries(root: string, roomId?: string): QueuedCompanyRoomDelivery[] {
	const checkedRoom = roomId === undefined ? undefined : checkedRoomId(roomId);
	return Object.values(readDeliveryRegistry(root).deliveries)
		.filter((delivery) => checkedRoom === undefined || delivery.roomId === checkedRoom)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		.map(cloneDelivery);
}

export function queueCompanyRoomDelivery(
	root: string,
	roomId: string,
	input: QueueCompanyRoomDeliveryInput,
): QueuedCompanyRoomDelivery {
	const room = readCompanyRoom(root, roomId);
	if (!room || room.status !== "active") throw new Error("Company room is unavailable");
	const record = input as unknown as Record<string, unknown>;
	if (
		!exactFields(record, new Set(["messageId", "targetStaffAgentIds", "delegation"])) ||
		typeof record.messageId !== "string" ||
		!UUID_PATTERN.test(record.messageId)
	) {
		throw new Error("Company room delivery input is invalid");
	}
	const targets = staffIdsValue(record.targetStaffAgentIds, 1);
	if (targets.some((id) => !room.participantIds.includes(id))) {
		throw new Error("Company room delivery target is not a participant");
	}
	const delegation = delegationValue(record.delegation);
	const message = readCompanyRoomMessage(root, room.id, record.messageId);
	if (!message) throw new Error("Company room delivery message is invalid");
	if (message.speaker.kind === "staff" && targets.includes(message.speaker.staffAgentId)) {
		throw new Error("Company room delivery cannot target its own speaker");
	}
	const allowedTargets = message.targetStaffAgentIds ?? room.participantIds;
	if (targets.some((id) => !allowedTargets.includes(id))) {
		throw new Error("Company room delivery target was not addressed by the message");
	}
	const registry = readDeliveryRegistry(root);
	const duplicate = Object.values(registry.deliveries).find((delivery) => delivery.messageId === message.id);
	if (duplicate) throw new Error("Company room message is already queued");
	if (Object.keys(registry.deliveries).length >= MAX_QUEUED_DELIVERIES) {
		throw new Error("Company room delivery queue is full");
	}
	const now = new Date().toISOString();
	const delivery: QueuedCompanyRoomDelivery = {
		id: randomUUID(),
		roomId: room.id,
		messageId: message.id,
		targetStaffAgentIds: targets,
		attempts: 0,
		nextAttemptAt: now,
		...(delegation ? { delegation } : {}),
		createdAt: now,
		updatedAt: now,
	};
	registry.deliveries[delivery.id] = delivery;
	writeDeliveryRegistry(root, registry);
	return cloneDelivery(delivery);
}

export function rescheduleCompanyRoomDelivery(
	root: string,
	deliveryId: string,
	targetStaffAgentIds: readonly string[],
	lastError?: string,
	options?: { preserveAttempts?: boolean },
): QueuedCompanyRoomDelivery | undefined {
	const registry = readDeliveryRegistry(root);
	const current = registry.deliveries[checkedRoomId(deliveryId)];
	// A delivery can be retired concurrently (room archived, queue pruned)
	// while its turn is still running; the reschedule then has nothing to do.
	if (!current) return undefined;
	const room = readCompanyRoom(root, current.roomId);
	// Membership and lifecycle can change while a delivery waits. Targets that
	// left the room are dropped rather than poisoning the remaining recipients,
	// and a vanished or archived room retires the delivery entirely.
	const targets =
		room && room.status === "active"
			? staffIdsValue([...targetStaffAgentIds], 0).filter(
					(id) => current.targetStaffAgentIds.includes(id) && room.participantIds.includes(id),
				)
			: [];
	if (!targets.length) {
		delete registry.deliveries[current.id];
		writeDeliveryRegistry(root, registry);
		return undefined;
	}
	const error = lastError === undefined ? undefined : boundedText(lastError.trim(), "delivery error", 1_024);
	// attempts counts CONSECUTIVE failures: a served turn resets it so one
	// participant's earlier failures never spend another participant's budget.
	// A target-only prune (preserveAttempts) is neither a success nor a
	// failure and must not refresh a failing target's retry budget.
	const attempts = error ? Math.min(1_000, current.attempts + 1) : options?.preserveAttempts ? current.attempts : 0;
	const delay = error ? Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)) : 0;
	const updatedAt = new Date().toISOString();
	const delivery: QueuedCompanyRoomDelivery = {
		...current,
		targetStaffAgentIds: targets,
		attempts,
		nextAttemptAt:
			options?.preserveAttempts && !error ? current.nextAttemptAt : new Date(Date.now() + delay).toISOString(),
		updatedAt,
	};
	if (error) delivery.lastError = error;
	else if (!options?.preserveAttempts) delete delivery.lastError;
	registry.deliveries[delivery.id] = delivery;
	writeDeliveryRegistry(root, registry);
	return cloneDelivery(delivery);
}

export function removeQueuedCompanyRoomDeliveries(root: string, roomId: string): QueuedCompanyRoomDelivery[] {
	const checkedRoom = checkedRoomId(roomId);
	const registry = readDeliveryRegistry(root);
	const removed = Object.values(registry.deliveries).filter((delivery) => delivery.roomId === checkedRoom);
	if (!removed.length) return [];
	for (const delivery of removed) delete registry.deliveries[delivery.id];
	writeDeliveryRegistry(root, registry);
	return removed.map(cloneDelivery);
}
