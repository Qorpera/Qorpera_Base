// The explainer kit's clip writer (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3a): run on a company machine after
// the voice recorder, it turns the recorded turns that were kept into the video's voice clips. Each clip has the
// silence cut from both ends and is written as AAC sound in an .mp4 (mono, 72 kbit/s), which every browser plays,
// into the app's `voice/` folder under the name of its caption.
// The runtime holds this file's text (cloud-app-kit-explainer-voice.generated.ts, written by
// scripts/generate-app-kits.mjs) and runs it on the machine; change it here, then run that script.
//
//   node voice-encode.cjs <work folder> /company/apps/<name>/voice <turn>:<hash> [<turn>:<hash> …]
//
// It prints one line a clip, `QORPERA-VOICE {"clip":"3f0a9c1e","file":"3f0a9c1e.mp4","seconds":5.42}`, or with
// `"problem"` for a turn that could not be made a clip (the others are still written), and exits 0 when every clip
// was written.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Silence off both ends (the voice starts about a second after it is asked), then 30 ms of lead and 100 ms of tail,
// so a clip neither clicks in nor is clipped.
const TRIM =
	"silenceremove=start_periods=1:start_threshold=-48dB:start_duration=0.03,areverse," +
	"silenceremove=start_periods=1:start_threshold=-48dB:start_duration=0.03,areverse,adelay=30,apad=pad_dur=0.10";

const [work, voice, ...pairs] = process.argv.slice(2);
const say = (line) => console.log(`QORPERA-VOICE ${JSON.stringify(line)}`);
let failed = false;
try {
	if (!work || !voice || !path.isAbsolute(work) || !path.isAbsolute(voice) || pairs.length === 0)
		throw new Error("give the work folder, the app's voice folder and at least one <turn>:<hash>");
	fs.mkdirSync(voice, { recursive: true });
} catch (error) {
	say({ problem: String(error.message).slice(0, 300) });
	process.exit(1);
}
for (const pair of pairs) {
	const match = /^([1-9][0-9]{0,3}):([0-9a-f]{8})$/.exec(pair);
	if (!match) {
		say({ problem: `not a <turn>:<hash>: ${pair.slice(0, 40)}` });
		failed = true;
		continue;
	}
	const [, turn, hash] = match;
	const file = `${hash}.mp4`;
	// Written beside its place and moved in, so the folder never holds half a clip.
	const partial = path.join(voice, `.${hash}.part.mp4`);
	try {
		execFileSync(
			"ffmpeg",
			["-v", "error", "-y", "-i", path.join(work, `${turn}.webm`), "-af", TRIM, "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "72k", "-movflags", "+faststart", partial],
			{ stdio: ["ignore", "ignore", "pipe"], timeout: 60000 },
		);
		const seconds = Number(
			execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", partial], { encoding: "utf8", timeout: 20000 }).trim(),
		);
		if (!Number.isFinite(seconds) || seconds < 0.2) throw new Error("the turn holds no speech");
		fs.renameSync(partial, path.join(voice, file));
		say({ clip: hash, file, seconds: Math.round(seconds * 100) / 100 });
	} catch (error) {
		fs.rmSync(partial, { force: true });
		say({ clip: hash, problem: String(error.stderr || error.message || error).trim().slice(0, 300) });
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
