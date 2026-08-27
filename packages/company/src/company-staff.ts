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

export type {
	QueueStaffAgentMessageInput,
	StaffAgentMessage,
	StaffAgentMessageStatus,
} from "./company-agent-messages.ts";
export {
	markStaffAgentMessagesDelivered,
	pendingStaffAgentMessages,
	queueStaffAgentMessage,
	readStaffAgentMessages,
	recentDeliveredStaffAgentMessages,
	staffAgentMessagesPath,
} from "./company-agent-messages.ts";
export type {
	CompanyArtifactConnectionTransition,
	CompanyArtifactFounderUpdate,
	CompanyArtifactMetricDirection,
	CompanyArtifactObservationUpdate,
	CompanyArtifactRecord,
	CompanyArtifactSourceAssessmentUpdate,
	CompanyArtifactSourceAssessor,
	CompanyArtifactSourceIssueUpdate,
	StarterArtifactDefinition,
} from "./company-artifacts.ts";
export {
	assessCompanyArtifactSource,
	createStarterCompanyArtifact,
	readCompanyArtifacts,
	recordCompanyArtifactObservation,
	reportCompanyArtifactSourceIssue,
	transitionCompanyArtifactConnection,
	updateCompanyArtifact,
} from "./company-artifacts.ts";

export interface StaffAgentAppearance {
	color: string;
	shape: string;
	creature?: string;
}

/** Durable per-agent model choice. Absent means the agent inherits the
 * company runtime default; the selection persists across sessions and wakes. */
export interface StaffAgentModel {
	provider: string;
	modelId: string;
}

export type StaffAgentEmploymentStatus = "active" | "archived";
export type StaffAgentLifecycleState = "setup" | "active";

export interface StaffAgent {
	id: string;
	displayName: string;
	role: string;
	charter: string;
	templateId?: string;
	departmentId?: string;
	appearance: StaffAgentAppearance;
	model?: StaffAgentModel;
	employmentStatus: StaffAgentEmploymentStatus;
	lifecycleState: StaffAgentLifecycleState;
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
	/** null clears the per-agent selection back to the company default. */
	model?: StaffAgentModel | null;
}

interface StaffRegistry {
	version: 1;
	agents: Record<string, StaffAgent>;
}

const STAFF_REGISTRY_RELATIVE_PATH = join(".qorpera", "staff.json");
const AGENTS_RELATIVE_PATH = "agents";
const AGENT_INSTRUCTIONS_FILE = "instructions.md";
const AGENT_MEMORY_FILE = "memory.md";
const AGENT_SKILLS_DIRECTORY = "skills";
const MAX_AGENT_MEMORY_BYTES = 64 * 1024;
const AGENT_MEMORY_SEED = `# Memory

Durable facts this agent has learned: founder preferences, decisions, recurring context, and lessons from past work. Keep entries short, current, and remove anything that turns out to be wrong.
`;
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
	"model",
	"employmentStatus",
	"lifecycleState",
	"createdAt",
	"updatedAt",
]);
const APPEARANCE_FIELDS = new Set(["color", "shape", "creature"]);
const MODEL_FIELDS = new Set(["provider", "modelId"]);
const REGISTRY_FIELDS = new Set(["version", "agents"]);
const CREATE_FIELDS = new Set(["displayName", "role", "charter", "templateId", "departmentId", "appearance"]);
const UPDATE_FIELDS = new Set(["displayName", "role", "charter", "templateId", "departmentId", "appearance", "model"]);

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

