import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	controllerLaunchOptions,
	controllerModelArgs,
	controllerModelPreferencePath,
	modelSelectionFromRpcFrame,
	readControllerModelPreference,
	writeControllerModelPreference,
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

	it("migrates the previous machine-wide preference into company-local state", () => {
		const userData = join(
			tmpdir(),
			`qorpera-controller-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const root = join(userData, "company-a");
		try {
			mkdirSync(userData, { recursive: true });
			writeFileSync(
				join(userData, "controller-model.json"),
				JSON.stringify({ provider: "openai-codex", modelId: "gpt-5.6-sol" }),
				"utf-8",
			);
			expect(readControllerModelPreference(userData, root)).toEqual({
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
			});
			expect(existsSync(controllerModelPreferencePath(userData, root))).toBe(true);
		} finally {
			if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
		}
	});
});
