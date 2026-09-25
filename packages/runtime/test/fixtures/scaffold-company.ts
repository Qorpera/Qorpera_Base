import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** A fresh company folder in the shape the retired desktop scaffold made
 * (pi-coding-agent's scaffoldCompany): manifest, staff registry, host
 * settings, the empty spine folders and one genesis commit. Tests capture it
 * as a company tree. */
export function scaffoldCompany(dir: string): string {
	const root = resolve(dir);
	const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
	mkdirSync(join(root, ".qorpera"), { recursive: true });
	writeFileSync(
		join(root, ".qorpera", "company.json"),
		json({
			schema: "qorpera.company/v1",
			id: randomUUID(),
			name: basename(root),
			createdAt: new Date().toISOString(),
		}),
	);
	writeFileSync(join(root, ".qorpera", "staff.json"), json({ version: 1, agents: {} }));
	writeFileSync(
		join(root, ".qorpera", "settings.json"),
		json({ sessionDir: "./trail", compaction: { enabled: false }, transport: "sse" }),
	);
	for (const folder of [join("inbox", "messages"), "trail", "connectors", "agents", "files"]) {
		mkdirSync(join(root, folder), { recursive: true });
		writeFileSync(join(root, folder, ".gitkeep"), "");
	}
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	git("init");
	git("add", "--all");
	git(
		"-c",
		"user.name=Qorpera Host",
		"-c",
		"user.email=host@qorpera.local",
		"commit",
		"-m",
		"feat: create company genesis",
	);
	return root;
}
