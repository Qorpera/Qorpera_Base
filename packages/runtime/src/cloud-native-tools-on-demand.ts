import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_MORE_TOOLS,
	CLOUD_TOOL_RESULT_RESERVE_BYTES,
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	cloudToolForm,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "./cloud-native-tool-boundary.ts";

// Tools on demand (agents' instructions, track 3, T3-6, 14 November 2026). An agent keeps every tool it has, but the
// first request describes in full only the tools its kind of run commonly uses; the rest are listed by name, one line
// each, in more_tools, which describes them and calls them. A thread's tools are fixed at its start (Codex sends them
// as the first item of every request, so a change would cost the provider's whole cache), and the patched result fence
// refuses Codex's own tool search: so the tools that open on demand open inside one ordinary tool, whose answers come at
// the end of the history like any other. Its use is a direct call of the tool it names (CloudNativeToolBoundary.invoke).

/** The kinds of company run, by what the run is for. */
export type CloudToolKind = "cofounder" | "employee" | "worker";

/** What an agent's own company run uses in most runs, from the receipts of the 14 days to 14 November 2026 (587 runs
 * that changed something: manage_todo 50 %, manage_worker 38 %, company_edit 29 %, coworker messages 25 %, machine_run
 * 19 %, machine_start 13 %, company_write 12 %, company_mkdir 7 %, save_app 5 %) and the reads and sends, which leave no
 * receipt and are in nearly every run. save_app and post_app are how an agent shows its work. update_memory is in 1 % of
 * runs because agents barely write their notebooks, the fault to cure, not a sign it is not needed: behind a door it
 * would be used even less (the lead, 14 November 2026); like hire_agent and save_app it is carried whatever its count. A
 * worker keeps it on demand. app_guide (#1804, 14 November 2026: no receipts yet, a read leaves none) goes where
 * save_app goes: save_app saves a kit's file only once the run has read the kit's guide, so behind a door every app made
 * from a kit would cost a round more, and the instructions tell the agent to read the guide first. */
const STAFF_DIRECT = [
	"company_read",
	"company_list",
	"company_write",
	"company_edit",
	"company_mkdir",
	"read_context",
	"recall_memory",
	"read_skill",
	"send_message",
	"ask_member",
	"send_coworker_message",
	"manage_todo",
	"manage_worker",
	"machine_start",
	"machine_run",
	"machine_read",
	"machine_list",
	"save_app",
	"post_app",
	"app_guide",
	"update_memory",
];

/** The tools each kind of run carries in full. The Co-Founder hires, whatever the count says. A worker reads, writes
 * what its dispatch lets it, works on machines and reports. */
export const CLOUD_DIRECT_TOOLS: Readonly<Record<CloudToolKind, ReadonlySet<string>>> = {
	cofounder: new Set([
		...STAFF_DIRECT,
		"hire_agent",
		"hire_team",
		"update_reading",
		"propose_surface",
		"start_surface_session",
		"manage_surface_automation",
	]),
	employee: new Set(STAFF_DIRECT),
	worker: new Set([
		"company_read",
		"company_list",
		"company_write",
		"company_edit",
		"company_mkdir",
		"read_context",
		"recall_memory",
		"read_skill",
		"report_work",
		"machine_start",
		"machine_run",
		"machine_read",
		"machine_list",
		"save_app",
		"post_app",
		"app_guide",
	]),
};

/** Tools a run has only in the situation that needs them, so they are always carried in full: a dynamic routine's owed
 * decision, the node's folder search, the summary tree's zoom, the changes waiting for review, and a Company Computer's
 * tools. */
const SITUATIONAL = new Set(["decide_routine", "company_search", "zoom", "apply_proposal", "discard_proposal"]);

/** Whether a run of this kind carries the tool in full. A connector's tools are a company's own choice (a member
 * connected that app), so they are too. */
export function cloudToolDirect(kind: CloudToolKind, tool: Pick<CloudNativeTool, "name" | "source">): boolean {
	return (
		tool.source === "connector" ||
		SITUATIONAL.has(tool.name) ||
		tool.name.startsWith("computer_") ||
		CLOUD_DIRECT_TOOLS[kind].has(tool.name)
	);
}

