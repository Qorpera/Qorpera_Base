import { createHash } from "node:crypto";
import type { StaffAgent } from "@qorpera/company/company-staff";
import { describe, expect, it } from "vitest";
import {
	cloudCompanyAgentPath,
	deleteCloudCompanyAgent,
	parseCloudCompanyAgentDocument,
	writeCloudCompanyAgent,
} from "../src/cloud-company-agent.ts";
import type {
	CloudMemberCompanyCommand,
	CloudMemberCompanyEdit,
	CloudMemberCompanyProposal,
} from "../src/cloud-member-company-editor.ts";

const AGENT = "10000000-0000-4000-8000-000000000001";
const COMMAND = "10000000-0000-4000-8000-000000000002";
const COMPANY = "10000000-0000-4000-8000-000000000003";
const ENVIRONMENT = "10000000-0000-4000-8000-000000000004";
const VERSION_1 = "10000000-0000-4000-8000-000000000005";
const VERSION_2 = "10000000-0000-4000-8000-000000000006";
const SNAPSHOT = "10000000-0000-4000-8000-000000000007";
const CREATED = "2026-08-29T08:00:00.000Z";

function agent(update: Partial<StaffAgent> = {}): StaffAgent {
	return {
		id: AGENT,
		displayName: "Operations",
		role: "Own company operations",
		charter: "Keep the company operating from canonical Company File state.",
		templateId: "operations",
		appearance: { color: "blue", shape: "round", creature: "pebble" },
		employmentStatus: "active",
		lifecycleState: "setup",
		createdAt: CREATED,
		updatedAt: CREATED,
		...update,
	};
}

class FakeEditor {
	file: { version: string; text: string } | undefined;
	edits: CloudMemberCompanyEdit[] = [];
	reviews = 0;
	#pending: CloudMemberCompanyEdit | undefined;

	async read(path: string, _signal: AbortSignal) {
		if (!this.file) return { path, version: null, kind: "absent" as const, executable: false, text: "" };
		return { path, version: this.file.version, kind: "file" as const, executable: false, text: this.file.text };
	}

	async edit(input: CloudMemberCompanyEdit, _signal: AbortSignal): Promise<CloudMemberCompanyCommand> {
		this.edits.push(input);
		this.#pending = input;
		return this.#command("review_required");
	}

