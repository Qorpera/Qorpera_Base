import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Node 1's door of members' live pictures (20260930745000; README.md). The real proof (a fake token sealed, found
// nowhere else) runs on a throwaway machine; these hold the files to what that proof proved.

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");
const door = read("qorpera-screens-door");
const unit = read("qorpera-screens-tunnel.service");
const sudoers = read("qorpera-screens-door.sudoers");
const installer = read("install-screens-door.sh");
const SEALED = "/etc/credstore.encrypted/qorpera-screens-tunnel";
/** The one line that hands the token to systemd-creds (through bash's own printf, down a pipe). */
const SEAL = 'seal() { printf %s "${token}" | systemd-creds encrypt "$@" --name=token - "${SEALED}.new" 2>&1; }';
const sha256 = (name) => createHash("sha256").update(readFileSync(join(here, name))).digest("hex");

test("the installer pins every file it installs, and the connector to the binary our database stack already runs", () => {
	assert.match(installer, new RegExp(`EXPECTED_DOOR_SHA256="${sha256("qorpera-screens-door")}"`));
	assert.match(installer, new RegExp(`EXPECTED_UNIT_SHA256="${sha256("qorpera-screens-tunnel.service")}"`));
	assert.match(installer, new RegExp(`EXPECTED_SUDOERS_SHA256="${sha256("qorpera-screens-door.sudoers")}"`));
	assert.match(installer, /CLOUDFLARED_VERSION="2026\.10\.5"/);
	// The connector we already run (the database stack's own tunnel, cloudflare/cloudflared:2026.10.5), not a download.
	assert.match(installer, /EXPECTED_CLOUDFLARED_SHA256="5bec754ab74f88a35ba4b0edc2e0c4555da1f526a8ca866c9a8383ea84d286db"/);
	assert.match(installer, /image cloudflare\/cloudflared:2026\.10\.5 pinned at digest\n# sha256:1b1d34d0a9c0bfca9de72db8460d328db3f19edd2b96169114e3e893a97bbe53/);
	assert.match(installer, /if \[\[ ! \$\{expected\} =~ \^\[0-9a-f\]\{64\}\$ \]\]; then/);
	assert.match(installer, /verify_sha256 "\$\{cloudflared\}" "\$\{EXPECTED_CLOUDFLARED_SHA256\}"/);
	// Installed, never enabled or started; no token asked for.
	assert.doesNotMatch(installer, /systemctl (enable|start|restart)|qorpera-screens-door token\s*$|systemd-creds/m);
	assert.match(installer, /visudo -cqf/);
	assert.match(installer, /UNIT_PATH=\/usr\/local\/lib\/systemd\/system\/qorpera-screens-tunnel\.service/);
	for (const script of ["qorpera-screens-door", "install-screens-door.sh"])
		execFileSync("bash", ["-n", join(here, script)]);
});

test("the unit runs the connector with the sealed token as its own credential, off until the door turns it on", () => {
	assert.match(unit, new RegExp(`^ConditionPathExists=${SEALED}$`, "m"));
	assert.match(unit, new RegExp(`^LoadCredentialEncrypted=token:${SEALED}$`, "m"));
	assert.match(
		unit,
		/^ExecStart=\/usr\/local\/bin\/cloudflared tunnel --no-autoupdate --metrics 127\.0\.0\.1:20242 run --token-file \$\{CREDENTIALS_DIRECTORY\}\/token$/m,
	);
	// The token is never an argument or in the environment.
	assert.doesNotMatch(unit, /--token |TUNNEL_TOKEN|^Environment/m);
	for (const line of [
		"DynamicUser=yes",
		"NoNewPrivileges=yes",
		"CapabilityBoundingSet=",
		"ProtectSystem=strict",
		"ProtectHome=yes",
		"PrivateDevices=yes",
		"IPAddressDeny=any",
		"UMask=0077",
		"WantedBy=multi-user.target",
	])
		assert.match(unit, new RegExp(`^${line.replace(/[.$]/g, "\\$&")}$`, "m"), line);
	// The loopback and Cloudflare's tunnel edge as Cloudflare publishes it ("Tunnel with firewall", region1 and region2):
	// the two IPv4 /24s, and the twenty published IPv6 addresses each by itself — no /44 that swallows both regions and
	// more (the door proof of 13 Nov showed systemd folding the old two /44s into one).
	const allow = unit
		.split("\n")
		.filter((line) => line.startsWith("IPAddressAllow="))
		.flatMap((line) => line.slice("IPAddressAllow=".length).split(" "));
	const published = ["a0", "a8"].flatMap((region) =>
		["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map((n) => `2606:4700:${region}::${n}`),
	);
	assert.deepEqual(allow, ["localhost", "198.41.192.0/24", "198.41.200.0/24", ...published]);
	assert.match(unit, /developers\.cloudflare\.com, Cloudflare One,\n# "Tunnel with firewall", read 13 Nov 2026/);
	// What "sealed" is worth, said where the credential is loaded.
	assert.match(unit, /With the host\n# key alone, that key is a file on this same unencrypted disk/);
});

test("the door: root only, four verbs, the token in one variable that only bash and the sealing pipe see", () => {
	assert.match(door, /^set -euo pipefail\nset \+x\numask 077\nexport PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
	assert.match(door, /if \[\[ \$\{EUID\} -ne 0 \]\]; then/);
	assert.match(door, new RegExp(`^SEALED=\\$STORE/qorpera-screens-tunnel$`, "m"));
	assert.match(door, /^STORE=\/etc\/credstore\.encrypted$/m);
	for (const verb of ["token", "on", "off", "status"]) assert.match(door, new RegExp(`^${verb}:1\\)$`, "m"));
	assert.match(door, /^\*\)\n\techo "usage: qorpera-screens-door token\|on\|off\|status" >&2\n\texit 64$/m);
	// Nothing that traces, evaluates, or writes a here-string to a temporary file.
	assert.doesNotMatch(door, /set -x|set -o xtrace|\beval\b|<<<|\blogger\b|systemd-cat|decrypt|--pretty/);
	// Every line that names the token or the line it came in, exactly these.
	const allowed = new Set([
		'line=""',
		'read -r -s -p "Paste the tunnel\'s install command or its token (nothing shows), then Enter: " line || true',
		"IFS= read -r line || true",
		'token=""',
		"if [[ ${line} =~ (eyJ[A-Za-z0-9+/=_-]{40,4096}) ]]; then token=${BASH_REMATCH[1]}; fi",
		"if [[ -z ${token} ]]; then",
		SEAL,
	]);
	const naming = door
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => !line.startsWith("#") && /\$\{?(token|line)\b|\b(token|line)=|read .*\bline\b/.test(line));
	for (const line of naming) assert.ok(allowed.has(line), line);
	assert.ok(naming.includes(SEAL));
	// Sealed beside, then moved over: never half written; a failure leaves nothing.
	assert.match(door, /chmod 0600 "\$\{SEALED\}\.new"\n\tmv -f -- "\$\{SEALED\}\.new" "\$\{SEALED\}"/);
	// The kill switch: stopped, disabled and masked.
	assert.match(
		door,
		/^off:1\)\n\tsystemctl --quiet disable --now "\$\{UNIT\}" >\/dev\/null 2>&1 \|\| true\n\tsystemctl --quiet mask "\$\{UNIT\}"$/m,
	);
	assert.match(door, /^on:1\)\n\tif \[\[ ! -s \$\{SEALED\} \]\]; then/m);
});

test("the door answers in its own words only, and says which key sealed the token (the lead, 13 Nov)", () => {
	// Every systemctl call that changes something is quiet: no "Created symlink" before `on` or `off`.
	for (const line of door.split("\n").filter((one) => /^\s*(if )?systemctl (?!is-active)/.test(one)))
		assert.match(line, /systemctl --quiet /, line);
	// systemd-creds' own words are kept and shown only when sealing failed.
	assert.match(door, /echo "the token could not be sealed; nothing written \(systemd-creds said: \$\{said\}\)" >&2/);
	// One place seals, and every call of it keeps what systemd-creds says.
	assert.deepEqual(
		door.split("\n").filter((line) => line.includes("systemd-creds encrypt")).map((line) => line.trim()),
		[SEAL],
	);
	// The key: the host's, and the TPM's too when systemd says it has a working one — bound to that TPM alone, to no
	// measured boot state (`--tpm2-pcrs=` empty: a firmware or Secure Boot change cannot strand the token; round 8 F1)
	// — falling back to the host key; recorded for status.
	assert.match(
		door,
		/^\tif systemd-creds has-tpm2 >\/dev\/null 2>&1 && said=\$\(seal --with-key=host\+tpm2 --tpm2-pcrs=\); then\n\t\tkey=host\+tpm2\n\telif said=\$\(seal --with-key=host\); then\n\t\tkey=host\n\telse$/m,
	);
	assert.doesNotMatch(door, /--tpm2-pcrs=[0-9]/);
	assert.match(door, /^SEALED_WITH=\/var\/lib\/qorpera-screens-door\/sealed-with$/m);
	assert.match(door, /printf '%s\\n' "\$\{key\}" >"\$\{SEALED_WITH\}"/);
	for (const said of ['host) sealed="sealed (host key)"', 'host+tpm2) sealed="sealed (host key + tpm)"'])
		assert.ok(door.includes(said), said);
	// And the README says what each is worth, in plain words.
	const readme = read("README.md");
	assert.match(readme, /from a backup or copy of that one file, and from other\n {2}hosts; it does not keep it from whoever holds the whole disk or root on the host/);
	assert.match(readme, /`token sealed \(host key\)` or `token sealed \(host key \+ tpm\)`/);
	assert.match(readme, /bound to this TPM alone and to no measured boot state, so a firmware update or a Secure Boot change does not strand\n {2}it/);
});

test("a seal that no longer opens is said plainly, and the way back is token again, then on (review r8 F1)", () => {
	const hint = "the connector cannot start: the sealed token may no longer open on this host; run token again, then on";
	// Said when the unit has failed, or keeps failing and being restarted, while a token is sealed.
	assert.match(door, /^cannot_start\(\) \{\n\t\[\[ -s \$\{SEALED\} \]\] \|\| return 1$/m);
	assert.match(door, /\[\[ \$\{active\} == failed \|\| \$\{sub\} == auto-restart \]\] \|\| return 1/);
	assert.ok(door.includes(`echo "${hint}"`));
	// By status, after its own line, and by on in place of its "not connected" line.
	assert.match(door, /echo "\$\{UNIT\} \$\{state:-unknown\}, connector \$\{ready\}, token \$\{sealed\}"\n\tcannot_start \|\| true/);
	assert.match(door, /if ! cannot_start >&2; then\n\t\techo "started, but not connected after 30 s:/);
	// on works from a failed unit: its failed state and start limit cleared, and a unit not running (re)started now.
	assert.match(
		door,
		/systemctl --quiet reset-failed "\$\{UNIT\}" >\/dev\/null 2>&1 \|\| true\n\tsystemctl --quiet enable "\$\{UNIT\}"\n\tif ! systemctl is-active --quiet "\$\{UNIT\}"; then systemctl --quiet restart "\$\{UNIT\}"; fi/,
	);
	// And the README's way back says the same.
	const readme = read("README.md");
	assert.match(readme, /The way back is `token` again \(paste the same install command\), then `on`: `on` clears a failed unit and its\nstart limit first/);
});

test("the door takes the token out of what Cloudflare shows, and nothing else", () => {
	const match = door.split("\n").find((line) => line.includes("=~ (eyJ"));
	assert.ok(match);
	const fake = `eyJ${"a".repeat(30)}${"Q".repeat(30)}x9_-/+==`;
	const run = (input) =>
		spawnSync(
			"bash",
			[
				"-c",
				`set -euo pipefail\nIFS= read -r line || true\ntoken=""\n${match.trim()}\nprintf %s "\${#token}:\${token:0:3}"`,
			],
			{ input: `${input}\n`, encoding: "utf8" },
		).stdout;
	assert.equal(run(`sudo cloudflared service install ${fake}`), `${fake.length}:eyJ`);
	assert.equal(run(`cloudflared tunnel run --token ${fake}`), `${fake.length}:eyJ`);
	assert.equal(run(fake), `${fake.length}:eyJ`);
	assert.equal(run("  "), "0:");
	assert.equal(run("eyJshort"), "0:");
	assert.equal(run("sudo cloudflared service install"), "0:");
});

test("the operator's sudoers line names the four verbs, nothing else", () => {
	const lines = sudoers.split("\n").filter((line) => line && !line.startsWith("#"));
	assert.deepEqual(lines, [
		"OPERATOR ALL=(root) NOPASSWD: /usr/local/sbin/qorpera-screens-door token, /usr/local/sbin/qorpera-screens-door on, /usr/local/sbin/qorpera-screens-door off, /usr/local/sbin/qorpera-screens-door status",
	]);
	assert.match(installer, /sed "s\/\^OPERATOR \/\$\{operator\} \/"/);
});
