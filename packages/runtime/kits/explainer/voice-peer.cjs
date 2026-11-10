// The explainer kit's voice recorder (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3a): run on a company machine, it
// is the other end of the voice call that the agent's own Codex places. A headless browser makes the WebRTC offer,
// takes the answer, and records what the voice says, one clip a turn. It holds no sign-in and is handed none: the
// call is placed where the sign-in is, and only the offer and the answer pass between the two.
// The runtime holds this file's text (cloud-app-kit-explainer-voice.generated.ts, written by
// scripts/generate-app-kits.mjs) and runs it on the machine; change it here, then run that script.
//
//   node voice-peer.cjs <work folder> [seconds, at most 290]
//
// It prints lines that start with `QORPERA-VOICE ` and hold one JSON object each:
//   {"offer": "<SDP>"}                 the offer, once
//   {"connected": true}                the answer was taken and the call stands
//   {"turn": 1, "file": "1.webm", "ms": 5210, "bytes": 81234}   one turn of the voice, recorded and written
//   {"ended": "stop" | "time" | "closed" | "<what went wrong>"}  last line
// It reads two files in the work folder: `answer.sdp` (the call's answer; waited for up to a minute) and `stop`
// (its being there ends the recording). A turn is the voice's own: it begins at the call's `turn.created` and ends
// when `turn.done` has come and the sound has been quiet for 0.7 s, so the two ends need no shared clock.
const { chromium } = require(process.env.QORPERA_PLAYWRIGHT || "playwright");
const fs = require("node:fs");
const path = require("node:path");