	async review(
		target: CloudMemberCompanyCommand | CloudMemberCompanyProposal,
		decision: "approve" | "reject" | "skip",
		_signal: AbortSignal,
	): Promise<CloudMemberCompanyCommand | CloudMemberCompanyProposal> {
		if (!("commandId" in target) || decision !== "approve" || !this.#pending) {
			throw new Error("unexpected review");
		}
		this.reviews += 1;
		if (this.#pending.operation === "write") this.file = { version: VERSION_2, text: this.#pending.text };
		else if (this.#pending.operation === "delete") this.file = undefined;
		return this.#command("applied");
	}

	#command(state: CloudMemberCompanyCommand["state"]): CloudMemberCompanyCommand {
		if (!this.#pending) throw new Error("missing edit");
		const entry =
			this.#pending.operation === "write"
				? {
						path: this.#pending.path,
						kind: "file" as const,
						executable: false,
						file: {
							manifestSha256: "a".repeat(64),
							fileSha256: createHash("sha256").update(this.#pending.text).digest("hex"),
							bytes: Buffer.byteLength(this.#pending.text),
							mediaType: "application/octet-stream" as const,
						},
					}
				: null;
		return {
			commandId: COMMAND,
			environmentId: ENVIRONMENT,
			companyId: COMPANY,
			plan: {
				schema: "qorpera.company-path-mutation/v1",
				operationKey: this.#pending.operationKey,
				path: this.#pending.path,
				expectedVersion: this.#pending.expectedVersion,
				entry,
			},
			planSha256: "b".repeat(64),
			state,
			expiresAt: "2026-08-29T09:00:00.000Z",
			result: state === "applied" ? { snapshotId: SNAPSHOT, version: VERSION_2 } : null,
		};
	}
}

describe("canonical Company File agent documents", () => {
	it("creates through protected review with startup instructions and fixed low effort", async () => {
		const editor = new FakeEditor();
		const result = await writeCloudCompanyAgent({
			editor,
			agent: agent(),
			startupInstructions: "Introduce yourself privately and begin the assigned job.",
			operationKey: "staff-create:test",
			signal: AbortSignal.timeout(1_000),
		});

		expect(result.state).toBe("applied");
		expect(result.agentRevision).toBe(1);
		expect(editor.reviews).toBe(1);
		expect(editor.edits[0]).toMatchObject({
			operation: "write",
			path: cloudCompanyAgentPath(AGENT),
			expectedVersion: null,
		});
		const document = parseCloudCompanyAgentDocument(JSON.parse(editor.file!.text));
		expect(document).toMatchObject({
			agentId: AGENT,
			revision: 1,
			reasoningPolicy: { effort: "low" },
			grants: { responsibilities: [], projects: [], rooms: [], resources: [] },
			startupInstructions: "Introduce yourself privately and begin the assigned job.",
		});
	});

	it("updates the exact current version while preserving immutable identity and startup", async () => {
		const editor = new FakeEditor();
		await writeCloudCompanyAgent({
			editor,
			agent: agent(),
			startupInstructions: "Start once.",
			operationKey: "staff-create:test",
			signal: AbortSignal.timeout(1_000),
		});
		const initial = JSON.parse(editor.file!.text) as Record<string, unknown>;
		initial.grants = {
			responsibilities: ["10000000-0000-4000-8000-000000000010"],
			projects: ["10000000-0000-4000-8000-000000000011"],
			rooms: ["10000000-0000-4000-8000-000000000012"],
			resources: [
				{
					resourceId: "10000000-0000-4000-8000-000000000013",
					resourceVersion: "10000000-0000-4000-8000-000000000014",
					permissions: ["read", "write"],
				},
			],
		};
		editor.file = { version: VERSION_1, text: JSON.stringify(initial) };

		const updated = await writeCloudCompanyAgent({
			editor,
			agent: agent({ displayName: "Chief of Staff", model: { provider: "openai", modelId: "gpt-5" } }),
			operationKey: "staff-update:test",
			signal: AbortSignal.timeout(1_000),
		});
		expect(updated.agentRevision).toBe(2);

		expect(editor.edits[1]).toMatchObject({ expectedVersion: VERSION_1 });
		expect(parseCloudCompanyAgentDocument(JSON.parse(editor.file!.text))).toMatchObject({
			revision: 2,
			displayName: "Chief of Staff",
			modelPolicy: { provider: "openai", modelId: "gpt-5" },
			startupInstructions: "Start once.",
			createdAt: CREATED,
			grants: initial.grants,
		});
	});

	it("deletes the exact current document and rejects malformed grant identities", async () => {
		const editor = new FakeEditor();
		await writeCloudCompanyAgent({
			editor,
			agent: agent(),
			startupInstructions: "Start once.",
			operationKey: "staff-create:test",
			signal: AbortSignal.timeout(1_000),
		});
		editor.file = { version: VERSION_1, text: editor.file!.text };

		await deleteCloudCompanyAgent({
			editor,
			agentId: AGENT,
			operationKey: "staff-delete:test",
			signal: AbortSignal.timeout(1_000),
		});
		expect(editor.edits[1]).toMatchObject({
			operation: "delete",
			path: cloudCompanyAgentPath(AGENT),
			expectedVersion: VERSION_1,
		});
		expect(editor.file).toBeUndefined();

		const unauthorized = {
			...JSON.parse(
				JSON.stringify({
					schema: "qorpera.company-agent/v1",
					agentId: AGENT,
					revision: 1,
					displayName: "Operations",
					role: "Operations",
					hireOverlay: { charter: "Operate.", templateId: null },
					appearance: { color: "blue", shape: "round", creature: null },
					modelPolicy: { provider: null, modelId: null },
					reasoningPolicy: { effort: "low" },
					grants: { responsibilities: [], projects: ["forbidden"], rooms: [], resources: [] },
					startupInstructions: "Start.",
					employmentStatus: "active",
					lifecycleState: "setup",
					createdAt: CREATED,
				}),
			),
		};
		expect(() => parseCloudCompanyAgentDocument(unauthorized)).toThrow("project grants");
	});
});
