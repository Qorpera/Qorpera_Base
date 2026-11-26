import {
	isSurfaceOptionGroupKey,
	isUuid,
	type JsonValue,
	parseSurfaceLayout,
	readSurfaceLayout,
	SURFACE_LAYOUT_PATH,
	SURFACE_LAYOUT_SCHEMA,
	SURFACE_MAX_CHANGE_SUMMARY_CHARS,
	SURFACE_MAX_CHANGE_TITLE_CHARS,
	SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
	type SurfaceLayout,
	type SurfaceLayoutNode,
	type SurfaceStarterKind,
	type SurfaceTab,
	starterSurfaceLayout,
} from "@qorpera/contracts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	relayControlRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import type { SurfacePatchSessionTracker, SurfacePatchToolPort } from "./cloud-surface-tools.ts";

export const STUDIO_COMPOSE_LAYOUT_SCHEMA = "qorpera.studio-compose-layout/v1";

const MAX_OPERATIONS = 32;

export interface ComposeSurfaceLayoutToolOptions {
	readonly sessionId: string;
	readonly starter: SurfaceStarterKind;
	readonly readCurrentLayoutText: (signal: AbortSignal) => Promise<string | null>;
	readonly surfacePatch: SurfacePatchToolPort;
	readonly patchTracker?: SurfacePatchSessionTracker;
}

type LayoutOperation =
	| { readonly op: "add_tab"; readonly tab: Record<string, unknown>; readonly index?: number }
	| { readonly op: "rename_tab"; readonly tabId: string; readonly title: string }
	| { readonly op: "remove_tab"; readonly tabId: string }
	| { readonly op: "reorder_tabs"; readonly tabIds: readonly string[] }
	| {
			readonly op: "add_block";
			readonly tabId: string;
			readonly block: Record<string, unknown>;
			readonly index?: number;
	  }
	| {
			readonly op: "update_block";
			readonly tabId: string;
			readonly blockId?: string;
			readonly index?: number;
			readonly block: Record<string, unknown>;
	  }
	| { readonly op: "remove_block"; readonly tabId: string; readonly blockId?: string; readonly index?: number }
	| { readonly op: "reorder_blocks"; readonly tabId: string; readonly order: readonly number[] };

