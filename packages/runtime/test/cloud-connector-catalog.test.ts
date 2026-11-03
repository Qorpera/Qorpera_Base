import {
	CLOUD_CONNECTORS,
	cloudConnectorAdapterSha256,
	cloudConnectorCatalogRows,
	cloudConnectorOperation,
	cloudConnectorOperationReads,
} from "@qorpera/runtime/cloud-connector-catalog";
import { createGitHubConnectorAdapters } from "@qorpera/runtime/cloud-connector-github";
import {
	createGmailConnectorAdapters,
	createGoogleDriveConnectorAdapters,
} from "@qorpera/runtime/cloud-connector-google";
import { parseCloudConnectorInputSchema } from "@qorpera/runtime/cloud-secret-tools";
import { expect, it } from "vitest";

const client = { clientId: "client-id-test", clientSecret: "client-secret-test" };

it("declares GitHub, Gmail and Google Drive with closed, runtime-parsable operation schemas", () => {
	expect(CLOUD_CONNECTORS.map((connector) => connector.id)).toEqual(["github", "gmail", "google_drive"]);
	const rows = cloudConnectorCatalogRows();
	expect(rows).toHaveLength(21);
	expect(new Set(rows.map((row) => row.toolName)).size).toBe(rows.length);
	for (const row of rows) {
		expect(row.toolName).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
		expect(row.toolName.startsWith(`${row.connectorId}_`)).toBe(true);
		expect(row.description.length).toBeLessThanOrEqual(2048);
		expect(row.adapterSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(new URL(row.destinationOrigin).origin).toBe(row.destinationOrigin);
		// The exact parser the runtime applies to catalog rows read from SQL.
		expect(parseCloudConnectorInputSchema(row.inputSchema)).toMatchObject({
			type: "object",
			additionalProperties: false,
		});
		expect(JSON.stringify(row.inputSchema).length).toBeLessThanOrEqual(16 * 1024);
		// A call may send its fields on their own or inside input (cloud-secret-tools.ts): no field takes that name.
		expect(Object.keys(row.inputSchema.properties)).not.toContain("input");
	}
});

it("declares GitHub repository creation as a write, private unless the call says false (3 November 2026)", () => {
	const { operation } = cloudConnectorOperation("github", "create_repository");
	expect(operation).toMatchObject({ toolName: "github_create_repository", version: 1, effect: "write" });
	expect(operation.inputSchema.required).toEqual(["name"]);
	expect(Object.keys(operation.inputSchema.properties).sort()).toEqual([
		"auto_init",
		"description",
		"name",
		"owner",
		"private",
	]);
	expect(operation.inputSchema.properties.private).toMatchObject({ type: "boolean" });
	expect(operation.description).toContain("private unless private is false");
	expect(operation.description).toContain("connected again with permission to create repositories");
});

it("counts a granted operation as a read only when it is this build's read, at its version and adapter hash", () => {
	const rows = cloudConnectorCatalogRows();
	const granted = (connectorId: string, operationId: string) => {
		const row = rows.find((item) => item.connectorId === connectorId && item.operationId === operationId);
		if (!row) throw new Error(operationId);
		return { connectorId, operationId, operationVersion: row.version, adapterSha256: row.adapterSha256 };
	};
	expect(cloudConnectorOperationReads(granted("github", "list_repositories"))).toBe(true);
	expect(cloudConnectorOperationReads(granted("gmail", "read_thread"))).toBe(true);
	expect(cloudConnectorOperationReads(granted("github", "create_repository"))).toBe(false);
	expect(cloudConnectorOperationReads(granted("gmail", "send_message"))).toBe(false);
	// Another version or hash than this build's, or an operation it does not know, is a write.
	const list = granted("github", "list_repositories");
	expect(cloudConnectorOperationReads({ ...list, operationVersion: 2 })).toBe(false);
	expect(cloudConnectorOperationReads({ ...list, adapterSha256: "a".repeat(64) })).toBe(false);
	expect(cloudConnectorOperationReads({ ...list, operationId: "list_everything" })).toBe(false);
	expect(cloudConnectorOperationReads({ ...list, connectorId: "linear" })).toBe(false);
});

it("pins every compiled adapter to the catalog row it implements", () => {
	const adapters = [
		...createGitHubConnectorAdapters(),
		...createGmailConnectorAdapters({ client }),
		...createGoogleDriveConnectorAdapters({ client }),
	];
	const rows = cloudConnectorCatalogRows();
	expect(adapters).toHaveLength(rows.length);
	for (const adapter of adapters) {
		const row = rows.find(
			(item) => item.connectorId === adapter.connectorId && item.operationId === adapter.operationId,
		);
		expect(row).toBeDefined();
		expect(adapter.operationVersion).toBe(row?.version);
		expect(adapter.adapterSha256).toBe(row?.adapterSha256);
		expect(adapter.destinationOrigin).toBe(row?.destinationOrigin);
	}
});

it("changes the adapter hash when the request recipe, schema or destination changes", () => {
	const { connector, operation } = cloudConnectorOperation("github", "get_issue");
	const base = cloudConnectorAdapterSha256(connector, operation);
	expect(cloudConnectorAdapterSha256(connector, { ...operation, recipe: `${operation.recipe} ;GET /extra` })).not.toBe(
		base,
	);
	expect(cloudConnectorAdapterSha256({ ...connector, destinationOrigin: "https://example.com" }, operation)).not.toBe(
		base,
	);
	expect(
		cloudConnectorAdapterSha256(connector, {
			...operation,
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}),
	).not.toBe(base);
	expect(cloudConnectorAdapterSha256(connector, operation)).toBe(base);
	expect(() => cloudConnectorOperation("github", "delete_repository")).toThrow("unknown");
	expect(() => cloudConnectorOperation("slack", "post")).toThrow("unknown");
});
