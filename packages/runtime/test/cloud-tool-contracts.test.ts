import {
	APP_FILE_MAX_BYTES,
	APP_MAX_BYTES,
	APP_VIDEO_FILE_MAX_BYTES,
	APP_VIDEOS_MAX_BYTES,
} from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import { CLOUD_AGENT_SEND_INSTRUCTIONS } from "@qorpera/runtime/cloud-agent-mouth";
import { cloudCodeTools } from "@qorpera/runtime/cloud-code-tools";
import { cloudDataTools } from "@qorpera/runtime/cloud-data-tools";
import { cloudEventTools } from "@qorpera/runtime/cloud-event-tools";
import { cloudAppGroupsTool } from "@qorpera/runtime/cloud-folder-app-groups";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import { cloudInterfaceTools } from "@qorpera/runtime/cloud-folder-interface-tools";
import { cloudInterfaceWriteTools } from "@qorpera/runtime/cloud-folder-interface-writes";
import { cloudPictureTool } from "@qorpera/runtime/cloud-folder-picture-tool";
import { cloudWallTools } from "@qorpera/runtime/cloud-folder-wall";
import { cloudGoodWillTools } from "@qorpera/runtime/cloud-good-will-tools";
import { cloudHiringTools } from "@qorpera/runtime/cloud-hiring-tools";
import { cloudMachineTools } from "@qorpera/runtime/cloud-machine-tools";
import { cloudMemberOfferTools } from "@qorpera/runtime/cloud-member-offer-tools";
import { cloudMemoryTools } from "@qorpera/runtime/cloud-memory-tools";
import { cloudCompanyContextTool, parseCloudNativeCompanyContext } from "@qorpera/runtime/cloud-native-company-context";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import type { CloudNativeTool } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudPictureChannel } from "@qorpera/runtime/cloud-picture-channel";
import { cloudReviewRuleTools } from "@qorpera/runtime/cloud-review-rule-tools";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "@qorpera/runtime/cloud-routine-tools";
import { cloudSidebarTools } from "@qorpera/runtime/cloud-sidebar-tools";
import { cloudSiteTools } from "@qorpera/runtime/cloud-site-tools";
import { cloudSkillTools } from "@qorpera/runtime/cloud-skill-tools";
import {
	CLOUD_ASK_MEMBER_BODY_MAX_BYTES,
	CLOUD_ASK_MEMBER_BODY_MAX_LINES,
	CLOUD_ASK_MEMBER_INPUT_SCHEMA,
	CLOUD_ASK_MEMBER_LABEL_MAX_BYTES,
	CLOUD_ASK_MEMBER_LINE_MAX_BYTES,
	cloudAskMemberInstructions,
} from "@qorpera/runtime/cloud-thread-interactions";
import { cloudCoworkerMessageTool } from "@qorpera/runtime/cloud-wake-bus";
import { cloudWorkerTools } from "@qorpera/runtime/cloud-worker-tools";
import { expect, it } from "vitest";
import { nativeCompanyContextFixture } from "./fixtures/native-company-context-fixture.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

// Track 3, T3-5 (14 November 2026): a tool's description is its contract. These tests hold what its words say against
// the code: every bound it names, the room Codex leaves for field descriptions, and the rules that are every tool's
// and so are said once, in the instructions.

/** A stand-in for every outside part a tool factory keeps; nothing here calls a tool. */
function standIn(): never {
	const target = () => undefined;
	return new Proxy(target, {
		get(_target, key) {
			if (key === "then") return undefined;
			if (key === Symbol.iterator) return function* () {};
			if (key === Symbol.toPrimitive || key === "toString") return () => "stand-in";
			return standIn();
		},
		apply: () => standIn(),
		construct: () => standIn(),
	}) as never;
}

/** The tools of a Co-Founder's company run on a host with machines and company databases, and of its worker, made by
 * the runtime's own factories (as the company runtime composes them). */
