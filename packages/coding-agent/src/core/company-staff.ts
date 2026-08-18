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

export interface StaffAgentAppearance {
	color: string;
	shape: string;
	creature?: string;
}

export type StaffAgentEmploymentStatus = "active" | "archived";

export interface StaffAgent {
	id: string;
	displayName: string;
	role: string;
	charter: string;
	templateId?: string;
	departmentId?: string;
	appearance: StaffAgentAppearance;
	employmentStatus: StaffAgentEmploymentStatus;
	createdAt: string;
	updatedAt: string;
}

export interface CreateStaffAgentInput {
	displayName: string;
	role: string;
	charter: string;
	templateId?: string;
	departmentId?: string;
	appearance: StaffAgentAppearance;
}

export interface UpdateStaffAgentInput {
	displayName?: string;
	role?: string;
	charter?: string;
	templateId?: string | null;
	departmentId?: string | null;
	appearance?: StaffAgentAppearance;
}

interface StaffRegistry {
	version: 1;
	agents: Record<string, StaffAgent>;
}

const STAFF_REGISTRY_RELATIVE_PATH = join(".qorpera", "staff.json");
const MAX_STAFF_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_STAFF_AGENTS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENT_FIELDS = new Set([
	"id",
	"displayName",
	"role",
	"charter",
	"templateId",
	"departmentId",
	"appearance",
	"employmentStatus",
	"createdAt",
	"updatedAt",
]);
const APPEARANCE_FIELDS = new Set(["color", "shape", "creature"]);
const REGISTRY_FIELDS = new Set(["version", "agents"]);
const UPDATE_FIELDS = new Set(["displayName", "role", "charter", "templateId", "departmentId", "appearance"]);

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalRoot(root: string): string {
	const canonical = realpathSync(resolve(root));
	const entry = lstatSync(canonical);
	if (!entry.isDirectory() || entry.isSymbolicLink())
		throw new Error("Staff registry requires a physical company root");
	return canonical;
}

export function staffRegistryPath(root: string): string {
	return join(canonicalRoot(root), STAFF_REGISTRY_RELATIVE_PATH);
}

function physicalRegistryDirectory(root: string, create: boolean): string | undefined {
	const canonical = canonicalRoot(root);
	const directory = join(canonical, ".qorpera");
	if (!existsSync(directory)) {
		if (!create) return undefined;
		mkdirSync(directory);
	}
	const entry = lstatSync(directory);
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		normalizedPath(realpathSync(directory)) !== normalizedPath(directory)
	) {
		throw new Error("Staff registry directory must be one physical directory");
	}
	return directory;
}

function physicalRegistryPath(root: string): string | undefined {
	const directory = physicalRegistryDirectory(root, false);
	if (!directory) return undefined;
	const path = join(directory, "staff.json");
	if (!existsSync(path)) return undefined;
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("Staff registry must be one physical file");
	}
	if (entry.size > MAX_STAFF_REGISTRY_BYTES) throw new Error("Staff registry exceeds its size limit");
	return path;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function exactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(record).every((key) => allowed.has(key));
}

function boundedText(value: unknown, field: string, maxBytes: number, multiline: boolean): string {
	if (typeof value !== "string" || value !== value.trim() || !value || value.includes("\0")) {
		throw new Error(`Staff agent ${field} is invalid`);
	}
	if (!multiline && /[\r\n]/.test(value)) throw new Error(`Staff agent ${field} is invalid`);
	if (Buffer.byteLength(value, "utf-8") > maxBytes) throw new Error(`Staff agent ${field} is invalid`);
	return value;
}

function optionalIdentifier(value: unknown, field: "templateId" | "departmentId"): string | undefined {
	if (value === undefined) return undefined;
	return boundedText(value, field, 256, false);
}

function appearanceValue(value: unknown): StaffAgentAppearance {
	const record = recordValue(value);
	if (!record || !exactFields(record, APPEARANCE_FIELDS)) throw new Error("Staff agent appearance is invalid");
	const creature =
		record.creature === undefined ? undefined : boundedText(record.creature, "appearance creature", 64, false);
	return {
		color: boundedText(record.color, "appearance color", 64, false),
		shape: boundedText(record.shape, "appearance shape", 64, false),
		...(creature ? { creature } : {}),
	};
}

