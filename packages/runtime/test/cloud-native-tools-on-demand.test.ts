import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { cloudActionEffect } from "@qorpera/runtime/cloud-action-review";
import {
	CLOUD_MORE_TOOLS,
	type CloudDynamicToolResponse,
	type CloudNativeActionReview,
	type CloudNativeTool,
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	type CloudToolResult,
	cloudToolForm,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_DIRECT_TOOLS,
	type CloudToolKind,
	cloudToolsOnDemand,
} from "@qorpera/runtime/cloud-native-tools-on-demand";
import type { CloudRunLog } from "@qorpera/runtime/cloud-run-log";
import type { CloudRuntimeObservability } from "@qorpera/runtime/cloud-runtime-observability";
import { describe, expect, it, vi } from "vitest";
import { catalogs } from "./fixtures/cloud-tool-catalogs-fixture.ts";

// Tools on demand (agents' instructions, track 3, T3-6, 14 November 2026): every tool a run has stays the run's, its
// catalog describes in full only what its kind uses most, and more_tools lists, describes and calls the rest, a call
// through it being exactly the direct call of the tool it names.

const companyId = randomUUID();
const runId = randomUUID();

/** The tools more_tools' description lists, by name. */
function listed(tool: CloudNativeTool | undefined): string[] {
	return tool
		? [...tool.description.matchAll(/^- ([a-z][a-z0-9_]*)(?::|$)/gm)].map((match) => match[1] as string)
		: [];
}

function boundaryOf(
	tools: readonly CloudNativeTool[],
	options: Partial<ConstructorParameters<typeof CloudNativeToolBoundary>[0]> = {},
) {
	return new CloudNativeToolBoundary({
		companyId,
		runId,
		tools,
		assertActive: async () => undefined,
		signal: new AbortController().signal,
		...options,
	});
}

const resultOf = (response: CloudDynamicToolResponse) => JSON.parse(response.contentItems[0].text) as CloudToolResult;

/** A tool that records what reaches it: it takes { operationKey, title } and refuses anything else in its own words. */
function recorded(name: string, source: CloudNativeTool["source"] = "runtime") {
	const execute = vi.fn<CloudNativeTool["execute"]>(async (value) => ({
		kind: "json",
		value: { ran: name, value },
	}));
	const tool: CloudNativeTool = {
		name,
		description: `Synthetic ${name}: does one thing.`,
		source,
		inputSchema: {
			type: "object",
			properties: { operationKey: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 80 } },
			required: ["operationKey", "title"],
			additionalProperties: false,
		},
		parseArguments(value) {
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).sort().join() !== "operationKey,title" ||
				typeof value.operationKey !== "string" ||
				typeof value.title !== "string"
			)
				throw new CloudToolArgumentRefusal("operationKey and title are both text");
			return { operationKey: value.operationKey, title: value.title };
		},
		execute,
	};
	return { tool, execute };
}