async function catalogs() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const identity = run.identity;
	const actor = { runId: identity.runId.toLowerCase() };
	const folder = new Proxy(standIn() as object, {
		get: (target, key) => (key === "actor" ? actor : (target as Record<string | symbol, unknown>)[key]),
	}) as never;
	const operations = standIn();
	const f = nativeCompanyContextFixture();
	const context = parseCloudNativeCompanyContext(f.context, f.binding);
	const place = { core: "folder-v2", handle: "alice" } as const;
	const shared = (worker: boolean): CloudNativeTool[] => [
		...cloudFolderFileTools({ folder, operations, identity }),
		...cloudInterfaceTools({ folder, identity, timeZone: "UTC" }),
		...cloudInterfaceWriteTools({ folder, operations, identity }),
		...cloudAppTools({ folder, operations, identity }),
		cloudPictureTool({ folder, operations, identity, pictures: new CloudPictureChannel() }),
		...cloudDataTools({ folder, door: standIn(), apply: !worker }),
		cloudCompanyContextTool(context, f.binding, standIn()),
		...cloudMachineTools({
			binding,
			identity,
			control: standIn(),
			operations,
			gateway: standIn(),
			worker,
			codingValues: standIn(),
		}),
		...cloudMemoryTools(standIn(), identity, place),
		...cloudSkillTools(standIn(), identity, place),
	];
	const member = { kind: "human", source: { kind: "input", id: identity.runId, occurrenceKey: "input:1" } } as never;
	const dispatch = {
		kind: "agent",
		source: { kind: "worker-dispatch", id: identity.runId, occurrenceKey: "worker-dispatch:1" },
	} as never;
	const staff = [
		...shared(false),
		...cloudWallTools({ folder, operations, identity, handle: "alice", timeZone: "UTC" }),
		cloudCoworkerMessageTool(binding, identity, standIn()),
		...cloudRoutineTools(binding, identity, undefined, standIn()),
		cloudRoutineDecisionTool(binding, identity, {
			decisionOwed: () => true,
			decided: () => {},
			folderDecision: standIn(),
		}),
		...cloudSidebarTools(binding, identity, { folderSidebar: standIn() }),
		cloudAppGroupsTool({ folder, operations, identity }),
		...cloudReviewRuleTools(binding, identity, standIn()),
		...cloudGoodWillTools(binding, identity, standIn()),
		...cloudMemberOfferTools(binding, identity, standIn()),
		...cloudEventTools(binding, identity, standIn(), folder),
		...cloudSiteTools({
			binding,
			identity,
			control: standIn(),
			folder,
			machines: { gateway: standIn(), operations },
		}),
		...cloudHiringTools(identity, { folderHiring: standIn(), folderGroupChats: standIn() }),
		...cloudWorkerTools(binding, identity, member, {
			machines: true,
			folderTodos: standIn(),
			folderWorkers: standIn(),
		}),
		...cloudCodeTools({ folder, identity }),
		{
			name: "send_message",
			description: CLOUD_AGENT_SEND_INSTRUCTIONS,
			inputSchema: {},
		} as unknown as CloudNativeTool,
		{
			name: "ask_member",
			description: cloudAskMemberInstructions(false),
			inputSchema: CLOUD_ASK_MEMBER_INPUT_SCHEMA,
		} as unknown as CloudNativeTool,
	];
	const worker = [
		...shared(true),
		...cloudWorkerTools(binding, identity, dispatch, {
			machines: true,
			folderTodos: standIn(),
			folderWorkers: standIn(),
		}),
	];
	return { staff, worker, all: [...staff, ...worker] };
}

type Schema = { [key: string]: JsonValue };

/** A schema as Codex sends it to the model (T3-5's probe of the patched Codex 9c299f88): bounds, patterns, formats and
 * uniqueItems dropped, a const sent as a one-value enum. */
function asSent(schema: JsonValue): JsonValue {
	if (Array.isArray(schema)) return schema.map(asSent);
	if (!schema || typeof schema !== "object") return schema;
	const sent: Schema = {};
	for (const [key, value] of Object.entries(schema)) {
		if (
			["minimum", "maximum", "minLength", "maxLength", "maxItems", "pattern", "format", "uniqueItems"].includes(key)
		)
			continue;
		if (key === "const") sent.enum = [value];
		else
			sent[key] =
				key === "properties"
					? Object.fromEntries(Object.entries(value as Schema).map(([k, v]) => [k, asSent(v)]))
					: asSent(value);
	}
	return sent;
}

/** Each property of a schema with its path, its own schema and its description. */
function* fields(schema: JsonValue, path: string): Generator<{ path: string; schema: Schema }> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
	const node = schema as Schema;
	for (const [name, child] of Object.entries((node.properties as Schema | undefined) ?? {})) {
		yield { path: `${path}.${name}`, schema: child as Schema };
		yield* fields(child, `${path}.${name}`);
		yield* fields((child as Schema).items ?? null, `${path}.${name}[]`);
	}
	for (const [index, branch] of [
		...((node.oneOf as JsonValue[]) ?? []),
		...((node.anyOf as JsonValue[]) ?? []),
	].entries())
		yield* fields(branch, `${path}|${index}`);
}

