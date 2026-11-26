import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CLOUD_COMPANY_RENAME_WAKE_SCHEMA,
	COMPANY_RENAME_WAKE_PROTOCOL,
	parseCompanyRenameWakePayload,
} from "../src/cloud-company-rename-wake.ts";
import { cloudCompanyRuntimeInstructions } from "../src/cloud-native-company-context.ts";
import { cloudRuntimeHireBehavior } from "../src/cloud-runtime-hire-overlays.ts";
import {
	buildCompanyInterfacesSection,
	loadCompanyInterfacesContext,
	parseCompanyInterfacesMeta,
} from "../src/cloud-surface-turn-context.ts";
import {
	CLOUD_WAKE_SCHEMA,
	type CloudWakeEnvelope,
	type CloudWakePolicy,
	parseCloudWakeEnvelope,
} from "../src/cloud-wake-bus.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const policies = JSON.parse(readFileSync(new URL("./fixtures/wake-policies.json", import.meta.url), "utf8")) as {
	scenario: string;
	policy: CloudWakePolicy;
}[];

function renamePayload(renameId: string, overrides: Record<string, unknown> = {}) {
	return {
		schema: CLOUD_COMPANY_RENAME_WAKE_SCHEMA,
		renameId,
		oldName: "Nordlys Kaffe",
		newName: "Solstice Roasters",
		renamedAt: "2026-11-26T09:15:00.123456Z",
		commitId: randomUUID(),
		visionSeq: 42,
		renamedByUserId: randomUUID(),
		...overrides,
	};
}

function renameEnvelope(payloadOverrides: Record<string, unknown> = {}) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const renameId = randomUUID();
	const id = randomUUID();
	const continuationPolicy = policies.find((entry) => entry.scenario === "agent-continuation")!.policy;
	const raw = {
		schema: CLOUD_WAKE_SCHEMA,
		id,
		runId: binding.runId,
		kind: "agent",
		companyId: authority.identity.companyId,
		environmentId: authority.identity.environmentId,
		staffAgentId: authority.identity.staffAgentId,
		requesterUserId: authority.identity.requesterUserId,
		actorStaffId: null,
		actorUserId: authority.identity.requesterUserId,
		audience: {
			kind: authority.identity.audienceKind,
			userId: authority.identity.audienceUserId,
			sessionId: authority.identity.sessionId,
		},
		source: { kind: "company-rename", id: renameId, occurrenceKey: `company-rename:${renameId}` },
		policy: continuationPolicy,
		time: { utc: "2026-11-26T09:15:05.000000Z", local: "2026-11-26T10:15:05.000000", timeZone: "Europe/Copenhagen" },
		pins: {
			companySnapshotId: randomUUID(),
			staffVersion: authority.identity.staffVersion,
			wakeSchema: CLOUD_WAKE_SCHEMA,
			runtimeBundleVersion: null,
		},
		routine: null,
		payload: renamePayload(renameId, payloadOverrides),
		parentRunId: null,
		causal: { rootId: id, agentIds: [authority.identity.staffAgentId] },
	};
	return { binding, authority, raw, renameId };
}

describe("company-rename wake payload and protocol", () => {
	it("parses valid payloads including nullable provenance fields", () => {
		const renameId = randomUUID();
		const full = parseCompanyRenameWakePayload(renamePayload(renameId), renameId);
		expect(full.oldName).toBe("Nordlys Kaffe");
		expect(full.newName).toBe("Solstice Roasters");
		expect(full.visionSeq).toBe(42);

		const minimal = parseCompanyRenameWakePayload(
			renamePayload(renameId, { commitId: null, visionSeq: null, renamedByUserId: null }),
			renameId,
		);
		expect(minimal.commitId).toBeNull();
		expect(minimal.visionSeq).toBeNull();
		expect(minimal.renamedByUserId).toBeNull();
	});

	it("rejects mismatched ids, equal names, non-microsecond timestamps, and unknown fields", () => {
		const renameId = randomUUID();
		expect(() => parseCompanyRenameWakePayload(renamePayload(randomUUID()), renameId)).toThrow();
		expect(() =>
			parseCompanyRenameWakePayload(renamePayload(renameId, { newName: "Nordlys Kaffe" }), renameId),
		).toThrow();
		expect(() =>
			parseCompanyRenameWakePayload(renamePayload(renameId, { renamedAt: "2026-11-26T09:15:00Z" }), renameId),
		).toThrow();
		expect(() => parseCompanyRenameWakePayload({ ...renamePayload(renameId), extra: true }, renameId)).toThrow();
		expect(() => parseCompanyRenameWakePayload(renamePayload(renameId, { visionSeq: 0 }), renameId)).toThrow();
	});

	it("parses company-rename wake envelopes and wires the Co-Founder protocol", () => {
		const { raw, authority } = renameEnvelope();
		const envelope = parseCloudWakeEnvelope(raw, authority.identity);
		expect(envelope.source.kind).toBe("company-rename");
		expect(envelope.kind).toBe("agent");

		expect(() => parseCloudWakeEnvelope({ ...raw, kind: "human" }, authority.identity)).toThrow();

		const renameInstructions = cloudCompanyRuntimeInstructions(envelope, false);
		expect(renameInstructions).toContain(COMPANY_RENAME_WAKE_PROTOCOL[0]!);
		expect(renameInstructions).toContain("wake.payload.oldName");
		expect(renameInstructions).toContain("Formerly <oldName>");

		const regularInstructions = cloudCompanyRuntimeInstructions(
			{
				...envelope,
				kind: "human",
				source: { kind: "input", id: randomUUID(), occurrenceKey: "input:1" },
			} as CloudWakeEnvelope,
			false,
		);
		expect(regularInstructions).not.toContain("# This run: the company was renamed");
	});

	it("parses live company metadata in Company Interfaces and formats formerly suffix cleanly", async () => {
		const raw = {
			schema: "qorpera.company-interfaces/v1",
			company: {
				id: randomUUID(),
				name: "Solstice Roasters",
				previousName: "Nordlys Kaffe",
				renamedAt: "2026-11-26T09:15:00Z",
			},
			interfaces: [],
		};
		const meta = parseCompanyInterfacesMeta(raw);
		expect(meta).toEqual({
			id: expect.any(String),
			name: "Solstice Roasters",
			previousName: "Nordlys Kaffe",
			renamedAt: "2026-11-26T09:15:00Z",
		});

		const loaded = await loadCompanyInterfacesContext(
			raw,
			() => ({ readText: async () => null }),
			new AbortController().signal,
		);
		expect(loaded?.company).toEqual(meta);

		const section = buildCompanyInterfacesSection({ interfaces: [], company: meta });
		expect(section).toContain("Company name: **Solstice Roasters** (formerly Nordlys Kaffe).");

		const firstNamed = buildCompanyInterfacesSection({
			interfaces: [],
			company: { name: "Solstice Roasters", previousName: "No name yet", renamedAt: "2026-11-26T09:15:00Z" },
		});
		expect(firstNamed).toContain("Company name: **Solstice Roasters**.");
		expect(firstNamed).not.toContain("formerly No name yet");
	});

	it("does not tell the Co-Founder to leave the company name static", () => {
		const behavior = cloudRuntimeHireBehavior("cofounder");
		expect(behavior).toContain("keeps brand assets and wordmarks aligned whenever founders rename the company");
		expect(behavior).not.toContain("leaves the company's name alone");
	});
});