describe("tools on demand", () => {
	it("keeps every tool of each kind of run: in full in its catalog, or in more_tools' list, and nothing else", async () => {
		const { staff, employee, worker } = await catalogs();
		const kinds: [CloudToolKind, CloudNativeTool[]][] = [
			["cofounder", staff],
			["employee", employee],
			["worker", worker],
		];
		for (const [kind, tools] of kinds) {
			const offered = cloudToolsOnDemand(tools, kind);
			const boundary = boundaryOf(offered.tools, { deferred: offered.deferred });
			const sent = (boundary.specification as { tools: { name: string }[] }).tools.map((tool) => tool.name);
			const more = offered.tools.find((tool) => tool.name === CLOUD_MORE_TOOLS);
			// Every tool exactly once: sent, or listed; more_tools is the one tool added.
			expect([...sent.filter((name) => name !== CLOUD_MORE_TOOLS), ...listed(more)].sort()).toEqual(
				tools.map((tool) => tool.name).sort(),
			);
			expect(offered.tools.map((tool) => tool.name)).toEqual([...tools.map((tool) => tool.name), CLOUD_MORE_TOOLS]);
			expect(sent).toContain(CLOUD_MORE_TOOLS);
			expect([...offered.deferred].sort()).toEqual(listed(more).sort());
			// Sent in full: the kind's own tools it has, and the decision a dynamic routine owes.
			expect(sent.filter((name) => name !== CLOUD_MORE_TOOLS).sort()).toEqual(
				tools
					.map((tool) => tool.name)
					.filter((name) => CLOUD_DIRECT_TOOLS[kind].has(name) || name === "decide_routine")
					.sort(),
			);
			// Each line says what its tool is for, and the description keeps room under the boundary's 4,096 bytes.
			for (const line of more!.description.split("\n").filter((text) => /^- [a-z_]+:/.test(text)))
				expect(line.split(": ", 2)[1]!.length).toBeGreaterThan(10);
			expect(listed(more)).toHaveLength(offered.deferred.size);
			expect(Buffer.byteLength(more!.description)).toBeLessThanOrEqual(3600);
		}
		// The Co-Founder hires whatever the count; an employee opens hire_agent on demand.
		expect(cloudToolsOnDemand(staff, "cofounder").deferred.has("hire_agent")).toBe(false);
		expect(cloudToolsOnDemand(employee, "employee").deferred.has("hire_agent")).toBe(true);
		// A connector's tools, and those a run has only when it needs them, are sent in full.
		const connector = recorded("linear_issue_create", "connector").tool;
		const zoom = recorded("zoom").tool;
		expect(cloudToolsOnDemand([connector, zoom], "employee").deferred.size).toBe(0);
		expect(cloudToolsOnDemand([connector, zoom], "employee").tools.map((tool) => tool.name)).toEqual([
			"linear_issue_create",
			"zoom",
		]);
		// A tool without a line of its own gets its description's first sentence.
		const unknown = recorded("new_tool").tool;
		expect(
			cloudToolsOnDemand([unknown], "employee").tools.find((tool) => tool.name === CLOUD_MORE_TOOLS)?.description,
		).toContain("\n- new_tool: Synthetic new_tool: does one thing.");
	});

	it("describes every tool on demand whole, alone or eight at once, and only the run's tools", async () => {
		const { staff, worker } = await catalogs();
		for (const [kind, tools] of [
			["cofounder", staff],
			["worker", worker],
		] as const) {
			const offered = cloudToolsOnDemand(tools, kind);
			const boundary = boundaryOf(offered.tools, { deferred: offered.deferred });
			let id = 0;
			const describe = async (names: string[]) =>
				resultOf(await boundary.invoke(`d${id++}`, "qorpera", CLOUD_MORE_TOOLS, { action: "describe", names }));
			for (const name of offered.deferred) {
				const result = await describe([name]);
				expect(result).toMatchObject({ status: "ok", content: { truncated: false } });
				expect(result.content.text).toBe(cloudToolForm(tools.find((tool) => tool.name === name)!));
			}
			// The eight largest at once: as many as fit whole, the rest named to describe again.
			const largest = [...offered.deferred]
				.sort(
					(a, b) =>
						cloudToolForm(tools.find((tool) => tool.name === b)!).length -
						cloudToolForm(tools.find((tool) => tool.name === a)!).length,
				)
				.slice(0, 8);
			const many = await describe(largest);
			expect(many).toMatchObject({ status: "ok", content: { truncated: false } });
			for (const name of largest)
				expect(
					many.content.text.startsWith(`${name}\n`) ||
						many.content.text.includes(`\n\n${name}\n`) ||
						new RegExp(`Not shown here, .*\\b${name}\\b`).test(many.content.text),
				).toBe(true);
			// A direct tool is described too; a name the run lacks is refused, and nothing is shown.
			expect((await describe(["company_read"])).content.text.startsWith("company_read\n")).toBe(true);
			for (const names of [["interface_read"], [CLOUD_MORE_TOOLS], [], Array(9).fill("company_read")])
				expect((await describe(names)).content.text).toMatch(/^INVALID_ARGUMENTS: describe: /);
		}
	});

	it("runs a use as the direct call of the tool it names: one parse, review, log step, receipt key and answer", async () => {
		const run = async (route: boolean) => {
			const { tool: hook, execute } = recorded("manage_hook");
			const offered = cloudToolsOnDemand([hook], "employee");
			expect([...offered.deferred]).toEqual(["manage_hook"]);
			const review: CloudNativeActionReview = {
				check: vi.fn(async () => ({ run: true as const, reviewId: "review-1" })),
			} as unknown as CloudNativeActionReview;
			const steps: unknown[] = [];
			const finished: unknown[] = [];
			const runLog = {
				runId,
				gone: false,
				step: vi.fn((call: unknown) => steps.push(call) - 1),
				finish: vi.fn((step: number, envelope: string) => finished.push([step, envelope])),
				effectful: (tool: CloudNativeTool, parsed: JsonValue) => cloudActionEffect(tool, parsed) !== "read",
				precommit: vi.fn(async () => undefined),
			} as unknown as CloudRunLog;
			const started: unknown[] = [];
			const span = { attemptId: "a", result: null, child: () => span, update: () => {}, finish: () => {} };
			const observability = {
				start: vi.fn((operation: string) => {
					started.push(operation);
					return span;
				}),
			} as unknown as CloudRuntimeObservability;
			const boundary = boundaryOf(offered.tools, { deferred: offered.deferred, review, runLog, observability });
			const args = { operationKey: "open-form", title: "Website form" };
			const response = route
				? await boundary.invoke("call_7", "qorpera", CLOUD_MORE_TOOLS, {
						action: "use",
						name: "manage_hook",
						arguments: args,
					})
				: await boundary.invoke("call_7", "qorpera", "manage_hook", args);
			return {
				response,
				review: (review.check as ReturnType<typeof vi.fn>).mock.calls.map(([call]) => ({
					...call,
					tool: call.tool.name,
				})),
				execute: execute.mock.calls.map(([value, context]) => [
					value,
					context.argumentSha256,
					context.actionReviewId,
				]),
				steps,
				finished,
				precommits: (runLog.precommit as ReturnType<typeof vi.fn>).mock.calls.length,
				started,
			};
		};
		const direct = await run(false);
		const routed = await run(true);
		// The same answer, byte for byte: provenance names manage_hook, with the same argument digest.
		expect(routed.response).toEqual(direct.response);
		expect(resultOf(routed.response)).toMatchObject({ status: "ok", provenance: { tool: "manage_hook" } });
		// The same review, of the same call (an approval card keys on this digest), and the same effect once.
		expect(routed.review).toEqual(direct.review);
		expect(routed.review).toHaveLength(1);
		expect(routed.execute).toEqual(direct.execute);
		expect(routed.execute).toHaveLength(1);
		// The same work-log step, committed before the effect, and finished with the same answer.
		expect(routed.steps).toEqual(direct.steps);
		expect(routed.steps).toEqual([expect.objectContaining({ call: "call_7", tool: "manage_hook" })]);
		expect(routed.precommits).toBe(1);
		expect(routed.finished).toEqual(direct.finished);
		// Observed as the tool's own operation, then its release check, as a direct call is.
		expect(routed.started).toEqual(direct.started);
		expect(routed.started[0]).toBe("manage_hook");
	});

	it("refuses a use's arguments that do not fit with the tool's form, and a direct call without it", async () => {
		const { tool: hook, execute } = recorded("manage_hook");
		const offered = cloudToolsOnDemand([hook], "employee");
		const boundary = boundaryOf(offered.tools, { deferred: offered.deferred });
		const routed = resultOf(
			await boundary.invoke("u1", "qorpera", CLOUD_MORE_TOOLS, {
				action: "use",
				name: "manage_hook",
				arguments: { title: "Website form" },
			}),
		);
		expect(routed).toMatchObject({ status: "denied", provenance: { tool: "manage_hook" } });
		expect(routed.content.text).toBe(
			`INVALID_ARGUMENTS: operationKey and title are both text\nWhat manage_hook takes, to call it again through more_tools use:\n${cloudToolForm(hook)}`,
		);
		const direct = resultOf(await boundary.invoke("d1", "qorpera", "manage_hook", { title: "Website form" }));
		expect(direct.content.text).toBe("INVALID_ARGUMENTS: operationKey and title are both text");
		expect(execute).not.toHaveBeenCalled();
	});

	it("reaches nothing the run was not made with, and refuses a use it cannot run without running anything", async () => {
		const { tool: hook, execute } = recorded("manage_hook");
		const { tool: read } = recorded("company_read");
		const offered = cloudToolsOnDemand([read, hook], "employee");
		const boundary = boundaryOf(offered.tools, { deferred: offered.deferred });
		let id = 0;
		const use = async (value: unknown) =>
			resultOf(await boundary.invoke(`r${id++}`, "qorpera", CLOUD_MORE_TOOLS, value as JsonValue));
		const refusals = [
			[{ action: "use", name: "interface_read", arguments: {} }, "use: name is not one of your tools"],
			[
				{ action: "use", name: CLOUD_MORE_TOOLS, arguments: { action: "describe", names: ["manage_hook"] } },
				"use: name",
			],
			[{ action: "use", name: "manage_hook" }, "use: arguments is that tool's arguments"],
			[{ action: "use", name: "manage_hook", arguments: '{"operationKey":"k","title":"t"}' }, "use: arguments"],
			[{ action: "use", name: "manage_hook", arguments: ["k"] }, "use: arguments"],
			[
				{ action: "use", name: "manage_hook", arguments: { operationKey: "k", title: "t" }, names: ["x"] },
				"use takes",
			],
			[
				{ action: "use", name: "manage_hook", arguments: { operationKey: "k", title: "t" }, extra: 1 },
				"more_tools takes only",
			],
			[{ action: "run", name: "manage_hook" }, "action is describe or use"],
			[null, "more_tools takes action"],
		] as const;
		for (const [value, words] of refusals) {
			const result = await use(value);
			expect(result).toMatchObject({ status: "denied", provenance: { tool: CLOUD_MORE_TOOLS } });
			expect(result.content.text).toContain(`INVALID_ARGUMENTS: ${words}`);
		}
		expect(execute).not.toHaveBeenCalled();
		// A tool the run was not made with is unavailable by its own name too; one it opens on demand is its own.
		expect(resultOf(await boundary.invoke("x1", "qorpera", "interface_read", {})).content.text).toBe(
			"TOOL_UNAVAILABLE",
		);
		expect(
			resultOf(await boundary.invoke("x2", "qorpera", "manage_hook", { operationKey: "k", title: "t" })).status,
		).toBe("ok");
		// A use in another namespace is no use.
		expect(
			resultOf(
				await boundary.invoke("x3", "skills", CLOUD_MORE_TOOLS, {
					action: "use",
					name: "manage_hook",
					arguments: { operationKey: "k", title: "t" },
				}),
			).content.text,
		).toBe("TOOL_UNAVAILABLE");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("tells the model to open a tool through more_tools when Codex refused it by its own name", async () => {
		const { tool: hook } = recorded("manage_hook");
		const { tool: read } = recorded("company_read");
		const offered = cloudToolsOnDemand([read, hook], "employee");
		const boundary = boundaryOf(offered.tools, { deferred: offered.deferred });
		const fenced = await boundary.fenceNativeResults(
			[
				// As the patched Codex 9c299f88 writes it: the namespace and the name together.
				"unsupported call: qorperamanage_hook",
				"unsupported call: manage_hook",
				"unsupported call: qorpera.manage_hook",
				"unsupported call: interface_read",
			].map((output, index) => ({ kind: "function_call_output" as const, callId: `codex_${index}`, output })),
		);
		const [codex, bare, named, other] = fenced.map((item) => JSON.parse(item.output) as CloudToolResult);
		for (const result of [codex, bare, named]) {
			expect(result).toMatchObject({ status: "denied", provenance: { tool: "unrecognized", argumentSha256: null } });
			expect(result!.content.text).toBe(
				"TOOL_UNAVAILABLE: manage_hook is one of your tools that more_tools opens: call more_tools with action use, name manage_hook and its arguments (describe it first for its form). Nothing ran.",
			);
		}
		// Any other answer Codex wrote stays what it was: unconfirmed data.
		expect(other).toMatchObject({ status: "unconfirmed", content: { text: "unsupported call: interface_read" } });
	});

	it("leaves the tools on demand out of the catalog sent to Codex, and checks them at registration", () => {
		const { tool: hook } = recorded("manage_hook");
		const { tool: read } = recorded("company_read");
		const offered = cloudToolsOnDemand([read, hook], "employee");
		const spec = boundaryOf(offered.tools, { deferred: offered.deferred }).specification as {
			description: string;
			tools: { name: string }[];
		};
		expect(spec.tools.map((tool) => tool.name)).toEqual(["company_read", CLOUD_MORE_TOOLS]);
		expect(spec.description).toMatch(/ The tools more_tools lists are yours too: open and call them through it\.$/);
		const plain = boundaryOf([read]).specification as { description: string };
		expect(plain.description).not.toContain("more_tools");
		expect(() => boundaryOf([read, hook], { deferred: new Set(["manage_hook"]) })).toThrow(
			"Invalid cloud tool registration",
		);
		expect(() => boundaryOf(offered.tools, { deferred: new Set(["send_mail"]) })).toThrow(
			"Invalid cloud tool registration",
		);
		expect(() => boundaryOf(offered.tools, { deferred: new Set([CLOUD_MORE_TOOLS]) })).toThrow(
			"Invalid cloud tool registration",
		);
	});

	it("after the answer, opens and runs the run's bookkeeping through more_tools, and nothing else", async () => {
		const { tool: send } = recorded("send_message");
		send.execute = vi.fn(async () => ({ kind: "text" as const, value: "sent", completesTurn: true }));
		const { tool: apps, execute: sorted } = recorded("organize_apps");
		const { tool: hook, execute: hooked } = recorded("manage_hook");
		const offered = cloudToolsOnDemand([send, apps, hook], "employee");
		const boundary = boundaryOf(offered.tools, { deferred: offered.deferred });
		expect(
			await boundary.invoke("s1", "qorpera", "send_message", { operationKey: "final", title: "Done" }),
		).toMatchObject({ answered: true });
		const described = await boundary.invoke("s2", "qorpera", CLOUD_MORE_TOOLS, {
			action: "describe",
			names: ["organize_apps"],
		});
		expect(resultOf(described).status).toBe("ok");
		expect(described.completesTurn).toBeUndefined();
		const args = { operationKey: "groups", title: "Sales" };
		expect(
			resultOf(
				await boundary.invoke("s3", "qorpera", CLOUD_MORE_TOOLS, {
					action: "use",
					name: "organize_apps",
					arguments: args,
				}),
			).status,
		).toBe("ok");
		expect(sorted).toHaveBeenCalledTimes(1);
		const late = await boundary.invoke("s4", "qorpera", CLOUD_MORE_TOOLS, {
			action: "use",
			name: "manage_hook",
			arguments: args,
		});
		expect(resultOf(late).content.text).toMatch(/^TOOL_UNAVAILABLE: the final send is made/);
		expect(late.completesTurn).toBe(true);
		expect(hooked).not.toHaveBeenCalled();
	});
});