/** The fewest and most characters a field's pattern lets through, for the three forms the tools use: one first
 * character and a {a,b} tail; one first character, then an optional {a,b} middle and a last character; a first
 * character, a {a,b} middle and a last character. */
function patternBounds(pattern: string): [number, number] | undefined {
	const tail = /^\^\[[^\]]+\]\[[^\]]+\]\{(\d+),(\d+)\}\$$/.exec(pattern);
	if (tail) return [Number(tail[1]) + 1, Number(tail[2]) + 1];
	const optional = /^\^\[[^\]]+\]\(\[[^\]]+\]\{\d+,(\d+)\}\[[^\]]+\]\)\?\$$/.exec(pattern);
	if (optional) return [1, Number(optional[1]) + 2];
	const middle = /^\^\[[^\]]+\]\[[^\]]+\]\{(\d+),(\d+)\}\[[^\]]+\]\$$/.exec(pattern);
	if (middle) return [Number(middle[1]) + 2, Number(middle[2]) + 2];
	return undefined;
}

/** A field whose words name several bounds at once, checked one by one in the next test. */
const COMPOSITE = new Set(["ask_member.body"]);

it("says every bound a field's description names as the field's schema holds it", async () => {
	const { all } = await catalogs();
	const number = (text: string) => Number(text.replaceAll(",", ""));
	// A number of words, pixels or seconds, or a file's size, is no bound of the field's own.
	const notOwn = "(?! ?(?:words|MB|MiB|KB|KiB|GB|px|pixels|seconds|minutes|days)\\b)";
	let checked = 0;
	for (const tool of all)
		for (const { path, schema } of fields(tool.inputSchema, tool.name)) {
			// save_app's fields never reach the model (its schema is past Codex's 5,000 bytes); their numbers are its kits'.
			if (schema.type === "object" || COMPOSITE.has(path) || tool.name === "save_app") continue;
			const words = typeof schema.description === "string" ? schema.description : "";
			const range = new RegExp(`\\b(\\d[\\d,]*) to (\\d[\\d,]*)\\b${notOwn}`).exec(words);
			const most = new RegExp(`\\b(?:at most|up to) (\\d[\\d,]*)\\b${notOwn}`, "i").exec(words);
			if (!range && !most) continue;
			const pattern = typeof schema.pattern === "string" ? patternBounds(schema.pattern) : undefined;
			const top =
				(schema.maxLength as number | undefined) ??
				(schema.maxItems as number | undefined) ??
				(schema.maximum as number | undefined) ??
				pattern?.[1];
			expect(top, `${path} names a bound: ${words}`).toBeDefined();
			if (range) {
				expect(top, path).toBe(number(range[2]));
				const bottom =
					(schema.minLength as number | undefined) ??
					(schema.minItems as number | undefined) ??
					(schema.minimum as number | undefined) ??
					pattern?.[0] ??
					1;
				expect(bottom, path).toBe(number(range[1]));
			} else if (most) expect(top, path).toBe(number(most[1]));
			checked++;
		}
	expect(checked).toBeGreaterThanOrEqual(20);
});