/** more_tools' list: each tool on demand by name and what it is for, in a few words. */
const INDEX_LINES: Readonly<Record<string, string>> = {
	company_move: "move or rename a file, link or folder",
	company_delete: "delete a file, link or empty folder",
	table_read: "read a table's rows (QorperaOS/tables/)",
	table_write: "set or remove rows of a table you may write",
	make_picture: "make a new picture (an idea, a scene, an illustration) as a PNG",
	narrate_app: "give your explainer video its voice: a spoken clip for each caption",
	data_describe: "the company's databases: tables, steps, questions",
	data_query: "read a database: a named question or one select",
	data_apply: "apply a database's waiting steps",
	data_change: "add, change or remove a database's rows through its named change",
	manage_routine: "set up, change, pause or remove routines: standing work that wakes you",
	organize_sidebar: "sort agents into the sidebar's sections",
	organize_apps: "sort the company's apps into groups in the apps drawer",
	add_review_rule: "add an Ask first rule a member asked for",
	good_will_list: "a month's payments and what counted for good will",
	good_will_mark: "sort payments for the company's good will",
	crew_and_members: "the members, the team, and whose ChatGPT can carry work",
	offer_agents_to_member: "ask a member to take agents onto their ChatGPT",
	company_account: "the company's accounts on websites: find, open, record",
	list_hooks: "the company's hooks and mailboxes",
	read_event: "read one event that arrived at a hook",
	send_mail: "send an email from a company mailbox",
	find_mail: "find email that arrived at the company's mailboxes",
	manage_hook: "open a hook or mailbox, or pause, resume or remove one",
	publish_site: "publish a static website from the company folder at a private link",
	unpublish_site: "take a website or app link offline",
	share_app: "share a server app on a machine at a private link",
	update_memory: "write a fact in your notebook",
	search_skills: "search the skill libraries",
	update_skill: "save, change or delete a skill",
	hire_agent: "hire a new coworker for a continuing responsibility",
	hire_team: "hire two or more coworkers at once, each knowing the others",
	create_group_chat: "open a group chat with coworkers",
	end_role: "end an agent's role when its work is over",
	manage_code: "the company's code kept in Qorpera: its changes and records",
	machine_screen: "see and drive a running machine's desktop",
	machine_cancel: "stop a running machine command",
	machine_stop: "stop a machine; its disk is kept",
	machine_delete: "delete a machine and its disk",
	save_coding_value: "save a key made on npm, GitHub, Stripe or Resend as a coding value",
	fill_company_account: "have the vault type a company account's login or password on a machine",
	record_reflection: "record what the company decided about a platform update",
	propose_surface: "create or propose a primary Surface for the company sidebar",
	start_surface_session: "launch a scoped session or 2-3 comparable directions on a Surface",
	manage_surface_automation: "create, update, pause, or delete a recurring Scheduled Agent targeting a Surface",
};

/** Bytes of a tool's description: the boundary's bound. */
const DESCRIPTION_BYTES = 4096;
/** The most tools one describe shows. */
const DESCRIBE_MOST = 8;

/** A tool's line in more_tools' list: its own words, or the first sentence of its description, cut to 100 bytes. */
function indexLine(tool: CloudNativeTool): string {
	const own = INDEX_LINES[tool.name];
	if (own) return `- ${tool.name}: ${own}`;
	const first = [...(tool.description.split(/(?<=\.)\s|\n/, 1)[0] ?? "")];
	if (Buffer.byteLength(first.join("")) <= 100) return `- ${tool.name}: ${first.join("")}`;
	while (Buffer.byteLength(first.join("")) > 97) first.pop();
	return `- ${tool.name}: ${first.join("")}…`;
}

const MORE_TOOLS_HEAD = [
	"More of your tools, opened when you need one. They are yours as fully as the tools beside this one; only their descriptions and forms are not shown until you ask. Each line below names one and what it is for.",
	"- describe (names): each tool's full description and form (JSON Schema, with every bound). Describe a tool before you first use it in a run.",
	"- use (name, arguments): calls that tool with those arguments, as a direct call would: the same checks, review, approval cards, operation keys and answer. Arguments that do not fit its form are refused with its form.",
	"A card's approved call of one of these tools is made again with use: its name, and the card's call as arguments.",
	"Your tools here:",
].join("\n");

/** more_tools' description: what it does, then the list. Past the bound, the list keeps every name and drops the words. */
export function cloudMoreToolsDescription(deferred: readonly CloudNativeTool[]): string {
	const full = [MORE_TOOLS_HEAD, ...deferred.map(indexLine)].join("\n");
	if (Buffer.byteLength(full) <= DESCRIPTION_BYTES) return full;
	return [MORE_TOOLS_HEAD, ...deferred.map((tool) => `- ${tool.name}`)].join("\n");
}

/** Bytes a text takes in a tool result's envelope: JSON-escaped once more, with the characters the envelope writes as
 * \u escapes. */
function fencedBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text)) + 5 * (text.match(/[<>&\u2028\u2029]/g)?.length ?? 0);
}

/** What describe answers for tools by name: each one's description and form, whole, as many as one result holds; the
 * first one always. */
export function cloudDescribeTools(tools: readonly CloudNativeTool[]): string {
	const budget = MAX_CLOUD_TOOL_RESULT_BYTES - CLOUD_TOOL_RESULT_RESERVE_BYTES - 256;
	const shown: string[] = [];
	const left: string[] = [];
	for (const tool of tools) {
		const form = cloudToolForm(tool);
		if (shown.length === 0 || (left.length === 0 && fencedBytes([...shown, form].join("\n\n")) <= budget))
			shown.push(form);
		else left.push(tool.name);
	}
	return left.length === 0
		? shown.join("\n\n")
		: `${shown.join("\n\n")}\n\nNot shown here, so that this answer stays whole: ${left.join(", ")}. Describe them again.`;
}

const MORE_TOOLS_SCHEMA: { [key: string]: JsonValue } = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["describe", "use"] },
		names: {
			type: "array",
			items: { type: "string" },
			minItems: 1,
			maxItems: DESCRIBE_MOST,
			description: `describe: the tools to show, by name, 1 to ${DESCRIBE_MOST}.`,
		},
		name: { type: "string", description: "use: the tool to call, by name." },
		arguments: {
			type: "object",
			additionalProperties: true,
			description: "use: that tool's arguments, as its form takes them.",
		},
	},
	required: ["action"],
	additionalProperties: false,
};

/** more_tools for a run whose `tools` are all it has: describe shows any of them, and the boundary runs a use of one as
 * its direct call. A use that reaches this tool named none of them, or gave no arguments: it is refused. */
function moreToolsTool(tools: readonly CloudNativeTool[], deferred: readonly CloudNativeTool[]): CloudNativeTool {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const refuse = (why: string): never => {
		throw new CloudToolArgumentRefusal(why);
	};
	return {
		name: CLOUD_MORE_TOOLS,
		source: "runtime",
		description: cloudMoreToolsDescription(deferred),
		inputSchema: MORE_TOOLS_SCHEMA,
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value))
				return refuse("more_tools takes action, with names to describe or name and arguments to use");
			const { action, names, name, arguments: given, ...rest } = value;
			if (Object.keys(rest).length > 0)
				refuse("more_tools takes only action, names (describe), and name and arguments (use)");
			if (action === "use") {
				if (names !== undefined) refuse("use takes name and arguments; names is describe's");
				if (typeof name !== "string" || !byName.has(name) || name === CLOUD_MORE_TOOLS)
					refuse("use: name is not one of your tools; the names are in more_tools' list and beside it");
				return refuse(
					"use: arguments is that tool's arguments, as one object; describe the tool for its form, then use it",
				);
			}
			if (action !== "describe") return refuse("action is describe or use");
			if (name !== undefined || given !== undefined)
				refuse("describe takes names only; name and arguments are use's");
			if (
				!Array.isArray(names) ||
				names.length < 1 ||
				names.length > DESCRIBE_MOST ||
				names.some((entry) => typeof entry !== "string")
			)
				refuse(`describe: names lists 1 to ${DESCRIBE_MOST} of your tools by name`);
			const asked = [...new Set(names as string[])];
			if (asked.some((entry) => !byName.has(entry) || entry === CLOUD_MORE_TOOLS))
				refuse("describe: a name is not one of your tools; the names are in more_tools' list and beside it");
			return { action, names: asked };
		},
		async execute(value) {
			const names = (value as { names: string[] }).names;
			return { kind: "text", value: cloudDescribeTools(names.map((name) => byName.get(name)!)) };
		},
	};
}

/**
 * The run's tools as it is offered them: every tool it was made with, and more_tools when any of them is left to it,
 * with the names of those (`deferred`, the boundary's). A tool is left to more_tools unless the run's kind carries it in
 * full (cloudToolDirect). Nothing is taken away and nothing is added but more_tools.
 */
export function cloudToolsOnDemand(
	tools: readonly CloudNativeTool[],
	kind: CloudToolKind,
): { readonly tools: CloudNativeTool[]; readonly deferred: ReadonlySet<string> } {
	const deferred = tools.filter((tool) => !cloudToolDirect(kind, tool));
	if (deferred.length === 0) return { tools: [...tools], deferred: new Set() };
	return {
		tools: [...tools, moreToolsTool(tools, deferred)],
		deferred: new Set(deferred.map((tool) => tool.name)),
	};
}
