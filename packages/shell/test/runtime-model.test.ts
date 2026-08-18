import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearCompanyRuntimeModelPreference,
	clearDefaultRuntimeModelPreference,
	companyRuntimeModelPreferencePath,
	defaultRuntimeModelPreferencePath,
	modelSelectionFromRpcFrame,
	readCompanyRuntimeModelPreference,
	readDefaultRuntimeModelPreference,
	runtimeLaunchOptions,
	runtimeModelArgs,
	writeCompanyRuntimeModelPreference,
	writeDefaultRuntimeModelPreference,
} from "../src/runtime-model.ts";

describe("runtime model continuity", () => {
	it("captures successful model and state responses", () => {
		expect(
			modelSelectionFromRpcFrame({
				type: "response",
				command: "set_model",
				success: true,
				data: { provider: "openai-codex", id: "gpt-5.6-sol" },
			}),
		).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-sol" });
		expect(
			modelSelectionFromRpcFrame({
				type: "response",
				command: "get_state",
				success: true,
				data: { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
			}),
		).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-sol" });
	});

	it("ignores failed responses and builds an exact CLI model argument", () => {
		expect(
			modelSelectionFromRpcFrame({
				type: "response",
				command: "set_model",
				success: false,
				data: { provider: "openai-codex", id: "missing" },
			}),
		).toBeUndefined();
		expect(runtimeModelArgs({ provider: "openai-codex", modelId: "gpt-5.6-sol" })).toEqual([
			"--model",
			"openai-codex/gpt-5.6-sol",
		]);
		expect(runtimeModelArgs(undefined)).toEqual([]);
	});

	it("persists the last confirmed model for future conception sessions", () => {
		const userData = join(
			tmpdir(),
			`qorpera-company-agent-model-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			expect(readCompanyRuntimeModelPreference(userData, root)).toBeUndefined();
			expect(
				writeCompanyRuntimeModelPreference(userData, root, {
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
				}),
			).toBe(true);
			expect(readCompanyRuntimeModelPreference(userData, root)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(readCompanyRuntimeModelPreference(userData, join(userData, "company-b"))).toBeUndefined();
			expect(companyRuntimeModelPreferencePath(userData, root)).not.toBe(
				companyRuntimeModelPreferencePath(userData, join(userData, "company-b")),
			);
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("applies the founder's stored model when reopening an older session", () => {
		const userData = join(
			tmpdir(),
			`qorpera-company-agent-launch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			writeCompanyRuntimeModelPreference(userData, root, {
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(runtimeLaunchOptions(userData, root, undefined, "older-session.jsonl")).toEqual({
				sessionFile: "older-session.jsonl",
				model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
			});
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("uses the shell-wide default for companies without an override", () => {
		const userData = join(
			tmpdir(),
			`qorpera-company-agent-default-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			expect(
				writeDefaultRuntimeModelPreference(userData, {
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
				}),
			).toBe(true);
			expect(defaultRuntimeModelPreferencePath(userData)).toBe(join(userData, "company-agent-model.json"));
			expect(readDefaultRuntimeModelPreference(userData)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(readCompanyRuntimeModelPreference(userData, root)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(existsSync(companyRuntimeModelPreferencePath(userData, root))).toBe(false);
			expect(
				writeDefaultRuntimeModelPreference(userData, {
					provider: "anthropic",
					modelId: "claude-opus-4-8",
				}),
			).toBe(true);
			expect(readCompanyRuntimeModelPreference(userData, root)).toEqual({
				provider: "anthropic",
				modelId: "claude-opus-4-8",
			});
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("keeps a company-local preference ahead of later shell-wide defaults", () => {
		const userData = join(
			tmpdir(),
			`qorpera-company-agent-override-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			writeDefaultRuntimeModelPreference(userData, { provider: "anthropic", modelId: "claude-opus-4-8" });
			writeCompanyRuntimeModelPreference(userData, root, { provider: "xai", modelId: "grok-4.5" });
			writeDefaultRuntimeModelPreference(userData, { provider: "openai-codex", modelId: "gpt-5.5" });
			expect(readCompanyRuntimeModelPreference(userData, root)).toEqual({
				provider: "xai",
				modelId: "grok-4.5",
			});
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("clears shell-wide and company-local preferences when intelligence signs out", () => {
		const userData = join(
			tmpdir(),
			`qorpera-company-agent-sign-out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			writeDefaultRuntimeModelPreference(userData, { provider: "anthropic", modelId: "claude-opus-4-8" });
			writeCompanyRuntimeModelPreference(userData, root, { provider: "xai", modelId: "grok-4.5" });
			expect(clearDefaultRuntimeModelPreference(userData)).toBe(true);
			expect(clearCompanyRuntimeModelPreference(userData, root)).toBe(true);
			expect(readDefaultRuntimeModelPreference(userData)).toBeUndefined();
			expect(readCompanyRuntimeModelPreference(userData, root)).toBeUndefined();
			// Missing files are already in the desired signed-out state.
			expect(clearDefaultRuntimeModelPreference(userData)).toBe(true);
			expect(clearCompanyRuntimeModelPreference(userData, root)).toBe(true);
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("migrates model preferences from the retired controller filename", () => {
		const userData = join(
			tmpdir(),
			`qorpera-company-agent-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			mkdirSync(userData, { recursive: true });
			const legacyDefault = join(userData, "controller-model.json");
			writeFileSync(legacyDefault, `${JSON.stringify({ provider: "anthropic", modelId: "claude-opus-4-8" })}\n`);
			expect(readDefaultRuntimeModelPreference(userData)).toEqual({
				provider: "anthropic",
				modelId: "claude-opus-4-8",
			});
			expect(existsSync(legacyDefault)).toBe(false);
			expect(readFileSync(defaultRuntimeModelPreferencePath(userData), "utf-8")).toContain("claude-opus-4-8");

			const currentCompanyPath = companyRuntimeModelPreferencePath(userData, root);
			const legacyCompanyPath = join(dirname(currentCompanyPath), "controller-model.json");
			mkdirSync(dirname(legacyCompanyPath), { recursive: true });
			writeFileSync(legacyCompanyPath, `${JSON.stringify({ provider: "xai", modelId: "grok-4.5" })}\n`);
			expect(readCompanyRuntimeModelPreference(userData, root)).toEqual({
				provider: "xai",
				modelId: "grok-4.5",
			});
			expect(existsSync(legacyCompanyPath)).toBe(false);
			expect(readFileSync(currentCompanyPath, "utf-8")).toContain("grok-4.5");
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});
});
