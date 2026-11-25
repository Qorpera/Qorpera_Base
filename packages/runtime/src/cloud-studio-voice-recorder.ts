import { createHash } from "node:crypto";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import {
	EXPLAINER_VOICE_ENCODE_CJS,
	EXPLAINER_VOICE_PEER_CJS,
	explainerSpokenMatches,
	parseExplainerClips,
} from "./cloud-app-kit-explainer.ts";
import { narrateSpokenLine } from "./cloud-app-narrate-tool.ts";
import type { CloudCodingCommandGateway } from "./cloud-coding-command-tools.ts";
import { type CloudNativeToolIdentity, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import {
	type CloudVoiceCall,
	type CloudVoiceChannel,
	CloudVoiceLimitReached,
	type CloudVoiceName,
	CloudVoiceUnavailable,
	cloudVoiceUsageFull,
	MAX_CLOUD_VOICE_TEXT_BYTES,
} from "./cloud-voice-channel.ts";

export interface StudioChatGptVoiceMachine {
	readonly scope: CloudCodingCommandScope;
	readonly identity: CloudNativeToolIdentity;
	readonly operations: Pick<CloudNativeToolOperations, "execute">;
	readonly gateway: CloudCodingCommandGateway;
}

export interface StudioChatGptVoiceClip {
	readonly hash: string;
	readonly audio: Uint8Array;
	readonly mediaType: "audio/mp4" | "audio/wav";
	readonly fileExtension: "mp4" | "wav";
	readonly seconds: number;
}

export interface StudioChatGptVoiceSilent {
	readonly caption: string;
	readonly said: string;
}

export interface StudioChatGptVoiceBatchResult {
	readonly clips: readonly StudioChatGptVoiceClip[];
	readonly silent?: readonly StudioChatGptVoiceSilent[];
	readonly stopReason: "limit_reached" | "error" | null;
	readonly errorMessage?: string;
}

const MARK = "QORPERA-VOICE ";
const SCRIPT_END = "QORPERA_STUDIO_VOICE_SCRIPT_END";
const COMMAND_MAX_BYTES = 16_384;
const BUDGET_MS = 240_000;
const RESERVE_MS = 55_000;
const USAGE_MS = 10_000;
const PROBE_MS = 15_000;
const OFFER_MS = 40_000;
const CONNECTED_MS = 30_000;
const SPEAK_MS = 45_000;
const TURN_MS = 20_000;
const ENDED_MS = 45_000;
const ENCODE_MS = 90_000;
const READ_CLIP_MS = 30_000;
const READ_RPC_MS = 15_000;
const FINISHING_SECONDS = 20;
const TRIES = 3;
const SHOWN_CHARS = 200;
const LINE_MAX_BYTES = 256 * 1024;
const MAX_CLIP_BYTES = 8 * 1024 * 1024;
const CLIP_PAYLOAD = /^QORPERA_CLIP:([1-9][0-9]{0,7}):([0-9a-f]{64}):\n([A-Za-z0-9+/]*={0,2})$/;
const WORK_ROOT = "/tmp/qorpera-studio-voice";

type Line = Readonly<Record<string, unknown>>;

const STUDIO_CDP_VOICE_PEER_CJS = [
	'const { spawn } = require("node:child_process");',
	'const fs = require("node:fs");',
	'const path = require("node:path");',
	'const [work, limit = "240", finishing = "20"] = process.argv.slice(2);',
	'const say = (v) => console.log("QORPERA-VOICE " + JSON.stringify(v));',
	"const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
	'const bin = fs.existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : "chromium";',
	"const PAGE_OFFER_FN = `(",
	"async () => {",
	"  const pc = new RTCPeerConnection();",
	"  const audio = new AudioContext();",
	"  await audio.resume();",
	"  const out = audio.createMediaStreamDestination();",
	"  const quiet = audio.createConstantSource();",
	"  quiet.offset.value = 0; quiet.connect(out); quiet.start();",
	"  pc.addTrack(out.stream.getAudioTracks()[0], out.stream);",
	'  const events = pc.createDataChannel("oai-events");',
	"  const call = { pc, closed: false, level: () => 0, stream: null, recorder: null, chunks: [], began: 0, busy: false, failed: null };",
	"  window.qorperaCall = call;",
	"  call.settle = async (ms) => { const by = performance.now() + ms; while (call.busy && !call.failed && performance.now() < by) await new Promise((r) => setTimeout(r, 100)); return { busy: call.busy, failed: call.failed }; };",
	'  pc.addEventListener("connectionstatechange", () => { if (["failed","closed","disconnected"].includes(pc.connectionState)) call.closed = true; });',
	"  pc.ontrack = (event) => {",
	"    const stream = event.streams[0] ?? new MediaStream([event.track]);",
	"    const el = new Audio(); el.srcObject = stream; el.muted = true; el.play().catch(() => {});",
	"    const analyser = audio.createAnalyser(); analyser.fftSize = 2048;",
	"    audio.createMediaStreamSource(stream).connect(analyser);",
	"    const samples = new Float32Array(analyser.fftSize);",
	"    call.level = () => { analyser.getFloatTimeDomainData(samples); let s = 0; for (const v of samples) s += v * v; return Math.sqrt(s / samples.length); };",
	"    call.stream = stream;",
	"  };",
	"  const begin = () => {",
	"    if (!call.stream || call.recorder || call.busy) return;",
	"    call.chunks = []; call.began = performance.now();",
	'    call.recorder = new MediaRecorder(call.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });',
	"    call.recorder.ondataavailable = (e) => { if (e.data.size) call.chunks.push(e.data); };",
	"    call.recorder.start(200);",
	"  };",
	"  const finish = async () => {",
	"    const rec = call.recorder; if (!rec) return;",
	"    let heard = false, quietSince = 0; const from = performance.now();",
	"    while (performance.now() - from < 30000) {",
	"      await new Promise((r) => setTimeout(r, 100)); const now = performance.now();",
	"      if (call.level() > 0.004) { heard = true; quietSince = 0; } else { quietSince ||= now; if (now - quietSince > (heard ? 700 : 1500)) break; }",
	"    }",
	"    await new Promise((r) => { rec.onstop = r; rec.stop(); });",
	"    call.recorder = null;",
	'    const bytes = new Uint8Array(await new Blob(call.chunks, { type: "audio/webm" }).arrayBuffer());',
	'    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));',
	"    const seq = (window.qorperaTurnSeq = (window.qorperaTurnSeq || 0) + 1);",
	"    window.qorperaTurn(JSON.stringify({ seq, ms: Math.round(performance.now() - call.began), b64: btoa(bin) }));",
	"    const ackBy = performance.now() + 15000;",
	"    while ((window.qorperaTurnAck || 0) < seq && performance.now() < ackBy) await new Promise((r) => setTimeout(r, 25));",
	"    if ((window.qorperaTurnAck || 0) < seq) throw new Error('turn write did not settle');",
	"  };",
	"  events.onmessage = (event) => {",
	"    let type; try { type = JSON.parse(event.data).type; } catch { return; }",
	'    if (type === "turn.created") begin();',
	'    else if (type === "turn.done" && call.recorder && !call.busy) {',
	"      call.busy = true;",
	"      finish().catch((e) => { call.failed = String(e && e.message ? e.message : e).slice(0, 200); }).finally(() => { call.busy = false; });",
	"    }",
	"  };",
	"  await pc.setLocalDescription(await pc.createOffer());",
	'  await new Promise((r) => { if (pc.iceGatheringState === "complete") return r(); pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && r()); setTimeout(r, 4000); });',
	"  return pc.localDescription.sdp;",
	"})()`;",
	"(async () => {",
	'  if (!work || !path.isAbsolute(work)) throw new Error("work must be absolute");',
	"  fs.mkdirSync(work, { recursive: true });",
	"  const seconds = Math.max(10, Math.min(290, Number(limit) || 240));",
	"  const until = Date.now() + seconds * 1000;",
	"  const userData = path.join(work, 'chrome');",
	'  const proc = spawn(bin, ["--headless=new", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--remote-debugging-port=0", "--user-data-dir=" + userData, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });',
	"  let wsUrl = null, errBuf = '', spawnErr = null;",
	"  proc.on('error', (err) => { spawnErr = err; });",
	"  proc.stderr.setEncoding('utf8');",
	"  proc.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-4096); const m = /DevTools listening on (ws:\\/\\/[^\\s]+)/.exec(errBuf); if (m) wsUrl = m[1]; });",
	"  const bootBy = Date.now() + 20000;",
	"  while (!wsUrl && !spawnErr && proc.exitCode === null && Date.now() < bootBy) await sleep(50);",
	"  if (spawnErr) throw spawnErr;",
	'  if (!wsUrl) throw new Error("chromium did not open devtools");',
	"  const base = wsUrl.replace(/^ws:\\/\\//, 'http://').replace(/\\/devtools\\/.*/, '');",
	"  let targetWs = null;",
	"  for (let i = 0; i < 40 && !targetWs; i++) {",
	"    const list = await fetch(base + '/json/list').then((r) => r.json()).catch(() => []);",
	"    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);",
	"    if (page) targetWs = page.webSocketDebuggerUrl; else await sleep(50);",
	"  }",
	'  if (!targetWs) throw new Error("no browser page target");',
	"  const ws = new WebSocket(targetWs);",
	"  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools socket failed')); });",
	"  let nextId = 0, turns = 0; const pending = new Map();",
	"  const rejectAll = (msg) => { for (const p of pending.values()) p.rej(new Error(msg)); pending.clear(); };",
	"  ws.onclose = () => rejectAll('devtools socket closed');",
	"  ws.onerror = () => rejectAll('devtools socket error');",
	"  const send = (method, params = {}) => new Promise((res, rej) => { if (ws.readyState !== 1) return rej(new Error('devtools socket not open')); const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });",
	"  ws.onmessage = (ev) => {",
	"    const msg = JSON.parse(String(ev.data));",
	"    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }",
	"    if (msg.method === 'Runtime.bindingCalled' && msg.params && msg.params.name === 'qorperaTurn') {",
	"      const payload = JSON.parse(msg.params.payload);",
	"      turns += 1; const file = turns + '.webm'; const bytes = Buffer.from(payload.b64, 'base64');",
	"      fs.writeFileSync(path.join(work, file), bytes);",
	"      say({ turn: turns, file, ms: payload.ms, bytes: bytes.length });",
	"      if (typeof payload.seq === 'number') send('Runtime.evaluate', { expression: 'window.qorperaTurnAck = ' + payload.seq }).catch(() => {});",
	"    }",
	"  };",
	"  const evalJs = async (expression) => {",
	"    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });",
	"    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');",
	"    return r.result ? r.result.value : undefined;",
	"  };",
	"  let ended = 'time';",
	"  try {",
	"    await send('Runtime.enable');",
	"    await send('Runtime.addBinding', { name: 'qorperaTurn' });",
	"    const offer = await evalJs(PAGE_OFFER_FN);",
	"    say({ offer });",
	"    const answerPath = path.join(work, 'answer.sdp');",
	"    const stopPath = path.join(work, 'stop');",
	"    const answerBy = Math.min(until, Date.now() + 60000);",
	"    while (!fs.existsSync(answerPath)) {",
	"      if (fs.existsSync(stopPath)) { ended = 'stop'; break; }",
	"      if (Date.now() >= answerBy) { ended = 'no answer'; break; }",
	"      await sleep(100);",
	"    }",
	"    if (fs.existsSync(answerPath) && ended === 'time') {",
	"      const sdp = fs.readFileSync(answerPath, 'utf8');",
	"      await evalJs('window.qorperaCall.pc.setRemoteDescription({ type: \"answer\", sdp: ' + JSON.stringify(sdp) + ' })');",
	"      const connectBy = Math.min(until, Date.now() + 25000);",
	"      let ready = false;",
	"      while (Date.now() < connectBy) {",
	"        if (fs.existsSync(stopPath)) { ended = 'stop'; break; }",
	"        const st = await evalJs('({ state: window.qorperaCall.pc.connectionState, stream: Boolean(window.qorperaCall.stream), closed: window.qorperaCall.closed })');",
	"        if (st && st.closed) { ended = 'closed'; break; }",
	"        if (st && st.state === 'connected' && st.stream) { ready = true; break; }",
	"        await sleep(100);",
	"      }",
	"      if (ready) {",
	"        say({ connected: true });",
	"        while (Date.now() < until) {",
	"          if (fs.existsSync(stopPath)) { ended = 'stop'; break; }",
	"          const state = await evalJs('({ closed: window.qorperaCall.closed, failed: window.qorperaCall.failed })');",
	"          if (state && state.failed) { ended = state.failed; break; }",
	"          if (state && state.closed) { ended = 'closed'; break; }",
	"          await sleep(150);",
	"        }",
	"        const waitMs = Math.max(2000, Math.min(40000, (Number(finishing) || 20) * 1000));",
	"        const settled = await evalJs('window.qorperaCall.settle(' + waitMs + ')').catch(() => ({ busy: false, failed: null }));",
	"        if (settled && settled.failed) ended = settled.failed;",
	"        else if (settled && settled.busy) ended = 'turn stalled';",
	"      } else if (ended === 'time') {",
	"        ended = 'not connected';",
	"      }",
	"    }",
	"  } finally {",
	"    try { ws.close(); } catch {}",
	"    try { proc.kill('SIGKILL'); } catch {}",
	"  }",
	"  say({ ended });",
	"})().catch((e) => { say({ ended: String(e && e.message ? e.message : e).slice(0, 200) }); process.exit(1); });",
].join("\n");

const STUDIO_CDP_WAV_ENCODE_CJS = [
	'const { spawn } = require("node:child_process");',
	'const fs = require("node:fs");',
	'const path = require("node:path");',
	"const [work, outDir, ...pairs] = process.argv.slice(2);",
	'const say = (v) => console.log("QORPERA-VOICE " + JSON.stringify(v));',
	"const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
	'const bin = fs.existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : "chromium";',
	"function encodeWav(samples, rate) {",
	"  const buf = Buffer.alloc(44 + samples.length * 2);",
	'  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVEfmt ", 8);',
	"  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);",
	"  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);",
	'  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);',
	"  for (let i = 0; i < samples.length; i++) {",
	"    const s = Math.max(-1, Math.min(1, samples[i]));",
	"    buf.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), 44 + i * 2);",
	"  }",
	"  return buf;",
	"}",
	"(async () => {",
	'  if (!work || !outDir || !path.isAbsolute(work) || !path.isAbsolute(outDir) || pairs.length === 0) throw new Error("invalid args");',
	"  fs.mkdirSync(outDir, { recursive: true });",
	"  const userData = path.join(work, 'chrome-enc');",
	'  const proc = spawn(bin, ["--headless=new", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--remote-debugging-port=0", "--user-data-dir=" + userData, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });',
	"  let wsUrl = null, errBuf = '', spawnErr = null;",
	"  proc.on('error', (err) => { spawnErr = err; });",
	"  proc.stderr.setEncoding('utf8');",
	"  proc.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-4096); const m = /DevTools listening on (ws:\\/\\/[^\\s]+)/.exec(errBuf); if (m) wsUrl = m[1]; });",
	"  const bootBy = Date.now() + 20000;",
	"  while (!wsUrl && !spawnErr && proc.exitCode === null && Date.now() < bootBy) await sleep(50);",
	"  if (spawnErr) throw spawnErr;",
	'  if (!wsUrl) throw new Error("chromium did not open devtools");',
	"  const base = wsUrl.replace(/^ws:\\/\\//, 'http://').replace(/\\/devtools\\/.*/, '');",
	"  let targetWs = null;",
	"  for (let i = 0; i < 40 && !targetWs; i++) {",
	"    const list = await fetch(base + '/json/list').then((r) => r.json()).catch(() => []);",
	"    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);",
	"    if (page) targetWs = page.webSocketDebuggerUrl; else await sleep(50);",
	"  }",
	'  if (!targetWs) throw new Error("no browser page target");',
	"  const ws = new WebSocket(targetWs);",
	"  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools socket failed')); });",
	"  let nextId = 0, failed = false; const pending = new Map();",
	"  const rejectAll = (msg) => { for (const p of pending.values()) p.rej(new Error(msg)); pending.clear(); };",
	"  ws.onclose = () => rejectAll('devtools socket closed');",
	"  ws.onerror = () => rejectAll('devtools socket error');",
	"  ws.onmessage = (ev) => { const msg = JSON.parse(String(ev.data)); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); } };",
	"  const send = (method, params = {}) => new Promise((res, rej) => { if (ws.readyState !== 1) return rej(new Error('devtools socket not open')); const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });",
	"  const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed'); return r.result ? r.result.value : undefined; };",
	"  try {",
	"    await send('Runtime.enable');",
	"    for (const pair of pairs) {",
	"      const m = /^([1-9][0-9]{0,3}):([0-9a-f]{8})$/.exec(pair);",
	"      if (!m) { say({ problem: 'bad pair' }); failed = true; continue; }",
	"      const [, turn, hash] = m;",
	"      try {",
	"        const b64 = fs.readFileSync(path.join(work, turn + '.webm')).toString('base64');",
	"        const expr = '(async () => {' +",
	"          'const raw = Uint8Array.from(atob(' + JSON.stringify(b64) + '), (c) => c.charCodeAt(0)).buffer;' +",
	"          'const ctx = new AudioContext({ sampleRate: 24000 });' +",
	"          'const decoded = await ctx.decodeAudioData(raw);' +",
	"          'const ch = decoded.getChannelData(0); const sr = decoded.sampleRate; const thr = 0.004;' +",
	"          'let s = 0, e = ch.length - 1;' +",
	"          'while (s < ch.length && Math.abs(ch[s]) < thr) s++;' +",
	"          'while (e > s && Math.abs(ch[e]) < thr) e--;' +",
	"          'const lead = Math.round(sr * 0.03), tail = Math.round(sr * 0.1);' +",
	"          'const out = new Float32Array(lead + Math.max(0, e - s + 1) + tail);' +",
	"          'if (e >= s) out.set(ch.subarray(s, e + 1), lead);' +",
	"          'const bytes = new Uint8Array(out.buffer); let bin = \"\";' +",
	"          'for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));' +",
	"          'await ctx.close(); return { rate: sr, b64: btoa(bin), seconds: out.length / sr };' +",
	"          '})()';",
	"        const res = await evalJs(expr);",
	"        if (!res || !Number.isFinite(res.seconds) || res.seconds < 0.2) throw new Error('the turn holds no speech');",
	"        const rawBuf = Buffer.from(res.b64, 'base64');",
	"        const floats = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 4);",
	"        const file = hash + '.wav';",
	"        const partial = path.join(outDir, '.' + hash + '.part.wav');",
	"        fs.writeFileSync(partial, encodeWav(floats, res.rate));",
	"        fs.renameSync(partial, path.join(outDir, file));",
	"        say({ clip: hash, file, seconds: Math.round(res.seconds * 100) / 100 });",
	"      } catch (err) {",
	"        say({ clip: hash, problem: String(err && err.message ? err.message : err).slice(0, 200) });",
	"        failed = true;",
	"      }",
	"    }",
	"  } finally {",
	"    try { ws.close(); } catch {}",
	"    try { proc.kill('SIGKILL'); } catch {}",
	"  }",
	"  process.exit(failed ? 1 : 0);",
	"})().catch((e) => { say({ problem: String(e && e.message ? e.message : e).slice(0, 200) }); process.exit(1); });",
].join("\n");

const READ_CLIP_SCRIPT = [
	'const fs=require("node:fs"),crypto=require("node:crypto");',
	`const max=${MAX_CLIP_BYTES},p=process.argv[1];`,
	"(async()=>{try{",
	"const data=fs.readFileSync(p);",
	"if(!data.length||data.length>max)process.exit(46);",
	'const hash=crypto.createHash("sha256").update(data).digest("hex");',
	'const w=async(s)=>{if(!process.stdout.write(s))await new Promise((r)=>process.stdout.once("drain",r));};',
	'await w("QORPERA_CLIP:"+data.length+":"+hash+":\\n");',
	'for(let i=0;i<data.length;i+=49152)await w(data.subarray(i,Math.min(data.length,i+49152)).toString("base64"));',
	"}catch{process.exit(49);}})().catch(()=>process.exit(49));",
].join("");

function sha256hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function plain(text: unknown, max = 300): string {
	const flat = String(text)
		.replace(/[\0-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const stop = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}

function withScript(work: string, file: string, script: string, then: string): string {
	if (script.split("\n").includes(SCRIPT_END)) throw new Error("Voice helper script contains delimiter");
	const command = `mkdir -p ${work} && cat > ${work}/${file} <<'${SCRIPT_END}' && ${then}\n${script.endsWith("\n") ? script : `${script}\n`}${SCRIPT_END}\n`;
	if (Buffer.byteLength(command, "utf8") > COMMAND_MAX_BYTES) {
		throw new Error(`Studio voice command exceeds ${COMMAND_MAX_BYTES} bytes`);
	}
	return command;
}

function decodeClipPayload(rawOutput: string): Uint8Array | null {
	const match = CLIP_PAYLOAD.exec(rawOutput.trim());
	if (!match) return null;
	const declaredBytes = Number(match[1]);
	const declaredSha256 = match[2];
	const base64 = match[3] ?? "";
	if (
		!Number.isSafeInteger(declaredBytes) ||
		declaredBytes < 1 ||
		declaredBytes > MAX_CLIP_BYTES ||
		base64.length % 4 !== 0 ||
		base64.length !== Math.ceil(declaredBytes / 3) * 4
	) {
		return null;
	}
	const decoded = Buffer.from(base64, "base64");
	if (decoded.byteLength !== declaredBytes) return null;
	if (createHash("sha256").update(decoded).digest("hex") !== declaredSha256) return null;
	return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

class VoiceUnavailable extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

class VoiceLimit extends Error {}

export async function recordStudioChatGptVoiceClips(input: {
	readonly voice: Pick<CloudVoiceChannel, "open" | "usage">;
	readonly machine: StudioChatGptVoiceMachine;
	readonly callId: string;
	readonly voiceName?: CloudVoiceName;
	readonly captions: readonly { readonly hash: string; readonly text: string }[];
	readonly signal: AbortSignal;
	readonly timing?: { readonly now?: () => number; readonly pollMs?: number };
}): Promise<StudioChatGptVoiceBatchResult> {
	const { voice, machine, signal } = input;
	const { scope, identity, operations, gateway } = machine;
	const now = input.timing?.now ?? Date.now;
	const pollMs = input.timing?.pollMs ?? 200;
	const deadline = now() + BUDGET_MS;
	const left = () => deadline - now();
	const by = (ms: number) => Math.min(now() + ms, deadline);
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const tag = sha256hex(`${identity.runId}:${input.callId}`).slice(0, 24);
	const work = `${WORK_ROOT}-${tag}`;

	const usageNow = () =>
		withAbortScopes([signal], (usageSignal) => voice.usage(usageSignal), USAGE_MS).catch(() => undefined);
	const initialUsage = await usageNow();
	if (cloudVoiceUsageFull(initialUsage)) {
		return { clips: [], stopReason: "limit_reached" };
	}

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		) {
			throw new Error("Coding command result differs");
		}
		return receipt;
	};

	const startCommand = async (
		step: string,
		command: string,
		timeoutMs: number | null,
		cmdSignal: AbortSignal = signal,
	): Promise<CloudCodingCommandReceipt> => {
		const key = `studio-voice.${tag}.${step}`;
		const content = await operations.execute({
			operation: {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: key,
				arguments: {
					operationKey: key,
					command,
					...(timeoutMs === null ? {} : { timeoutMs }),
				},
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, effect) => {
				const started = checkedReceipt(
					await gateway.start(
						scope,
						{
							commandId: effect.receiptId,
							inputSha256: effect.inputSha256,
							command,
							timeoutMs,
						},
						effect.signal,
					),
					effect.receiptId,
					effect.inputSha256,
				);
				return { content: { kind: "json", value: started as unknown as JsonValue } };
			},
			signal: cmdSignal,
		});
		if (content.kind !== "json") throw new Error("Studio voice command receipt differs");
		return parseCloudCodingCommandReceipt(content.value);
	};

	const watch = (initialReceipt: CloudCodingCommandReceipt) => {
		const lines: Line[] = [];
		const state = {
			offset: initialReceipt.log.nextOffset,
			partial: "",
			raw: "",
			done: false,
			exitCode: initialReceipt.exitCode,
			said: "",
		};
		const takeLine = (line: string) => {
			if (!line.startsWith(MARK)) {
				if (line.trim()) state.said = plain(`${state.said} ${line}`.slice(-600));
				return;
			}
			try {
				const parsed = JSON.parse(line.slice(MARK.length)) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) lines.push(parsed as Line);
			} catch {
				return;
			}
		};
		const ingest = (receipt: CloudCodingCommandReceipt) => {
			state.raw += receipt.output;
			state.partial += receipt.output;
			state.offset = receipt.log.nextOffset;
			state.exitCode = receipt.exitCode;
			for (;;) {
				const at = state.partial.indexOf("\n");
				if (at < 0) break;
				takeLine(state.partial.slice(0, at));
				state.partial = state.partial.slice(at + 1);
			}
			if (Buffer.byteLength(state.partial) > LINE_MAX_BYTES) state.partial = "";
			const ended = receipt.state !== "running" && receipt.state !== "unconfirmed";
			if (ended && state.offset >= receipt.log.totalBytes) {
				if (state.partial) takeLine(state.partial);
				state.partial = "";
				state.done = true;
			}
		};
		ingest(initialReceipt);
		const poll = async (until: number): Promise<boolean> => {
			if (state.done) return false;
			let got: CloudCodingCommandReceipt;
			try {
				got = checkedReceipt(
					await cloudToolRequest(
						(requestSignal) =>
							gateway.read(
								scope,
								parseCloudCodingCommandRead({
									commandId: initialReceipt.commandId,
									offset: state.offset,
									limit: CLOUD_CODING_COMMAND_PAGE_BYTES,
								}),
								requestSignal,
							),
						signal,
						Math.max(1, Math.min(READ_RPC_MS, until - now())),
					),
					initialReceipt.commandId,
				);
			} catch (error) {
				signal.throwIfAborted();
				throw error;
			}
			ingest(got);
			return got.output !== "";
		};
		const until = async (find: (line: Line) => boolean, end: number): Promise<Line | undefined> => {
			for (;;) {
				const found = lines.find(find);
				if (found) return found;
				if (state.done || now() >= end) return undefined;
				if (!(await poll(end))) await pause(Math.max(1, Math.min(pollMs, end - now())), signal);
			}
		};
		const look = async (): Promise<void> => {
			const end = now() + READ_RPC_MS;
			while (!state.done && now() < end && (await poll(end)));
		};
		const finish = async (end: number): Promise<void> => {
			while (!state.done && now() < end) {
				if (!(await poll(end))) await pause(Math.max(1, Math.min(pollMs, end - now())), signal);
			}
		};
		return { commandId: initialReceipt.commandId, lines, state, until, look, finish };
	};

	const endedReason = (line: Line | undefined) => (line && "ended" in line ? plain(line.ended) : undefined);

	let worked = false;
	let peerId: string | null = null;
	let peerStopped = false;
	let peerEnded: string | undefined;
	let call: CloudVoiceCall | undefined;

	const stopPeer = async (peer?: ReturnType<typeof watch>) => {
		peerStopped = true;
		if (!peerId) return;
		const stopped =
			!signal.aborted &&
			(await startCommand("stop", `touch ${work}/stop`, 20_000).then(
				() => true,
				() => false,
			));
		const last =
			stopped && peer ? await peer.until((line) => "ended" in line, by(ENDED_MS)).catch(() => undefined) : undefined;
		peerEnded = endedReason(last);
		if ((!last || !peer?.state.done) && peerId) {
			const idToCancel = peerId;
			await withAbortScopes([], (cancelSignal) => gateway.cancel(scope, idToCancel, cancelSignal), 10_000).catch(
				() => undefined,
			);
		}
	};

	const clips: StudioChatGptVoiceClip[] = [];
	const silent: StudioChatGptVoiceSilent[] = [];
	let stopReason: "limit_reached" | "error" | null = null;
	let errorMessage: string | undefined;

	try {
		const probeScript = [
			'const out = { ffmpeg: false, pw: "" };',
			'const cp = require("node:child_process");',
			'try { cp.execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 }); out.ffmpeg = true; } catch {}',
			"if (process.env.QORPERA_PLAYWRIGHT) { out.pw = process.env.QORPERA_PLAYWRIGHT; } else {",
			'  for (const mod of ["playwright", "playwright-core"]) { try { require.resolve(mod); out.pw = mod; break; } catch {} }',
			"}",
			'console.log("QORPERA-VOICE " + JSON.stringify(out));',
		].join(" ");
		const probe = watch(
			await startCommand(
				"probe",
				`if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; "$NODE_BIN" -e ${shellQuote(probeScript)}`,
				PROBE_MS,
			),
		);
		worked = true;
		const probed = await probe.until((line) => typeof line.ffmpeg === "boolean", by(PROBE_MS));
		const hasFfmpeg = probed?.ffmpeg === true;
		const playwrightMod = typeof probed?.pw === "string" && probed.pw.trim() ? probed.pw.trim() : "";

		const peerSeconds = Math.max(10, Math.min(260, Math.floor(left() / 1000) - 5));
		const peerCommand = playwrightMod
			? withScript(
					work,
					"voice-peer.cjs",
					EXPLAINER_VOICE_PEER_CJS,
					`QORPERA_PLAYWRIGHT=${shellQuote(playwrightMod)} exec node ${work}/voice-peer.cjs ${work} ${peerSeconds} ${FINISHING_SECONDS}`,
				)
			: withScript(
					work,
					"voice-cdp-peer.cjs",
					STUDIO_CDP_VOICE_PEER_CJS,
					`exec node ${work}/voice-cdp-peer.cjs ${work} ${peerSeconds} ${FINISHING_SECONDS}`,
				);
		const peer = watch(await startCommand("peer", peerCommand, (peerSeconds + 60) * 1000));
		peerId = peer.commandId;

		const kept: { readonly turn: number; readonly caption: { readonly hash: string; readonly text: string } }[] = [];
		let callEnded: string | undefined;
		let limitMet = false;
		let heard = 0;
		let unanswered = false;
		const turnsPrinted = () =>
			peer.lines.reduce((most, line) => (typeof line.turn === "number" ? Math.max(most, line.turn) : most), 0);
		const unasked = () => {
			if (kept.at(-1)?.turn === heard) kept.pop();
			callEnded ??= "the recorder heard a turn that was not asked for";
		};

		try {
			try {
				const offer = await peer.until((line) => typeof line.offer === "string" || "ended" in line, by(OFFER_MS));
				if (typeof offer?.offer !== "string") {
					throw new VoiceUnavailable(
						`the coding machine voice recorder did not produce an offer${endedReason(offer) ? ` (${endedReason(offer)})` : ""}`,
					);
				}
				try {
					call = await voice.open(
						{ offerSdp: offer.offer, ...(input.voiceName ? { voice: input.voiceName } : {}) },
						signal,
					);
				} catch (error) {
					signal.throwIfAborted();
					if (error instanceof CloudVoiceLimitReached) throw new VoiceLimit();
					throw new VoiceUnavailable(
						error instanceof CloudVoiceUnavailable
							? "no voice call can be placed in this run"
							: "the voice call could not be placed",
					);
				}
				const answer = call.answerSdp.endsWith("\n") ? call.answerSdp : `${call.answerSdp}\n`;
				const handover = `mkdir -p ${work} && printf '%s' '${Buffer.from(answer, "utf8").toString("base64")}' | base64 -d > ${work}/answer.sdp.part && mv -f ${work}/answer.sdp.part ${work}/answer.sdp`;
				if (Buffer.byteLength(handover, "utf8") > COMMAND_MAX_BYTES) {
					throw new VoiceUnavailable("the call answer is too large to hand to the coding machine");
				}
				await startCommand("answer", handover, 20_000);
				const connected = await peer.until((line) => line.connected === true || "ended" in line, by(CONNECTED_MS));
				if (connected?.connected !== true) {
					throw new VoiceUnavailable(
						`the voice call did not connect to the coding machine recorder${endedReason(connected) ? ` (${endedReason(connected)})` : ""}`,
					);
				}
			} catch (error) {
				if (!(error instanceof VoiceUnavailable) && !(error instanceof VoiceLimit)) throw error;
				await call?.close().catch(() => undefined);
				call = undefined;
				await stopPeer(peer);
				const after = await usageNow();
				if (error instanceof VoiceLimit || cloudVoiceUsageFull(after)) {
					return { clips: [], stopReason: "limit_reached" };
				}
				return { clips: [], stopReason: "error", errorMessage: error.reason };
			}

			batch: for (const caption of input.captions) {
				if (signal.aborted || left() < RESERVE_MS) break;
				const spokenPrompt = narrateSpokenLine(caption.text);
				if (Buffer.byteLength(spokenPrompt, "utf8") > MAX_CLOUD_VOICE_TEXT_BYTES) {
					silent.push({ caption: plain(caption.text, SHOWN_CHARS), said: "" });
					continue;
				}
				let said = "";
				for (let attempt = 1; attempt <= TRIES; attempt++) {
					if (signal.aborted || left() < RESERVE_MS) break batch;
					await peer.look();
					if (turnsPrinted() > heard) {
						unasked();
						break batch;
					}
					try {
						const activeCall = call;
						said = (
							await withAbortScopes(
								[signal],
								(speakSignal) => activeCall.speak(spokenPrompt, speakSignal),
								Math.max(1, Math.min(SPEAK_MS, left())),
							)
						).transcript;
					} catch (error) {
						signal.throwIfAborted();
						limitMet = error instanceof CloudVoiceLimitReached;
						callEnded = "the voice call ended";
						unanswered = true;
						break batch;
					}
					heard += 1;
					const turn = heard;
					const recorded = await peer.until((line) => line.turn === turn || "ended" in line, by(TURN_MS));
					if (recorded?.turn !== turn) {
						callEnded =
							recorded && "ended" in recorded ? "the recorder ended" : "a recording did not arrive in time";
						break batch;
					}
					if (explainerSpokenMatches(caption.text, said)) {
						kept.push({ turn, caption });
						break;
					}
					if (attempt === TRIES) {
						silent.push({ caption: plain(caption.text, SHOWN_CHARS), said: plain(said, SHOWN_CHARS) });
					}
				}
			}
		} finally {
			await call?.close().catch(() => undefined);
			call = undefined;
			if (!peerStopped) await stopPeer(peer);
		}

		if (turnsPrinted() > heard + (unanswered ? 1 : 0)) unasked();
		const after = callEnded ? await usageNow() : initialUsage;
		if (callEnded && cloudVoiceUsageFull(after)) limitMet = true;

		const printed = new Set(peer.lines.filter((line) => typeof line.turn === "number").map((line) => line.turn));
		const encodable = kept.filter((each) => printed.has(each.turn));
		const encodedMeta: { readonly hash: string; readonly file: string; readonly seconds: number }[] = [];
		if (encodable.length > 0) {
			const pairs = encodable.map((each) => `${each.turn}:${each.caption.hash}`).join(" ");
			const encodeCmd = hasFfmpeg
				? withScript(
						work,
						"voice-encode.cjs",
						EXPLAINER_VOICE_ENCODE_CJS,
						`node ${work}/voice-encode.cjs ${work} ${work}/out ${pairs}`,
					)
				: withScript(
						work,
						"voice-wav-encode.cjs",
						STUDIO_CDP_WAV_ENCODE_CJS,
						`node ${work}/voice-wav-encode.cjs ${work} ${work}/out ${pairs}`,
					);
			const encoder = watch(await startCommand("encode", encodeCmd, ENCODE_MS + 30_000));
			const wanted = new Set(encodable.map((each) => each.caption.hash));
			await encoder.finish(now() + ENCODE_MS);
			for (const line of encoder.lines) {
				if (typeof line.clip !== "string" || !wanted.has(line.clip) || "problem" in line) continue;
				const file = typeof line.file === "string" ? line.file : "";
				const seconds = typeof line.seconds === "number" ? line.seconds : Number.NaN;
				if (file.endsWith(".mp4")) {
					const parsed = parseExplainerClips(
						JSON.stringify({ clips: [{ caption: line.clip, file, seconds }] }),
					)[0];
					if (parsed) encodedMeta.push({ hash: parsed.caption, file: parsed.file, seconds: parsed.seconds });
				} else if (file === `${line.clip}.wav` && Number.isFinite(seconds) && seconds > 0 && seconds <= 60) {
					encodedMeta.push({ hash: line.clip, file, seconds: Math.round(seconds * 100) / 100 });
				}
			}
		}

		for (let i = 0; i < encodedMeta.length; i++) {
			const meta = encodedMeta[i]!;
			const clipPath = `${work}/out/${meta.file}`;
			const reader = watch(
				await startCommand(
					`read-${i}`,
					`if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" -e ${shellQuote(READ_CLIP_SCRIPT)} -- ${shellQuote(clipPath)} 2>/dev/null`,
					READ_CLIP_MS,
				),
			);
			await reader.finish(now() + READ_CLIP_MS);
			const bytes = decodeClipPayload(reader.state.raw);
			if (!bytes) continue;
			const isWav = meta.file.endsWith(".wav");
			clips.push({
				hash: meta.hash,
				audio: bytes,
				mediaType: isWav ? "audio/wav" : "audio/mp4",
				fileExtension: isWav ? "wav" : "mp4",
				seconds: meta.seconds,
			});
		}

		if (limitMet) {
			stopReason = "limit_reached";
		} else if (callEnded || (peerEnded && peerEnded !== "stop" && peerEnded !== "time")) {
			stopReason = "error";
			errorMessage = callEnded ?? `The recorder ended early: ${peerEnded}`;
		}
	} catch (error) {
		if (signal.aborted) throw error;
		stopReason = "error";
		errorMessage = error instanceof Error ? error.message : String(error);
	} finally {
		await call?.close().catch(() => undefined);
		if (peerId && !peerStopped) {
			await withAbortScopes([], (cancelSignal) => gateway.cancel(scope, peerId!, cancelSignal), 10_000).catch(
				() => undefined,
			);
		}
		if (worked) {
			await withAbortScopes(
				[],
				(cleanSignal) => startCommand("clean", `rm -rf ${work}`, 15_000, cleanSignal),
				15_000,
			).catch(() => undefined);
		}
	}

	return {
		clips,
		...(silent.length > 0 ? { silent } : {}),
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
	};
}
