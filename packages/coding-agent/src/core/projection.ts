/**
 * Company UI projection contract.
 *
 * Projection nodes describe only what the founder can navigate. They do not
 * describe, discover, or constrain the company's files, schemas, routines,
 * tools, integrations, or organizational ontology.
 */

export const PROJECTION_SCHEMA = "qorpera.projection/v1";

export type ProjectionBuiltinId =
	| "qorpera.inbox"
	| "qorpera.activity"
	| "qorpera.chats"
	| "qorpera.product-chat"
	| "qorpera.pull-requests"
	| "qorpera.placeholder";

export interface ProjectionSurfaceView {
	type: "surface";
	entry: string;
	version?: number;
}

export interface ProjectionBuiltinView {
	type: "builtin";
	id: ProjectionBuiltinId;
	context?: Record<string, string>;
}

export interface ProjectionDepartmentNode {
	id: string;
	kind: "department";
	label: string;
	description?: string;
	items: string[];
}

export interface ProjectionCategoryNode {
	id: string;
	kind: "category";
	label: string;
	description?: string;
	items: string[];
}

export interface ProjectionPageNode {
	id: string;
	kind: "page";
	label: string;
	description?: string;
	view: ProjectionSurfaceView | ProjectionBuiltinView;
}

export type ProjectionNode = ProjectionDepartmentNode | ProjectionCategoryNode | ProjectionPageNode;

export interface ProjectionDocument {
	schema: typeof PROJECTION_SCHEMA;
	default?: string;
	navigation: string[];
	nodes: ProjectionNode[];
}

export interface ProjectionState extends ProjectionDocument {
	diagnostics: string[];
}

const NODE_ID = /^[a-z][a-z0-9]*(?::[a-z0-9][a-z0-9._-]*)+$/;
const BUILTIN_IDS: ReadonlySet<string> = new Set<ProjectionBuiltinId>([
	"qorpera.inbox",
	"qorpera.activity",
	"qorpera.chats",
	"qorpera.product-chat",
	"qorpera.pull-requests",
	"qorpera.placeholder",
]);
const PLATFORM_NODE_IDS: ReadonlySet<string> = new Set(["q:main", "q:inbox", "q:activity", "q:chats"]);

function strings(value: unknown, field: string, diagnostics: string[]): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		diagnostics.push(`${field} must be an array of node IDs`);
		return [];
	}
	return value;
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function validId(value: unknown, field: string, diagnostics: string[]): value is string {
	if (typeof value !== "string" || !NODE_ID.test(value) || value.startsWith("q:")) {
		diagnostics.push(`${field} must be a stable namespaced ID outside the reserved q: namespace`);
		return false;
	}
	return true;
}

function parseNode(value: unknown, index: number, diagnostics: string[]): ProjectionNode | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(`nodes[${index}] must be an object`);
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	if (!validId(raw.id, `nodes[${index}].id`, diagnostics)) return undefined;
	const label = optionalText(raw.label);
	if (!label) {
		diagnostics.push(`node ${raw.id} requires a label`);
		return undefined;
	}
	const description = optionalText(raw.description);
	if (raw.kind === "department" || raw.kind === "category") {
		return {
			id: raw.id,
			kind: raw.kind,
			label: label.slice(0, 120),
			...(description ? { description } : {}),
			items: strings(raw.items, `node ${raw.id}.items`, diagnostics),
		};
	}
	if (raw.kind !== "page") {
		diagnostics.push(`node ${raw.id} has unsupported kind ${String(raw.kind)}`);
		return undefined;
	}
	if (!raw.view || typeof raw.view !== "object" || Array.isArray(raw.view)) {
		diagnostics.push(`page ${raw.id} requires a view`);
		return undefined;
	}
	const view = raw.view as Record<string, unknown>;
	if (view.type === "surface") {
		if (typeof view.entry !== "string" || !view.entry.trim()) {
			diagnostics.push(`surface page ${raw.id} requires an entry`);
			return undefined;
		}
		return {
			id: raw.id,
			kind: "page",
			label: label.slice(0, 120),
			...(description ? { description } : {}),
			view: { type: "surface", entry: view.entry },
		};
	}
	if (view.type !== "builtin" || typeof view.id !== "string" || !BUILTIN_IDS.has(view.id)) {
		diagnostics.push(`page ${raw.id} requires a supported surface or builtin view`);
		return undefined;
	}
	let context: Record<string, string> | undefined;
	if (view.context !== undefined) {
		if (
			!view.context ||
			typeof view.context !== "object" ||
			Array.isArray(view.context) ||
			Object.values(view.context).some((entry) => typeof entry !== "string")
		) {
			diagnostics.push(`builtin page ${raw.id} context must contain string values`);
			return undefined;
		}
		context = view.context as Record<string, string>;
	}
	return {
		id: raw.id,
		kind: "page",
		label: label.slice(0, 120),
		...(description ? { description } : {}),
		view: { type: "builtin", id: view.id as ProjectionBuiltinId, ...(context ? { context } : {}) },
	};
}

