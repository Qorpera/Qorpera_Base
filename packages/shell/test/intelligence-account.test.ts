import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearIntelligenceAccountBinding,
	intelligenceAccountBindingPath,
	intelligenceBindingMatches,
	readIntelligenceAccountBinding,
	writeIntelligenceAccountBinding,
} from "../src/intelligence-account.ts";

function testDirectory(): string {
	return join(tmpdir(), `qorpera-intelligence-account-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("Qorpera account intelligence binding", () => {
	it("binds one selected intelligence provider to the signed-in Qorpera user", () => {
		const userData = testDirectory();
		try {
			expect(readIntelligenceAccountBinding(userData)).toBeUndefined();
			expect(
				writeIntelligenceAccountBinding(userData, {
					accountUserId: "qorpera-user-1",
					providerId: "openai-codex",
				}),
			).toBe(true);
			expect(readIntelligenceAccountBinding(userData)).toEqual({
				accountUserId: "qorpera-user-1",
				providerId: "openai-codex",
			});
			const binding = readIntelligenceAccountBinding(userData);
			expect(intelligenceBindingMatches(binding, "qorpera-user-1", "openai-codex")).toBe(true);
			expect(intelligenceBindingMatches(binding, "qorpera-user-2", "openai-codex")).toBe(false);
			expect(intelligenceBindingMatches(binding, "qorpera-user-1", "anthropic")).toBe(false);
			expect(intelligenceBindingMatches(binding, undefined, "openai-codex")).toBe(false);
			expect(clearIntelligenceAccountBinding(userData)).toBe(true);
			expect(readIntelligenceAccountBinding(userData)).toBeUndefined();
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("fails closed for malformed or incomplete bindings", () => {
		const userData = testDirectory();
		try {
			const path = intelligenceAccountBindingPath(userData);
			expect(writeIntelligenceAccountBinding(userData, { accountUserId: "", providerId: "xai" })).toBe(false);
			mkdirSync(userData, { recursive: true });
			writeFileSync(path, '{"schema":"qorpera.intelligence-account/v1","accountUserId":"user"}\n');
			expect(readIntelligenceAccountBinding(userData)).toBeUndefined();
			writeFileSync(path, "not json\n");
			expect(readIntelligenceAccountBinding(userData)).toBeUndefined();
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});
});