function timestampValue(value: unknown, field: "createdAt" | "updatedAt"): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new Error(`Staff agent ${field} is invalid`);
	}
	return value;
}

function staffAgentValue(value: unknown, key: string): StaffAgent {
	const record = recordValue(value);
	if (!record || !exactFields(record, AGENT_FIELDS)) throw new Error("Staff agent record is invalid");
	if (!UUID_PATTERN.test(key) || record.id !== key) throw new Error("Staff agent identity is invalid");
	if (record.employmentStatus !== "active" && record.employmentStatus !== "archived") {
		throw new Error("Staff agent employment status is invalid");
	}
	const createdAt = timestampValue(record.createdAt, "createdAt");
	const updatedAt = timestampValue(record.updatedAt, "updatedAt");
	const templateId = optionalIdentifier(record.templateId, "templateId");
	const departmentId = optionalIdentifier(record.departmentId, "departmentId");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Staff agent timestamps are invalid");
	return {
		id: key,
		displayName: boundedText(record.displayName, "displayName", 160, false),
		role: boundedText(record.role, "role", 320, false),
		charter: boundedText(record.charter, "charter", 32 * 1024, true),
		...(templateId ? { templateId } : {}),
		...(departmentId ? { departmentId } : {}),
		appearance: appearanceValue(record.appearance),
		employmentStatus: record.employmentStatus,
		createdAt,
		updatedAt,
	};
}

function emptyRegistry(): StaffRegistry {
	return { version: 1, agents: {} };
}

function readRegistry(root: string): StaffRegistry {
	const path = physicalRegistryPath(root);
	if (!path) return emptyRegistry();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		throw new Error("Staff registry is invalid");
	}
	const record = recordValue(parsed);
	if (!record || !exactFields(record, REGISTRY_FIELDS) || record.version !== 1) {
		throw new Error("Staff registry is invalid");
	}
	const agentsRecord = recordValue(record.agents);
	if (!agentsRecord || Object.keys(agentsRecord).length > MAX_STAFF_AGENTS) {
		throw new Error("Staff registry agents are invalid");
	}
	const agents: Record<string, StaffAgent> = {};
	for (const [id, value] of Object.entries(agentsRecord)) agents[id] = staffAgentValue(value, id);
	return { version: 1, agents };
}

