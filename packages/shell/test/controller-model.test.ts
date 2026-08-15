import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	controllerLaunchOptions,
	controllerModelArgs,
	controllerModelPreferencePath,
	defaultControllerModelPreferencePath,
	modelSelectionFromRpcFrame,
	readControllerModelPreference,
	readDefaultControllerModelPreference,
	writeControllerModelPreference,
	writeDefaultControllerModelPreference,
} from "../src/controller-model.ts";

describe("controller model continuity", () => {
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
		expect(controllerModelArgs({ provider: "openai-codex", modelId: "gpt-5.6-sol" })).toEqual([
			"--model",
			"openai-codex/gpt-5.6-sol",
		]);
		expect(controllerModelArgs(undefined)).toEqual([]);
	});

	it("persists the last confirmed model for future conception sessions", () => {
		const userData = join(tmpdir(), `qorpera-controller-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const root = join(userData, "company-a");
		try {
			expect(readControllerModelPreference(userData, root)).toBeUndefined();
			expect(
				writeControllerModelPreference(userData, root, { provider: "openai-codex", modelId: "gpt-5.6-sol" }),
			).toBe(true);
			expect(readControllerModelPreference(userData, root)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(readControllerModelPreference(userData, join(userData, "company-b"))).toBeUndefined();
			expect(controllerModelPreferencePath(userData, root)).not.toBe(
				controllerModelPreferencePath(userData, join(userData, "company-b")),
			);
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});

	it("applies the founder's stored model when reopening an older session", () => {
		const userData = join(tmpdir(), `qorpera-controller-launch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const root = join(userData, "company-a");
		try {
			writeControllerModelPreference(userData, root, { provider: "openai-codex", modelId: "gpt-5.6-sol" });
			expect(controllerLaunchOptions(userData, root, undefined, "older-session.jsonl")).toEqual({
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
			`qorpera-controller-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			expect(
				writeDefaultControllerModelPreference(userData, {
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
				}),
			).toBe(true);
			expect(defaultControllerModelPreferencePath(userData)).toBe(join(userData, "controller-model.json"));
			expect(readDefaultControllerModelPreference(userData)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(readControllerModelPreference(userData, root)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(existsSync(controllerModelPreferencePath(userData, root))).toBe(false);
			expect(
				writeDefaultControllerModelPreference(userData, {
					provider: "anthropic",
					modelId: "claude-opus-4-8",
				}),
			).toBe(true);
			expect(readControllerModelPreference(userData, root)).toEqual({
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
			`qorpera-controller-override-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			writeDefaultControllerModelPreference(userData, { provider: "anthropic", modelId: "claude-opus-4-8" });
			writeControllerModelPreference(userData, root, { provider: "xai", modelId: "grok-4.5" });
			writeDefaultControllerModelPreference(userData, { provider: "openai-codex", modelId: "gpt-5.5" });
			expect(readControllerModelPreference(userData, root)).toEqual({
				provider: "xai",
				modelId: "grok-4.5",
			});
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});
});