it("says the bounds in a description's own words as the code holds them", async () => {
	const { all } = await catalogs();
	const tool = (name: string) => {
		const found = all.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`no ${name}`);
		return found;
	};
	const property = (name: string, ...path: string[]) => {
		let node = tool(name).inputSchema as Schema;
		for (const step of path) node = (step === "[]" ? node.items : (node.properties as Schema)[step]) as Schema;
		return node;
	};
	const said = (name: string, words: string) => expect(tool(name).description, name).toContain(words);
	// ask_member's card, as the readability check refuses it.
	expect(property("ask_member", "body").description).toContain(
		`At most ${CLOUD_ASK_MEMBER_BODY_MAX_LINES} short lines of at most ${CLOUD_ASK_MEMBER_LINE_MAX_BYTES} bytes, ${CLOUD_ASK_MEMBER_BODY_MAX_BYTES} in all`,
	);
	expect(JSON.stringify(CLOUD_ASK_MEMBER_INPUT_SCHEMA)).toContain(
		`(at most ${CLOUD_ASK_MEMBER_LABEL_MAX_BYTES} bytes)`,
	);
	// save_app's sizes, from the folder's own constants.
	said(
		"save_app",
		`each at most ${APP_FILE_MAX_BYTES / 1024} KiB; pages and code ${APP_MAX_BYTES / 1024 / 1024} MiB in all`,
	);
	said(
		"save_app",
		`${APP_VIDEO_FILE_MAX_BYTES / 1024 / 1024} MiB each, ${APP_VIDEOS_MAX_BYTES / 1024 / 1024} MiB in all`,
	);
	said("save_app", `files: at most ${property("save_app", "files").maxItems} a call`);
	// The file tools' pages and lists.
	said("company_read", `at most ${property("company_read", "limit").maximum}, the default`);
	said("company_read", `paths (up to ${property("company_read", "paths").maxItems})`);
	said("company_list", `limit entries a call (1 to ${property("company_list", "limit").maximum}`);
	said("company_list", `depth levels (1 to ${property("company_list", "depth").maximum}`);
	said("company_write", `up to ${(property("company_write", "text").maxLength as number) / 1024} KiB`);
	// Machines.
	said("machine_read", `limit (4 to ${property("machine_read", "limit").maximum})`);
	// Mail and hooks.
	said("send_mail", `to at most ${property("send_mail", "to").maxItems} addresses`);
	said("send_mail", `(at most ${property("send_mail", "attachments").maxItems}, together at most 28 MiB)`);
	said("find_mail", `waitSeconds (up to ${property("find_mail", "waitSeconds").maximum})`);
	// Worker tools.
	expect(tool("manage_worker").description).toContain("four per continuation");
	expect(property("manage_worker", "sources").maxItems).toBe(8);
	// Routines.
	expect(property("manage_routine", "trigger").oneOf).toBeDefined();
	said("manage_routine", "each run gets up to 20 new events");
	const event = (
		(property("manage_routine", "trigger").oneOf as Schema[]).find(
			(branch) => ((branch.properties as Schema).kind as Schema).const === "event",
		)?.properties as Schema
	).only as Schema;
	expect(event.maxItems).toBe(20);
	// Sites.
	expect(property("publish_site", "slug").description).toContain("3 to 48");
	expect(new RegExp(property("publish_site", "slug").pattern as string).test("a".repeat(48))).toBe(true);
	expect(new RegExp(property("publish_site", "slug").pattern as string).test("a".repeat(49))).toBe(false);
	expect(new RegExp(property("publish_site", "slug").pattern as string).test("aa")).toBe(false);
});

it("keeps every schema small enough that Codex sends its field descriptions, save_app's aside", async () => {
	// Codex sends no field description at all for a tool whose schema, as it sends it, is 5,000 bytes or more (T3-5's
	// probe: 4,991 kept them, 5,011 lost them). save_app's schema holds its kits' guides and is far past it: none of those
	// reach the model, which is why its own description carries what it needs.
	const { all } = await catalogs();
	for (const tool of all) {
		const bytes = Buffer.byteLength(JSON.stringify(asSent(tool.inputSchema as JsonValue)));
		if (tool.name === "save_app") expect(bytes).toBeGreaterThan(5000);
		else expect(bytes, tool.name).toBeLessThanOrEqual(4600);
	}
});

it("writes every description as a contract: short, in lines, and without the rules every tool shares", async () => {
	const { all } = await catalogs();
	for (const tool of all) {
		const words = tool.description;
		// Room is left: no description is squeezed against the 4,096-byte bound.
		expect(Buffer.byteLength(words), tool.name).toBeLessThanOrEqual(tool.name === "save_app" ? 4096 : 3600);
		// What every tool shares is said once, in the instructions (lanes/agent-instructions-20261113/t3-5/MOVED-TO-CORE.md).
		expect(words, tool.name).not.toMatch(/Keep operationKey (?:stable|for the same)/);
		expect(words, tool.name).not.toMatch(/untrusted data|never instructions to you/);
		expect(words, tool.name).not.toMatch(/until nextCursor is null/);
		expect(words, tool.name).not.toMatch(/do not wait or poll/);
		// A description of more than two sentences is in lines, not one block.
		if (Buffer.byteLength(words) > 1200) expect(words, tool.name).toContain("\n");
	}
});