function writeRegistry(root: string, registry: StaffRegistry): void {
	const directory = physicalRegistryDirectory(root, true)!;
	const path = join(directory, "staff.json");
	if (existsSync(path)) physicalRegistryPath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(registry, null, "\t")}\n`, {
			encoding: "utf-8",
			flag: "wx",
		});
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function createInputValue(
	input: CreateStaffAgentInput,
): Omit<StaffAgent, "id" | "employmentStatus" | "createdAt" | "updatedAt"> {
	const record = input as unknown as Record<string, unknown>;
	if (
		!exactFields(record, UPDATE_FIELDS) ||
		!Object.hasOwn(record, "displayName") ||
		!Object.hasOwn(record, "role") ||
		!Object.hasOwn(record, "charter") ||
		!Object.hasOwn(record, "appearance")
	) {
		throw new Error("Staff agent creation input is invalid");
	}
	const templateId = optionalIdentifier(record.templateId, "templateId");
	const departmentId = optionalIdentifier(record.departmentId, "departmentId");
	return {
		displayName: boundedText(record.displayName, "displayName", 160, false),
		role: boundedText(record.role, "role", 320, false),
		charter: boundedText(record.charter, "charter", 32 * 1024, true),
		...(templateId ? { templateId } : {}),
		...(departmentId ? { departmentId } : {}),
		appearance: appearanceValue(record.appearance),
	};
}

function checkedStaffAgentId(id: string): string {
	if (!UUID_PATTERN.test(id)) throw new Error("Staff agent identity is invalid");
	return id;
}

function existingStaffAgent(registry: StaffRegistry, id: string): StaffAgent {
	const agent = registry.agents[checkedStaffAgentId(id)];
	if (!agent) throw new Error(`Unknown staff agent: ${id}`);
	return agent;
}

export function readStaffAgents(root: string): StaffAgent[] {
	return Object.values(readRegistry(root).agents).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Replace the local projection with an authoritative staff snapshot while
 * preserving every cloud-owned identity and timestamp. */
export function replaceStaffAgents(root: string, agents: readonly StaffAgent[]): StaffAgent[] {
	if (agents.length > MAX_STAFF_AGENTS) throw new Error("Staff registry is full");
	const registry = emptyRegistry();
	for (const value of agents) {
		const record = value as unknown as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : "";
		const agent = staffAgentValue(value, id);
		if (registry.agents[id]) throw new Error(`Duplicate staff agent: ${id}`);
		registry.agents[id] = agent;
	}
	writeRegistry(root, registry);
	return Object.values(registry.agents)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		.map((agent) => ({ ...agent, appearance: { ...agent.appearance } }));
}

export function createStaffAgent(root: string, input: CreateStaffAgentInput): StaffAgent {
	return createStaffAgents(root, [input])[0]!;
}

export function createStaffAgents(root: string, inputs: readonly CreateStaffAgentInput[]): StaffAgent[] {
	if (inputs.length === 0) throw new Error("Staff agent creation batch is empty");
	const registry = readRegistry(root);
	if (Object.keys(registry.agents).length + inputs.length > MAX_STAFF_AGENTS)
		throw new Error("Staff registry is full");
	const checkedInputs = inputs.map((input) => createInputValue(input));
	const now = new Date().toISOString();
	const agents = checkedInputs.map(
		(input): StaffAgent => ({
			id: randomUUID(),
			...input,
			employmentStatus: "active",
			createdAt: now,
			updatedAt: now,
		}),
	);
	for (const agent of agents) registry.agents[agent.id] = agent;
	writeRegistry(root, registry);
	return agents.map((agent) => ({ ...agent, appearance: { ...agent.appearance } }));
}

export function updateStaffAgent(root: string, id: string, update: UpdateStaffAgentInput): StaffAgent {
	const record = update as unknown as Record<string, unknown>;
	if (!exactFields(record, UPDATE_FIELDS) || Object.keys(record).length === 0) {
		throw new Error("Staff agent update is invalid");
	}
	const registry = readRegistry(root);
	const current = existingStaffAgent(registry, id);
	const next: StaffAgent = {
		...current,
		...(record.displayName !== undefined
			? { displayName: boundedText(record.displayName, "displayName", 160, false) }
			: {}),
		...(record.role !== undefined ? { role: boundedText(record.role, "role", 320, false) } : {}),
		...(record.charter !== undefined ? { charter: boundedText(record.charter, "charter", 32 * 1024, true) } : {}),
		...(record.templateId === null
			? { templateId: undefined }
			: record.templateId !== undefined
				? { templateId: optionalIdentifier(record.templateId, "templateId") }
				: {}),
		...(record.departmentId === null
			? { departmentId: undefined }
			: record.departmentId !== undefined
				? { departmentId: optionalIdentifier(record.departmentId, "departmentId") }
				: {}),
		...(record.appearance !== undefined ? { appearance: appearanceValue(record.appearance) } : {}),
		updatedAt: new Date().toISOString(),
	};
	if (next.templateId === undefined) delete next.templateId;
	if (next.departmentId === undefined) delete next.departmentId;
	registry.agents[id] = next;
	writeRegistry(root, registry);
	return { ...next, appearance: { ...next.appearance } };
}

function setEmploymentStatus(root: string, id: string, status: StaffAgentEmploymentStatus): StaffAgent {
	const registry = readRegistry(root);
	const current = existingStaffAgent(registry, id);
	if (current.employmentStatus === status) return { ...current, appearance: { ...current.appearance } };
	const next: StaffAgent = {
		...current,
		employmentStatus: status,
		updatedAt: new Date().toISOString(),
	};
	registry.agents[id] = next;
	writeRegistry(root, registry);
	return { ...next, appearance: { ...next.appearance } };
}

export function archiveStaffAgent(root: string, id: string): StaffAgent {
	return setEmploymentStatus(root, id, "archived");
}

export function restoreStaffAgent(root: string, id: string): StaffAgent {
	return setEmploymentStatus(root, id, "active");
}