interface ComposeLayoutArgs {
	readonly operations: readonly LayoutOperation[];
	readonly title: string;
	readonly summary: string;
	readonly changeId?: string;
	readonly createNew: boolean;
	readonly optionGroup?: string;
	readonly optionGroupTitle?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new CloudToolArgumentRefusal(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function parseOptionalIndex(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new CloudToolArgumentRefusal(`${label} must be a non-negative integer`);
	}
	return value;
}

function parseOperation(raw: unknown, at: number): LayoutOperation {
	const prefix = `operations[${at}]`;
	if (!isPlainRecord(raw) || typeof raw.op !== "string") {
		throw new CloudToolArgumentRefusal(`${prefix} must be an object with an op field`);
	}
	switch (raw.op) {
		case "add_tab": {
			if (!isPlainRecord(raw.tab)) {
				throw new CloudToolArgumentRefusal(`${prefix}.tab must be an object with id, title, and optional blocks`);
			}
			const index = parseOptionalIndex(raw.index, `${prefix}.index`);
			return { op: "add_tab", tab: raw.tab, ...(index !== undefined ? { index } : {}) };
		}
		case "rename_tab":
			return {
				op: "rename_tab",
				tabId: requireNonEmptyString(raw.tabId, `${prefix}.tabId`),
				title: requireNonEmptyString(raw.title, `${prefix}.title`),
			};
		case "remove_tab":
			return { op: "remove_tab", tabId: requireNonEmptyString(raw.tabId, `${prefix}.tabId`) };
		case "reorder_tabs": {
			if (
				!Array.isArray(raw.tabIds) ||
				raw.tabIds.length === 0 ||
				!raw.tabIds.every((id) => typeof id === "string" && id.trim().length > 0)
			) {
				throw new CloudToolArgumentRefusal(`${prefix}.tabIds must be a non-empty array of tab IDs`);
			}
			return { op: "reorder_tabs", tabIds: raw.tabIds.map((id) => id.trim()) };
		}
		case "add_block": {
			if (!isPlainRecord(raw.block)) {
				throw new CloudToolArgumentRefusal(`${prefix}.block must be a valid Studio block or row object`);
			}
			const index = parseOptionalIndex(raw.index, `${prefix}.index`);
			return {
				op: "add_block",
				tabId: requireNonEmptyString(raw.tabId, `${prefix}.tabId`),
				block: raw.block,
				...(index !== undefined ? { index } : {}),
			};
		}
		case "update_block": {
			if (!isPlainRecord(raw.block)) {
				throw new CloudToolArgumentRefusal(`${prefix}.block must be a valid Studio block or row object`);
			}
			const blockId =
				raw.blockId === undefined ? undefined : requireNonEmptyString(raw.blockId, `${prefix}.blockId`);
			const index = parseOptionalIndex(raw.index, `${prefix}.index`);
			if (blockId === undefined && index === undefined) {
				throw new CloudToolArgumentRefusal(`${prefix} requires either blockId or index`);
			}
			return {
				op: "update_block",
				tabId: requireNonEmptyString(raw.tabId, `${prefix}.tabId`),
				...(blockId !== undefined ? { blockId } : {}),
				...(index !== undefined ? { index } : {}),
				block: raw.block,
			};
		}
		case "remove_block": {
			const blockId =
				raw.blockId === undefined ? undefined : requireNonEmptyString(raw.blockId, `${prefix}.blockId`);
			const index = parseOptionalIndex(raw.index, `${prefix}.index`);
			if (blockId === undefined && index === undefined) {
				throw new CloudToolArgumentRefusal(`${prefix} requires either blockId or index`);
			}
			return {
				op: "remove_block",
				tabId: requireNonEmptyString(raw.tabId, `${prefix}.tabId`),
				...(blockId !== undefined ? { blockId } : {}),
				...(index !== undefined ? { index } : {}),
			};
		}
		case "reorder_blocks": {
			if (
				!Array.isArray(raw.order) ||
				raw.order.length === 0 ||
				!raw.order.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
			) {
				throw new CloudToolArgumentRefusal(`${prefix}.order must be a non-empty array of block indices`);
			}
			return {
				op: "reorder_blocks",
				tabId: requireNonEmptyString(raw.tabId, `${prefix}.tabId`),
				order: [...raw.order],
			};
		}
		default:
			throw new CloudToolArgumentRefusal(
				`${prefix}.op must be one of add_tab, rename_tab, remove_tab, reorder_tabs, add_block, update_block, remove_block, reorder_blocks`,
			);
	}
}

interface MutableTab {
	id: string;
	title: string;
	blocks: unknown[];
}

function cloneToMutableTabs(layout: SurfaceLayout): MutableTab[] {
	return layout.tabs.map((tab: SurfaceTab<SurfaceLayoutNode>) => ({
		id: tab.id,
		title: tab.title,
		blocks: JSON.parse(JSON.stringify(tab.blocks)) as unknown[],
	}));
}

function findTab(tabs: MutableTab[], tabId: string): MutableTab {
	const found = tabs.find((tab) => tab.id === tabId);
	if (!found) {
		throw new CloudToolArgumentRefusal(
			`Tab "${tabId}" does not exist. Existing tabs: ${tabs.map((tab) => tab.id).join(", ")}`,
		);
	}
	return found;
}

function applyOperations(baseLayout: SurfaceLayout, operations: readonly LayoutOperation[]): SurfaceLayout {
	const tabs = cloneToMutableTabs(baseLayout);

	for (const op of operations) {
		switch (op.op) {
			case "add_tab": {
				const rawTab = op.tab;
				const id = requireNonEmptyString(rawTab.id, "add_tab.tab.id");
				const title = requireNonEmptyString(rawTab.title, "add_tab.tab.title");
				const blocks = rawTab.blocks === undefined ? [] : Array.isArray(rawTab.blocks) ? rawTab.blocks : null;
				if (blocks === null) {
					throw new CloudToolArgumentRefusal("add_tab.tab.blocks must be an array");
				}
				if (tabs.some((tab) => tab.id === id)) {
					throw new CloudToolArgumentRefusal(`Tab "${id}" already exists`);
				}
				const insertAt = op.index === undefined ? tabs.length : Math.min(op.index, tabs.length);
				tabs.splice(insertAt, 0, { id, title, blocks: JSON.parse(JSON.stringify(blocks)) as unknown[] });
				break;
			}
			case "rename_tab": {
				const tab = findTab(tabs, op.tabId);
				tab.title = op.title;
				break;
			}
			case "remove_tab": {
				const idx = tabs.findIndex((tab) => tab.id === op.tabId);
				if (idx < 0) {
					throw new CloudToolArgumentRefusal(
						`Tab "${op.tabId}" does not exist. Existing tabs: ${tabs.map((tab) => tab.id).join(", ")}`,
					);
				}
				if (tabs.length <= 1) {
					throw new CloudToolArgumentRefusal("Cannot remove the last remaining tab in the layout");
				}
				tabs.splice(idx, 1);
				break;
			}
			case "reorder_tabs": {
				if (op.tabIds.length !== tabs.length || new Set(op.tabIds).size !== tabs.length) {
					throw new CloudToolArgumentRefusal(
						`reorder_tabs.tabIds must list every existing tab exactly once (${tabs.map((tab) => tab.id).join(", ")})`,
					);
				}
				const byId = new Map(tabs.map((tab) => [tab.id, tab]));
				const next: MutableTab[] = [];
				for (const id of op.tabIds) {
					const found = byId.get(id);
					if (!found) {
						throw new CloudToolArgumentRefusal(`reorder_tabs references unknown tab "${id}"`);
					}
					next.push(found);
				}
				tabs.splice(0, tabs.length, ...next);
				break;
			}
			case "add_block": {
				const tab = findTab(tabs, op.tabId);
				const insertAt = op.index === undefined ? tab.blocks.length : Math.min(op.index, tab.blocks.length);
				tab.blocks.splice(insertAt, 0, JSON.parse(JSON.stringify(op.block)));
				break;
			}
			case "update_block": {
				const tab = findTab(tabs, op.tabId);
				const replacement = JSON.parse(JSON.stringify(op.block));
				if (op.blockId !== undefined) {
					let replaced = false;
					for (let i = 0; i < tab.blocks.length; i += 1) {
						const node = tab.blocks[i];
						if (isPlainRecord(node) && node.id === op.blockId) {
							tab.blocks[i] = replacement;
							replaced = true;
							break;
						}
						if (isPlainRecord(node) && node.type === "row" && Array.isArray(node.blocks)) {
							const childIdx = node.blocks.findIndex((child) => isPlainRecord(child) && child.id === op.blockId);
							if (childIdx >= 0) {
								node.blocks[childIdx] = replacement;
								replaced = true;
								break;
							}
						}
					}
					if (!replaced) {
						throw new CloudToolArgumentRefusal(`No block with id "${op.blockId}" found on tab "${op.tabId}"`);
					}
				} else if (op.index !== undefined) {
					if (op.index >= tab.blocks.length) {
						throw new CloudToolArgumentRefusal(
							`Block index ${op.index} out of range on tab "${op.tabId}" (has ${tab.blocks.length} nodes)`,
						);
					}
					tab.blocks[op.index] = replacement;
				}
				break;
			}
			case "remove_block": {
				const tab = findTab(tabs, op.tabId);
				if (op.blockId !== undefined) {
					let removed = false;
					for (let i = 0; i < tab.blocks.length; i += 1) {
						const node = tab.blocks[i];
						if (isPlainRecord(node) && node.id === op.blockId) {
							tab.blocks.splice(i, 1);
							removed = true;
							break;
						}
						if (isPlainRecord(node) && node.type === "row" && Array.isArray(node.blocks)) {
							const childIdx = node.blocks.findIndex((child) => isPlainRecord(child) && child.id === op.blockId);
							if (childIdx >= 0) {
								node.blocks.splice(childIdx, 1);
								if (node.blocks.length === 1) {
									tab.blocks[i] = node.blocks[0];
								} else if (node.blocks.length === 0) {
									tab.blocks.splice(i, 1);
								}
								removed = true;
								break;
							}
						}
					}
					if (!removed) {
						throw new CloudToolArgumentRefusal(`No block with id "${op.blockId}" found on tab "${op.tabId}"`);
					}
				} else if (op.index !== undefined) {
					if (op.index >= tab.blocks.length) {
						throw new CloudToolArgumentRefusal(
							`Block index ${op.index} out of range on tab "${op.tabId}" (has ${tab.blocks.length} nodes)`,
						);
					}
					tab.blocks.splice(op.index, 1);
				}
				break;
			}
			case "reorder_blocks": {
				const tab = findTab(tabs, op.tabId);
				if (
					op.order.length !== tab.blocks.length ||
					new Set(op.order).size !== tab.blocks.length ||
					op.order.some((idx) => idx < 0 || idx >= tab.blocks.length)
				) {
					throw new CloudToolArgumentRefusal(
						`reorder_blocks.order must be a permutation of 0..${Math.max(0, tab.blocks.length - 1)} on tab "${op.tabId}"`,
					);
				}
				tab.blocks = op.order.map((idx) => tab.blocks[idx]);
				break;
			}
		}
	}

	try {
		return parseSurfaceLayout({ schema: SURFACE_LAYOUT_SCHEMA, tabs });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CloudToolArgumentRefusal(`Resulting layout.json is invalid: ${message}`);
	}
}

function countLayoutBlocks(layout: SurfaceLayout): number {
	let count = 0;
	for (const tab of layout.tabs) {
		for (const node of tab.blocks) {
			count += node.type === "row" ? node.blocks.length : 1;
		}
	}
	return count;
}

export function createComposeSurfaceLayoutTool(options: ComposeSurfaceLayoutToolOptions): CloudNativeTool {
	const parseArgs = (value: unknown): ComposeLayoutArgs => {
		const allowed = ["operations", "title", "summary", "changeId", "createNew", "optionGroup", "optionGroupTitle"];
		if (
			!isPlainRecord(value) ||
			Object.keys(value).some((key) => !allowed.includes(key)) ||
			!Array.isArray(value.operations) ||
			value.operations.length === 0 ||
			value.operations.length > MAX_OPERATIONS
		) {
			throw new CloudToolArgumentRefusal(
				`compose_surface_layout takes operations (1..${MAX_OPERATIONS} layout ops) plus optional title, summary, changeId, createNew, optionGroup, and optionGroupTitle`,
			);
		}
		const operations = value.operations.map((entry, idx) => parseOperation(entry, idx));
		const title =
			value.title === undefined
				? "Update page layout"
				: typeof value.title === "string" &&
						value.title.trim().length > 0 &&
						value.title.trim().length <= SURFACE_MAX_CHANGE_TITLE_CHARS
					? value.title.trim()
					: null;
		if (title === null) {
			throw new CloudToolArgumentRefusal(`title must be 1..${SURFACE_MAX_CHANGE_TITLE_CHARS} characters`);
		}
		const summary =
			value.summary === undefined
				? `Updated page layout (${operations.length} change${operations.length === 1 ? "" : "s"}).`
				: typeof value.summary === "string" &&
						value.summary.trim().length > 0 &&
						value.summary.trim().length <= SURFACE_MAX_CHANGE_SUMMARY_CHARS
					? value.summary.trim()
					: null;
		if (summary === null) {
			throw new CloudToolArgumentRefusal(`summary must be 1..${SURFACE_MAX_CHANGE_SUMMARY_CHARS} characters`);
		}
		const changeId =
			value.changeId === undefined
				? undefined
				: typeof value.changeId === "string" && isUuid(value.changeId.trim())
					? value.changeId.trim().toLowerCase()
					: null;
		if (changeId === null) {
			throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
		}
		const createNew =
			value.createNew === undefined ? false : typeof value.createNew === "boolean" ? value.createNew : null;
		if (createNew === null) {
			throw new CloudToolArgumentRefusal("createNew must be a boolean");
		}
		if (changeId && createNew) {
			throw new CloudToolArgumentRefusal(
				"Pass either changeId to update an existing change in place or createNew: true to add a separate new change, not both.",
			);
		}
		const optionGroup =
			value.optionGroup === undefined
				? undefined
				: typeof value.optionGroup === "string" && isSurfaceOptionGroupKey(value.optionGroup.trim())
					? value.optionGroup.trim()
					: null;
		if (optionGroup === null) {
			throw new CloudToolArgumentRefusal("optionGroup must be a lowercase slug");
		}
		const optionGroupTitle =
			value.optionGroupTitle === undefined
				? undefined
				: typeof value.optionGroupTitle === "string" &&
						value.optionGroupTitle.trim().length > 0 &&
						value.optionGroupTitle.trim().length <= SURFACE_MAX_OPTION_GROUP_TITLE_CHARS
					? value.optionGroupTitle.trim()
					: null;
		if (optionGroupTitle === null) {
			throw new CloudToolArgumentRefusal(
				`optionGroupTitle must be 1..${SURFACE_MAX_OPTION_GROUP_TITLE_CHARS} characters`,
			);
		}
		if (optionGroupTitle && !optionGroup) {
			throw new CloudToolArgumentRefusal("optionGroupTitle requires optionGroup");
		}
		return {
			operations,
			title,
			summary,
			...(changeId ? { changeId } : {}),
			createNew,
			...(optionGroup ? { optionGroup } : {}),
			...(optionGroupTitle ? { optionGroupTitle } : {}),
		};
	};

	return {
		name: "compose_surface_layout" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: [
			"Surgically compose or reshape this Studio surface's layout (tabs, rows, and blocks including chart, artifacts, explainer, report, plays, economics, hypotheses, landscape, facts, table, cards, and module) without hand-editing the full layout JSON.",
			"Applies an ordered list of operations (add_tab, rename_tab, remove_tab, reorder_tabs, add_block, update_block, remove_block, reorder_blocks), validates strictly against the Studio layout contract, and stages the resulting layout.json in Preview.",
		].join("\n"),
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operations"],
			properties: {
				operations: {
					type: "array",
					minItems: 1,
					maxItems: MAX_OPERATIONS,
					description:
						"Ordered mutations: add_tab {op,tab,index?}, rename_tab {op,tabId,title}, remove_tab {op,tabId}, reorder_tabs {op,tabIds}, add_block {op,tabId,block,index?}, update_block {op,tabId,blockId?,index?,block}, remove_block {op,tabId,blockId?,index?}, reorder_blocks {op,tabId,order}.",
					items: { type: "object" },
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_TITLE_CHARS,
					description: "Short founder-facing change title shown in Changes.",
				},
				summary: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_SUMMARY_CHARS,
					description: "Concise founder-facing summary of what moved or was added.",
				},
				changeId: {
					type: "string",
					description: "Optional open change UUID to update in place.",
				},
				createNew: {
					type: "boolean",
					description:
						"Set true when intentionally staging a separate new change alongside existing open changes in this session.",
				},
				optionGroup: {
					type: "string",
					description: "Optional option-group slug for competing layout directions.",
				},
				optionGroupTitle: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
					description: "Optional option-group heading shown in Changes.",
				},
			},
		},
		parseArguments(value) {
			const args = parseArgs(value);
			const targetChangeId = options.patchTracker
				? options.patchTracker.resolveTargetChangeId({
						explicitChangeId: args.changeId ?? null,
						createNew: args.createNew,
						optionGroup: args.optionGroup ?? null,
					})
				: (args.changeId ?? null);
			return {
				operations: args.operations as unknown as JsonValue,
				title: args.title,
				summary: args.summary,
				...(targetChangeId ? { changeId: targetChangeId } : {}),
				...(args.createNew ? { createNew: true } : {}),
				...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
				...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
			};
		},
		async execute(rawArgs, context: CloudToolContext) {
			const args = parseArgs(rawArgs);
			const targetChangeId = options.patchTracker
				? options.patchTracker.resolveTargetChangeId({
						explicitChangeId: args.changeId ?? null,
						createNew: args.createNew,
						optionGroup: args.optionGroup ?? null,
					})
				: (args.changeId ?? null);
			let currentText: string | null;
			try {
				currentText = await options.readCurrentLayoutText(context.signal);
			} catch (error) {
				if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				throw new CloudToolRefusal(
					"LAYOUT_READ_FAILED: could not read the current layout.json; nothing was staged so existing tabs are not overwritten.",
				);
			}
			let baseLayout: SurfaceLayout;
			if (currentText !== null) {
				const read = readSurfaceLayout(currentText);
				if ("problem" in read) {
					throw new CloudToolRefusal(
						`CURRENT_LAYOUT_INVALID: existing layout.json could not be parsed (${read.problem}); repair it with stage_surface_patch first.`,
					);
				}
				try {
					baseLayout = parseSurfaceLayout(JSON.parse(currentText));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new CloudToolRefusal(
						`CURRENT_LAYOUT_INVALID: existing layout.json has unsupported blocks (${message}); repair it with stage_surface_patch first.`,
					);
				}
			} else {
				baseLayout = starterSurfaceLayout(options.starter);
			}

			const nextLayout = applyOperations(baseLayout, args.operations);
			const formatted = `${JSON.stringify(nextLayout, null, "\t")}\n`;
			const ops = [{ op: "write_text" as const, path: SURFACE_LAYOUT_PATH, content: formatted }];
			let staged: { readonly changeId: string; readonly seq: number; readonly updated?: boolean };
			try {
				staged = await options.surfacePatch.stageSurfacePatch(
					options.sessionId,
					{
						title: args.title,
						summary: args.summary,
						ops,
						notePaths: [],
						finishSession: false,
						...(targetChangeId ? { changeId: targetChangeId } : {}),
						...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
						...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
					},
					context,
				);
			} catch (error) {
				relayControlRefusal(error);
			}
			options.patchTracker?.recordStaged({
				targetChangeId,
				resultChangeId: staged.changeId,
				ops,
				optionGroup: args.optionGroup ?? null,
			});
			const answer: Record<string, JsonValue> = {
				schema: STUDIO_COMPOSE_LAYOUT_SCHEMA,
				ok: true,
				changeId: staged.changeId,
				seq: staged.seq,
				...(staged.updated === true ? { updated: true } : {}),
				tabs: nextLayout.tabs.map((tab) => ({
					id: tab.id,
					title: tab.title,
					nodes: tab.blocks.length,
				})),
				blockCount: countLayoutBlocks(nextLayout),
				next: "Layout staged for Preview. Call inspect_surface to verify how the page looks.",
			};
			return { kind: "text", value: cloudToolJsonText(answer) };
		},
	};
}
