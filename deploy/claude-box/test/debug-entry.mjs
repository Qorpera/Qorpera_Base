// C2 proof, debugging only: stands in for the native entry inside the box and prints what the box sees instead of
// starting Claude Code. prove.ts's `look` mode uses it.
import { execSync } from "node:child_process";
const run = (cmd) => {
	try {
		return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" });
	} catch (error) {
		return `ERR ${error.status}: ${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
};
for (const cmd of [
	"id; cat /proc/self/status | grep -E 'Cap(Eff|Bnd)|NoNewPrivs'; cat /proc/self/attr/current",
	"grep -E 'sshfs|/company|/tmp' /proc/self/mountinfo",
	"ls -ld /tmp /company /var/lib/qorpera-agent /slot/config /slot/home",
	"mkdir /tmp/c2-look-$$ && echo mkdir-ok; ls -ld /tmp/c2-look-$$; rmdir /tmp/c2-look-$$",
	"echo hi > /company/c2-look.txt && cat /company/c2-look.txt && rm /company/c2-look.txt && echo write-ok",
	"ls -la /company | head -5",
]) console.log(`$ ${cmd}\n${run(cmd)}`);
