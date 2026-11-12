// An agent's own job for scripts/prove-machine-memory.sh: `node job.cjs MB [RANDOM_PERCENT]` holds that many megabytes,
// that share of each random (which does not compress; half by default) and the rest plain, and touches a sixteenth of
// them every 5 s, until it is ended.
const crypto = require("node:crypto");
const random = Math.round((1048576 * Number(process.argv[3] ?? 50)) / 100);
const held = [];
for (let i = 0; i < Number(process.argv[2]); i++) {
	const block = Buffer.alloc(1048576, (i % 251) + 1);
	if (random > 0) crypto.randomFillSync(block, 0, random);
	held.push(block);
}
console.log(`holding ${held.length} MB`);
setInterval(() => {
	let sum = 0;
	for (let i = 0; i < held.length; i += 16) sum += held[i][4096];
	return sum;
}, 5000);
