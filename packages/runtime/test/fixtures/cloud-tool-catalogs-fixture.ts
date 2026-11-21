import { CLOUD_AGENT_SEND_INSTRUCTIONS } from "@qorpera/runtime/cloud-agent-mouth";
import { cloudNarrateAppTool } from "@qorpera/runtime/cloud-app-narrate-tool";
import { cloudCodeTools } from "@qorpera/runtime/cloud-code-tools";
import { cloudDataTools } from "@qorpera/runtime/cloud-data-tools";
import { cloudEventTools } from "@qorpera/runtime/cloud-event-tools";
import { cloudAppGroupsTool } from "@qorpera/runtime/cloud-folder-app-groups";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import { cloudFolderSearchTool } from "@qorpera/runtime/cloud-folder-search-tool";
import { cloudInterfaceTools } from "@qorpera/runtime/cloud-folder-interface-tools";
import { cloudInterfaceWriteTools } from "@qorpera/runtime/cloud-folder-interface-writes";
import { cloudPictureTool } from "@qorpera/runtime/cloud-folder-picture-tool";
import { cloudReadingTool } from "@qorpera/runtime/cloud-folder-reading";
import { cloudGoodWillTools } from "@qorpera/runtime/cloud-good-will-tools";
import { cloudHiringTools } from "@qorpera/runtime/cloud-hiring-tools";
import { cloudMachineTools } from "@qorpera/runtime/cloud-machine-tools";
import { cloudMemberOfferTools } from "@qorpera/runtime/cloud-member-offer-tools";
import { cloudMemoryTools } from "@qorpera/runtime/cloud-memory-tools";
import { cloudCompanyContextTool, parseCloudNativeCompanyContext } from "@qorpera/runtime/cloud-native-company-context";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import type { CloudNativeTool } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudPictureChannel } from "@qorpera/runtime/cloud-picture-channel";
import { cloudRecordReflectionTool } from "@qorpera/runtime/cloud-platform-updates";
import { cloudReviewRuleTools } from "@qorpera/runtime/cloud-review-rule-tools";
import { cloudRoutineDecisionTool, cloudRoutineTools } from "@qorpera/runtime/cloud-routine-tools";
import { cloudSidebarTools } from "@qorpera/runtime/cloud-sidebar-tools";
import { cloudSiteTools } from "@qorpera/runtime/cloud-site-tools";
import { cloudSkillTools } from "@qorpera/runtime/cloud-skill-tools";
import { CLOUD_ASK_MEMBER_INPUT_SCHEMA, cloudAskMemberInstructions } from "@qorpera/runtime/cloud-thread-interactions";
import { CloudVoiceChannel } from "@qorpera/runtime/cloud-voice-channel";
import { cloudCoworkerMessageTool } from "@qorpera/runtime/cloud-wake-bus";
import { cloudWorkerTools } from "@qorpera/runtime/cloud-worker-tools";
import { nativeCompanyContextFixture } from "./native-company-context-fixture.ts";
import { nativeToolAuthorityFixture } from "./native-tool-authority-fixture.ts";

// The catalogs the tool contract tests (T3-5) and the tools-on-demand tests (T3-6) hold the runtime's words against.

/** A stand-in for every outside part a tool factory keeps; nothing here calls a tool. */
export function standIn(): never {
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

/** The tools of a Co-Founder's company run on a host with machines and company databases, of an employee's (the same
 * but the Co-Founder's own crew_and_members and offer_agents_to_member), and of a worker, made by the runtime's own
 * factories (as the company runtime composes them). */
export async function catalogs() {
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
		cloudFolderSearchTool({ search: standIn(), folder, runId: identity.runId }),
		...cloudInterfaceTools({ folder, identity, timeZone: "UTC" }),
		...cloudInterfaceWriteTools({ folder, operations, identity }),
		...cloudAppTools({ folder, operations, identity }),
		cloudPictureTool({ folder, operations, identity, pictures: new CloudPictureChannel() }),
		cloudNarrateAppTool({
			binding,
			identity,
			control: standIn(),
			folder,
			operations,
			machines: { gateway: standIn(), operations },
			voice: new CloudVoiceChannel(),
		}),
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
		cloudRecordReflectionTool({ folder, operations, identity }),
		cloudReadingTool(identity, standIn()),
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
			source: "runtime",
			description: CLOUD_AGENT_SEND_INSTRUCTIONS,
			// As the company runtime makes it (cloud-native-company-runtime.ts).
			inputSchema: {
				type: "object",
				properties: {
					idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
					text: { type: "string", minLength: 1, maxLength: 65536 },
					phase: { type: "string", enum: ["progress", "final"] },
				},
				required: ["idempotencyKey", "text", "phase"],
				additionalProperties: false,
			},
		} as unknown as CloudNativeTool,
		{
			name: "ask_member",
			source: "runtime",
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
	const employee = staff.filter(
		(tool) =>
			!["crew_and_members", "offer_agents_to_member", "record_reflection", "update_reading"].includes(tool.name),
	);
	return { staff, employee, worker, all: [...staff, ...worker] };
}