/** Parse and validate one complete company-authored projection document. */
export function parseProjectionDocument(value: unknown): ProjectionState {
	const diagnostics: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { schema: PROJECTION_SCHEMA, navigation: [], nodes: [], diagnostics: ["projection must be an object"] };
	}
	const raw = value as Record<string, unknown>;
	if (raw.schema !== PROJECTION_SCHEMA) diagnostics.push(`schema must be ${PROJECTION_SCHEMA}`);
	let nodes: ProjectionNode[] = [];
	if (Array.isArray(raw.nodes)) {
		nodes = raw.nodes.flatMap((node, index) => {
			const parsed = parseNode(node, index, diagnostics);
			return parsed ? [parsed] : [];
		});
	} else {
		diagnostics.push("nodes must be an array");
	}
	const byId = new Map<string, ProjectionNode>();
	for (const node of nodes) {
		if (byId.has(node.id)) diagnostics.push(`duplicate node ID ${node.id}`);
		else byId.set(node.id, node);
	}
	const navigation = strings(raw.navigation, "navigation", diagnostics).filter((id) => {
		const node = byId.get(id);
		if (node?.kind === "department") return true;
		diagnostics.push(`navigation target ${id} must reference a department`);
		return false;
	});
	for (const node of nodes) {
		if (node.kind === "page") continue;
		for (const childId of node.items) {
			const child = byId.get(childId);
			if (!child) diagnostics.push(`${node.id} references missing node ${childId}`);
			else if (node.kind === "department" && child.kind === "department") {
				diagnostics.push(`department ${node.id} cannot contain department ${childId}`);
			} else if (node.kind === "category" && child.kind !== "page") {
				diagnostics.push(`category ${node.id} may contain pages only`);
			}
		}
	}
	const defaultId = typeof raw.default === "string" ? raw.default : undefined;
	if (defaultId && !byId.has(defaultId) && !PLATFORM_NODE_IDS.has(defaultId)) {
		diagnostics.push(`default target ${defaultId} does not exist`);
	}
	return {
		schema: PROJECTION_SCHEMA,
		...(defaultId && (byId.has(defaultId) || PLATFORM_NODE_IDS.has(defaultId)) ? { default: defaultId } : {}),
		navigation,
		nodes: [...byId.values()],
		diagnostics,
	};
}

export const EMPTY_PROJECTION: ProjectionDocument = {
	schema: PROJECTION_SCHEMA,
	default: "q:chats",
	navigation: [],
	nodes: [],
};

export const PLATFORM_PROJECTION_NODES: ProjectionNode[] = [
	{ id: "q:main", kind: "department", label: "Main", items: ["q:inbox", "q:activity", "q:chats"] },
	{ id: "q:inbox", kind: "page", label: "Inbox", view: { type: "builtin", id: "qorpera.inbox" } },
	{ id: "q:activity", kind: "page", label: "Activity", view: { type: "builtin", id: "qorpera.activity" } },
	{ id: "q:chats", kind: "page", label: "Chats", view: { type: "builtin", id: "qorpera.chats" } },
];
