/**
 * `qorpera engine codex <prompt…>` — run one engine-mode turn from the CLI.
 *
 * Engine mode is the default runtime for real company work (spec §6.0): the
 * codex app-server runs its own loop; Qorpera records the trail and holds
 * the gates. When run inside a company folder (authority.toml above cwd)
 * the session lands in <company>/trail and approvals consult the gates;
 * elsewhere it behaves like stock codex with trail recording in the default
 * session store.
 */

import { join } from "node:path";
import { discoverAuthority } from "../authority.ts";
import { SessionManager } from "../session-manager.ts";
import { CodexEngineSession } from "./codex-engine.ts";

export async function handleEngineCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "engine") return false;
	if (args[1] !== "codex") {
		console.error(`Unknown engine: ${args[1] ?? "(none)"}. Usage: engine codex <prompt…>`);
		process.exitCode = 1;
		return true;
	}
	const prompt = args.slice(2).join(" ").trim();
	if (!prompt) {
		console.error("Usage: engine codex <prompt…>");
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const authority = discoverAuthority(cwd);
	const sessionDir = authority ? join(authority.root, "trail") : undefined;
	const sessionManager = SessionManager.create(cwd, sessionDir);

	let session: CodexEngineSession | undefined;
	try {
		session = await CodexEngineSession.start({
			cwd,
			sessionManager,
			authority,
			// A terminal-run engine command is a founder session unless the
			// kernel marked the process as autonomous work.
			attended: process.stdout.isTTY === true && !process.env.QORPERA_AUTONOMOUS,
			actor: process.env.QORPERA_ACTOR === "product-worker" ? "product-worker" : "controller",
			productWorktree: process.env.QORPERA_PRODUCT_WORKTREE,
			onEvent: (event) => {
				if (event.type === "reasoning" && event.summary) console.error(`[thinking] ${event.summary}`);
				if (event.type === "command") console.error(`[command:${event.status}] ${event.command}`);
				if (event.type === "gate" && event.decision === "decline") {
					console.error(`[gate] declined: ${event.command}\n       ${event.reason ?? ""}`);
				}
				if (event.type === "usage") {
					console.error(
						`[usage] input ${event.inputTokens} (cached ${event.cachedInputTokens}) output ${event.outputTokens}`,
					);
				}
			},
		});
		const result = await session.runTurn(prompt);
		console.log(result.finalText);
	} catch (error) {
		console.error(`Engine error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	} finally {
		await session?.dispose();
	}
	return true;
}