function modelValue(value: unknown): StaffAgentModel | undefined {
	if (value === undefined) return undefined;
	const record = recordValue(value);
	if (!record || !exactFields(record, MODEL_FIELDS)) throw new Error("Staff agent model is invalid");
	return {
		provider: boundedText(record.provider, "model provider", 128, false),
		modelId: boundedText(record.modelId, "model id", 256, false),
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
	if (record.lifecycleState !== undefined && record.lifecycleState !== "setup" && record.lifecycleState !== "active") {
		throw new Error("Staff agent lifecycle state is invalid");
	}
	const createdAt = timestampValue(record.createdAt, "createdAt");
	const updatedAt = timestampValue(record.updatedAt, "updatedAt");
	const templateId = optionalIdentifier(record.templateId, "templateId");
	const departmentId = optionalIdentifier(record.departmentId, "departmentId");
	const model = modelValue(record.model);
	if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Staff agent timestamps are invalid");
	return {
		id: key,
		displayName: boundedText(record.displayName, "displayName", 160, false),
		role: boundedText(record.role, "role", 320, false),
		charter: boundedText(record.charter, "charter", 32 * 1024, true),
		...(templateId ? { templateId } : {}),
		...(departmentId ? { departmentId } : {}),
		appearance: appearanceValue(record.appearance),
		...(model ? { model } : {}),
		employmentStatus: record.employmentStatus,
		lifecycleState: record.lifecycleState ?? "setup",
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
): Omit<StaffAgent, "id" | "employmentStatus" | "lifecycleState" | "createdAt" | "updatedAt"> {
	const record = input as unknown as Record<string, unknown>;
	if (
		!exactFields(record, CREATE_FIELDS) ||
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

function physicalAgentsDirectory(root: string, create: boolean): string | undefined {
	const canonical = canonicalRoot(root);
	const directory = join(canonical, AGENTS_RELATIVE_PATH);
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
		throw new Error("Agents directory must be one physical directory");
	}
	return directory;
}

export function staffAgentDirectoryPath(root: string, id: string): string {
	return join(canonicalRoot(root), AGENTS_RELATIVE_PATH, checkedStaffAgentId(id));
}

export function staffAgentInstructionsPath(root: string, id: string): string {
	return join(staffAgentDirectoryPath(root, id), AGENT_INSTRUCTIONS_FILE);
}

export function staffAgentMemoryPath(root: string, id: string): string {
	return join(staffAgentDirectoryPath(root, id), AGENT_MEMORY_FILE);
}

export function staffAgentSkillsPath(root: string, id: string): string {
	return join(staffAgentDirectoryPath(root, id), AGENT_SKILLS_DIRECTORY);
}

/** Best-effort read of an agent's durable private memory. Missing or invalid
 * memory degrades to empty instead of blocking a launch; oversized memory is
 * truncated at the byte limit so a runaway file cannot flood the context. */
export function readStaffAgentMemory(root: string, id: string): string {
	const path = staffAgentMemoryPath(root, id);
	try {
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.isSymbolicLink()) return "";
		const content = readFileSync(path, "utf-8");
		const buffer = Buffer.from(content, "utf-8");
		return buffer.length > MAX_AGENT_MEMORY_BYTES
			? buffer.subarray(0, MAX_AGENT_MEMORY_BYTES).toString("utf-8")
			: content;
	} catch {
		return "";
	}
}

function physicalAgentDirectory(root: string, id: string, create: boolean): string | undefined {
	const agents = physicalAgentsDirectory(root, create);
	if (!agents) return undefined;
	const directory = join(agents, checkedStaffAgentId(id));
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
		throw new Error("Agent workspace must be one physical directory");
	}
	return directory;
}

function writeAgentInstructions(root: string, id: string, charter: string): void {
	const directory = physicalAgentDirectory(root, id, true)!;
	const artifacts = join(directory, "artifacts");
	if (!existsSync(artifacts)) mkdirSync(artifacts);
	const artifactEntry = lstatSync(artifacts);
	if (!artifactEntry.isDirectory() || artifactEntry.isSymbolicLink()) {
		throw new Error("Agent artifacts must be one physical directory");
	}
	const skills = join(directory, AGENT_SKILLS_DIRECTORY);
	if (!existsSync(skills)) mkdirSync(skills);
	const memory = join(directory, AGENT_MEMORY_FILE);
	if (!existsSync(memory)) writeFileSync(memory, AGENT_MEMORY_SEED, { encoding: "utf-8", flag: "wx" });
	const path = join(directory, AGENT_INSTRUCTIONS_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, charter, { encoding: "utf-8", flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readAgentInstructions(root: string, id: string): string {
	const directory = physicalAgentDirectory(root, id, false);
	if (!directory) throw new Error(`Agent workspace is missing: ${id}`);
	const path = join(directory, AGENT_INSTRUCTIONS_FILE);
	if (!existsSync(path)) throw new Error(`Agent instructions are missing: ${id}`);
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("Agent instructions must be one physical file");
	}
	if (entry.size > 32 * 1024) throw new Error("Agent instructions exceed their size limit");
	return boundedText(readFileSync(path, "utf-8").trim(), "charter", 32 * 1024, true);
}

function cloneStaffAgent(agent: StaffAgent): StaffAgent {
	return { ...agent, appearance: { ...agent.appearance }, ...(agent.model ? { model: { ...agent.model } } : {}) };
}

function withAgentInstructions(root: string, agent: StaffAgent): StaffAgent {
	return { ...cloneStaffAgent(agent), charter: readAgentInstructions(root, agent.id) };
}

function existingStaffAgent(registry: StaffRegistry, id: string): StaffAgent {
	const agent = registry.agents[checkedStaffAgentId(id)];
	if (!agent) throw new Error(`Unknown staff agent: ${id}`);
	return agent;
}

export function readStaffAgents(root: string): StaffAgent[] {
	return Object.values(readRegistry(root).agents)
		.map((agent) => withAgentInstructions(root, agent))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Re-materialize a missing generated instruction file only when the local
 * registry already matches the supplied authoritative staff record exactly.
 * Existing files, divergent local records, and malformed workspaces are left
 * untouched so sync cannot overwrite local work or conceal a storage error. */
export function repairMissingStaffAgentInstructions(root: string, value: StaffAgent): boolean {
	const record = value as unknown as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	const expected = staffAgentValue(value, id);
	const current = readRegistry(root).agents[id];
	if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
	const directory = physicalAgentDirectory(root, id, false);
	if (directory && existsSync(join(directory, AGENT_INSTRUCTIONS_FILE))) return false;
	writeAgentInstructions(root, id, current.charter);
	return true;
}

/** Replace the local projection with an authoritative staff snapshot while
 * preserving every cloud-owned identity and timestamp. Charters live
 * authoritatively in each agent's instructions file, so the replacement must
 * write those alongside the registry or the replaced roster would be
 * unreadable; workspaces of agents absent from the snapshot are left behind
 * for explicit deletion, matching updateStaffAgent's ownership rules. */
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
	for (const agent of Object.values(registry.agents)) {
		writeAgentInstructions(root, agent.id, agent.charter);
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
			lifecycleState: "setup",
			createdAt: now,
			updatedAt: now,
		}),
	);
	for (const agent of agents) registry.agents[agent.id] = agent;
	const createdDirectories: string[] = [];
	try {
		for (const agent of agents) {
			writeAgentInstructions(root, agent.id, agent.charter);
			createdDirectories.push(staffAgentDirectoryPath(root, agent.id));
		}
		writeRegistry(root, registry);
	} catch (error) {
		for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	return agents.map(cloneStaffAgent);
}

export function updateStaffAgent(root: string, id: string, update: UpdateStaffAgentInput): StaffAgent {
	const record = update as unknown as Record<string, unknown>;
	if (!exactFields(record, UPDATE_FIELDS) || Object.keys(record).length === 0) {
		throw new Error("Staff agent update is invalid");
	}
	const registry = readRegistry(root);
	const current = withAgentInstructions(root, existingStaffAgent(registry, id));
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
		...(record.model === null
			? { model: undefined }
			: record.model !== undefined
				? { model: modelValue(record.model) }
				: {}),
		updatedAt: new Date().toISOString(),
	};
	if (next.templateId === undefined) delete next.templateId;
	if (next.departmentId === undefined) delete next.departmentId;
	if (next.model === undefined) delete next.model;
	registry.agents[id] = next;
	const previousInstructions = current.charter;
	writeAgentInstructions(root, id, next.charter);
	try {
		writeRegistry(root, registry);
	} catch (error) {
		writeAgentInstructions(root, id, previousInstructions);
		throw error;
	}
	return cloneStaffAgent(next);
}

function setEmploymentStatus(root: string, id: string, status: StaffAgentEmploymentStatus): StaffAgent {
	const registry = readRegistry(root);
	const current = withAgentInstructions(root, existingStaffAgent(registry, id));
	if (current.employmentStatus === status) return cloneStaffAgent(current);
	const next: StaffAgent = {
		...current,
		employmentStatus: status,
		updatedAt: new Date().toISOString(),
	};
	registry.agents[id] = next;
	writeRegistry(root, registry);
	return cloneStaffAgent(next);
}

export function archiveStaffAgent(root: string, id: string): StaffAgent {
	return setEmploymentStatus(root, id, "archived");
}

export function restoreStaffAgent(root: string, id: string): StaffAgent {
	return setEmploymentStatus(root, id, "active");
}

/** Finish conception once the agent has a real responsibility, a usable
 * evidence path, and an explicit recurring-work decision. This state is
 * intentionally separate from employment: archived agents retain it. */
export function activateStaffAgent(root: string, id: string): StaffAgent {
	const registry = readRegistry(root);
	const current = withAgentInstructions(root, existingStaffAgent(registry, id));
	if (current.lifecycleState === "active") return cloneStaffAgent(current);
	const next: StaffAgent = {
		...current,
		lifecycleState: "active",
		updatedAt: new Date().toISOString(),
	};
	registry.agents[id] = next;
	writeRegistry(root, registry);
	return cloneStaffAgent(next);
}

/** Permanently remove a staff definition. Archive is the reversible default;
 * callers offering this operation must separately remove or deliberately
 * retain that agent's trails, artifacts, pending requests, and computer. */
export function deleteStaffAgent(root: string, id: string): StaffAgent {
	const registry = readRegistry(root);
	const current = withAgentInstructions(root, existingStaffAgent(registry, id));
	delete registry.agents[id];
	writeRegistry(root, registry);
	return cloneStaffAgent(current);
}
