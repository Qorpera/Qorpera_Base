import assert from "node:assert/strict";
import test from "node:test";
import { closeFoundingNativeCustody } from "./founding-native-custody.mjs";

test("unconfirmed physical closure retains the database before server and failed marker I/O", async () => {
	const order = [];
	await assert.rejects(
		closeFoundingNativeCustody({
			stages: [
				async () => {
					order.push("physical");
					throw new Error("stop uncertain");
				},
				async () => {
					order.push("server");
					throw new Error("close failed");
				},
				async () => {
					order.push("bootstrap");
				},
			],
			preserve: async () => {
				order.push("keepFiles");
			},
			diagnostics: [
				async () => {
					order.push("marker");
					throw new Error("full disk");
				},
				async () => {
					order.push("pointer");
					throw new Error("permission");
				},
			],
		}),
		(error) => error instanceof AggregateError && error.errors.length === 4,
	);
	assert.deepEqual(order, ["physical", "keepFiles", "server", "bootstrap", "marker", "pointer"]);
});

test("a server-only cleanup failure also retains custody and cannot skip subsequent cleanup", async () => {
	const order = [];
	await assert.rejects(
		closeFoundingNativeCustody({
			stages: [
				async () => {
					order.push("physical");
				},
				async () => {
					order.push("server");
					throw new Error("close failed");
				},
				async () => {
					order.push("bootstrap");
				},
			],
			preserve: async () => {
				order.push("keepFiles");
				throw new Error("shutdown unconfirmed");
			},
			diagnostics: [
				async () => {
					order.push("marker");
				},
			],
		}),
		(error) => error instanceof AggregateError && error.errors.length === 2,
	);
	assert.deepEqual(order, ["physical", "server", "keepFiles", "bootstrap", "marker"]);
});

test("confirmed cleanup leaves normal owned database deletion to the outer harness", async () => {
	await closeFoundingNativeCustody({
		stages: [async () => {}],
		preserve: () => assert.fail("unexpected retention"),
		diagnostics: [() => assert.fail("unexpected uncertainty marker")],
	});
});
