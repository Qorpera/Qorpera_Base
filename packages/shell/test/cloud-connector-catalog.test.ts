import {
	CLOUD_CONNECTORS,
	cloudConnectorAdapterSha256,
	cloudConnectorCatalogRows,
	cloudConnectorOperation,
} from "@qorpera/runtime/cloud-connector-catalog";
import { createGitHubConnectorAdapters } from "@qorpera/runtime/cloud-connector-github";
import {
	createGmailConnectorAdapters,
	createGoogleDriveConnectorAdapters,
} from "@qorpera/runtime/cloud-connector-google";
import { CLOUD_NATIVE_TOOL_COUNT_LIMIT } from "@qorpera/runtime/cloud-native-tool-boundary";
import { parseCloudConnectorInputSchema } from "@qorpera/runtime/cloud-secret-tools";
import { expect, it } from "vitest";

const client = { clientId: "client-id-test", clientSecret: "client-secret-test" };

it("declares GitHub, Gmail and Google Drive with closed, runtime-parsable operation schemas", () => {
	expect(CLOUD_CONNECTORS.map((connector) => connector.id)).toEqual(["github", "gmail", "google_drive"]);
	const rows = cloudConnectorCatalogRows();
	expect(rows).toHaveLength(15);
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
	}
});

it("keeps the whole catalog inside the runtime's tool-count budget beside the runtime's own tools", () => {
	// company_* (5), read_context, send_coworker_message, manage_routine, hire_agent,
	// create_group_chat, send_message and the computer family (7) leave room for
	// every connector operation at once.
	const runtimeOwnTools = 5 + 1 + 1 + 1 + 1 + 1 + 1 + 7;
	expect(runtimeOwnTools + cloudConnectorCatalogRows().length).toBeLessThanOrEqual(CLOUD_NATIVE_TOOL_COUNT_LIMIT);
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
