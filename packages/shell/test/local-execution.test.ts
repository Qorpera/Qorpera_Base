import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	localExecutionPreferencePath,
	localExecutionToolArgs,
	readLocalExecutionPermission,
	writeLocalExecutionPermission,
} from "../src/local-execution.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { userData: string; company: string } {
	const root = mkdtempSync(join(tmpdir(), "qorpera-local-execution-"));
	roots.push(root);
	return { userData: join(root, "user-data"), company: join(root, "company") };
}

describe("local execution permission", () => {
	it("maps the permission into child runtime tool arguments", () => {
		expect(localExecutionToolArgs("always", "read,bash,edit,write,request_connection")).toEqual([
			"--tools",
			"read,bash,edit,write,request_connection",
		]);
		expect(localExecutionToolArgs("always")).toEqual([]);
		expect(localExecutionToolArgs("never", "read,bash,edit,write,request_connection")).toEqual([
			"--tools",
			"request_connection",
		]);
		expect(localExecutionToolArgs("never", "read,bash,edit,write,request_connection,delegate_to_staff")).toEqual([
			"--tools",
			"request_connection,delegate_to_staff",
		]);
		expect(localExecutionToolArgs("never")).toEqual(["--tools", "request_connection"]);
	});

	it("defaults a new local profile to always allow", () => {
		const { userData, company } = fixture();
		expect(readLocalExecutionPermission(userData, company)).toBe("always");
	});

	it("persists an explicit deny choice", () => {
		const { userData, company } = fixture();
		expect(writeLocalExecutionPermission(userData, company, "never")).toBe(true);
		expect(readLocalExecutionPermission(userData, company)).toBe("never");
	});

	it("fails closed for malformed persisted state", () => {
		const { userData, company } = fixture();
		const path = localExecutionPreferencePath(userData, company);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "not-json", "utf-8");
		expect(readLocalExecutionPermission(userData, company)).toBe("never");
	});
});