const [work, limit = "290"] = process.argv.slice(2);
const say = (line) => console.log(`QORPERA-VOICE ${JSON.stringify(line)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	if (!work || !path.isAbsolute(work)) throw new Error("give the work folder's absolute path");
	fs.mkdirSync(work, { recursive: true });
	const seconds = Math.max(10, Math.min(290, Number(limit) || 290));
	const until = Date.now() + seconds * 1000;
	const browser = await chromium.launch({
		...(process.env.QORPERA_VOICE_CHANNEL ? { channel: process.env.QORPERA_VOICE_CHANNEL } : {}),
		// The page plays nothing aloud; it must be let to run its audio graph with no press.
		args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
	});
	let ended = "time";
	try {
		const page = await browser.newPage();
		let turns = 0;
		await page.exposeFunction("qorperaTurn", (ms, base64) => {
			turns += 1;
			const file = `${turns}.webm`;
			const bytes = Buffer.from(base64, "base64");
			fs.writeFileSync(path.join(work, file), bytes);
			say({ turn: turns, file, ms, bytes: bytes.length });
		});
		const offer = await page.evaluate(async () => {
			const pc = new RTCPeerConnection();
			const audio = new AudioContext();
			await audio.resume();
			// One silent track out: the call wants a sender, and nothing is said to the voice by sound.
			const out = audio.createMediaStreamDestination();
			const quiet = audio.createConstantSource();
			quiet.offset.value = 0;
			quiet.connect(out);
			quiet.start();
			pc.addTrack(out.stream.getAudioTracks()[0], out.stream);
			const events = pc.createDataChannel("oai-events");
			const call = { pc, closed: false, level: () => 0, stream: null, recorder: null, chunks: [], began: 0, done: false };
			window.qorperaCall = call;
			pc.addEventListener("connectionstatechange", () => {
				if (["failed", "closed", "disconnected"].includes(pc.connectionState)) call.closed = true;
			});
			pc.ontrack = (event) => {
				const stream = event.streams[0] ?? new MediaStream([event.track]);
				// A remote track reaches the audio graph only while an element plays it.
				const element = new Audio();
				element.srcObject = stream;
				element.muted = true;
				element.play().catch(() => {});
				const analyser = audio.createAnalyser();
				analyser.fftSize = 2048;
				audio.createMediaStreamSource(stream).connect(analyser);
				const samples = new Float32Array(analyser.fftSize);
				call.level = () => {
					analyser.getFloatTimeDomainData(samples);
					let sum = 0;
					for (const value of samples) sum += value * value;
					return Math.sqrt(sum / samples.length);
				};
				call.stream = stream;
			};
			const begin = () => {
				if (!call.stream || call.recorder) return;
				call.chunks = [];
				call.done = false;
				call.began = performance.now();
				call.recorder = new MediaRecorder(call.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
				call.recorder.ondataavailable = (event) => {
					if (event.data.size) call.chunks.push(event.data);
				};
				call.recorder.start(200);
			};
			const finish = async () => {
				const recorder = call.recorder;
				if (!recorder) return;
				// The turn's last sound may still be on its way when the call says the turn is done.
				let heard = false;
				let quietSince = 0;
				const from = performance.now();
				while (performance.now() - from < 30000) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					const now = performance.now();
					if (call.level() > 0.004) {
						heard = true;
						quietSince = 0;
					} else {
						quietSince ||= now;
						if (now - quietSince > (heard ? 700 : 1500)) break;
					}
				}
				await new Promise((resolve) => {
					recorder.onstop = resolve;
					recorder.stop();
				});
				call.recorder = null;
				const bytes = new Uint8Array(await new Blob(call.chunks, { type: "audio/webm" }).arrayBuffer());
				let binary = "";
				for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
				await window.qorperaTurn(Math.round(performance.now() - call.began), btoa(binary));
			};
			events.onmessage = (event) => {
				let type;
				try {
					type = JSON.parse(event.data).type;
				} catch {
					return;
				}
				if (type === "turn.created") begin();
				else if (type === "turn.done" && call.recorder && !call.done) {
					call.done = true;
					void finish();
				}
			};
			await pc.setLocalDescription(await pc.createOffer());
			await new Promise((resolve) => {
				if (pc.iceGatheringState === "complete") return resolve();
				pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
				setTimeout(resolve, 4000);
			});
			return pc.localDescription.sdp;
		});
		say({ offer });
		const answerFile = path.join(work, "answer.sdp");
		const stopFile = path.join(work, "stop");
		for (let waited = 0; !fs.existsSync(answerFile); waited += 100) {
			if (waited > 60000 || fs.existsSync(stopFile)) throw new Error("no answer came");
			await sleep(100);
		}
		// The file may be seen before it is whole: it ends with a line break when it is.
		let answer = "";
		for (let tries = 0; tries < 20 && !answer.endsWith("\n"); tries++) {
			answer = fs.readFileSync(answerFile, "utf8");
			if (!answer.endsWith("\n")) await sleep(50);
		}
		await page.evaluate((sdp) => window.qorperaCall.pc.setRemoteDescription({ type: "answer", sdp }), answer);
		for (let waited = 0; ; waited += 100) {
			const state = await page.evaluate(() => ({ state: window.qorperaCall.pc.connectionState, track: Boolean(window.qorperaCall.stream) }));
			if (state.state === "connected" && state.track) break;
			if (state.state === "failed" || waited > 20000) throw new Error(`the call did not connect (${state.state})`);
			await sleep(100);
		}
		say({ connected: true });
		for (;;) {
			if (fs.existsSync(stopFile)) {
				ended = "stop";
				break;
			}
			if (Date.now() > until) break;
			if (await page.evaluate(() => window.qorperaCall.closed)) {
				ended = "closed";
				break;
			}
			await sleep(150);
		}
		// A turn that is being written out is let finish.
		for (let waited = 0; waited < 5000 && (await page.evaluate(() => Boolean(window.qorperaCall.recorder && window.qorperaCall.done))); waited += 100)
			await sleep(100);
	} catch (error) {
		ended = String(error && error.message ? error.message : error).slice(0, 300);
	} finally {
		await browser.close().catch(() => {});
		say({ ended });
	}
	process.exit(ended === "stop" || ended === "time" ? 0 : 1);
})();
