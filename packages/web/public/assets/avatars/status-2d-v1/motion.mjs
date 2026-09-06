import { eyeTracks } from './eye-tracks.mjs';

export const states = ['Idle', 'Working', 'Waiting', 'Blocked', 'Thinking', 'Done'];
export const notes = {
  Idle: 'A blink opens into an upward glance, then settles and holds.',
  Working: 'The eyes turn, disappear briefly, scan left, blink, and hold.',
  Waiting: 'The eyelids flatten as the gaze eases sideways, then holds.',
  Blocked: 'A quick contraction into an exclamation mark, held until the state changes.',
  Thinking: 'Three dots pulse in sequence on a 1.4-second cycle.',
  Done: 'A fast flourish, followed by a slower eye reaction and a settled finish.',
};
export const accents = ['#97cf66', '#a584d2', '#63bea9', '#658fd0', '#d98fa4', '#cfb94d'];
// The selected labels in the 60 fps recording determine these boundaries.
export const timelines = {
  Idle: { start: 2/60, end: 224/60 },
  Working: { start: 224/60, end: 874/60, loopStart: 0 },
  // The first contraction is visible one frame before the label changes.
  Waiting: { start: 874/60, end: 1153/60 },
  Blocked: { start: 1153/60, end: 1354/60, loopStart: .5 },
  Thinking: { start: 1354/60, end: 1653/60, loopStart: 1653/60-1354/60-4.2 },
  Done: { start: 1653/60, end: 2022/60 },
};
const tau = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const envelope = (t, a, b, c, d) => smooth(a, b, t) * (1 - smooth(c, d, t));

export function localTime(state, seconds) {
  const { start, end, loopStart } = timelines[state], duration = end-start;
  if (state === 'Idle' || state === 'Waiting' || state === 'Done') return Math.min(Math.max(0, seconds), duration-1/60);
  return seconds < duration ? Math.max(0, seconds) : loopStart+(seconds-duration)%(duration-loopStart);
}
export const referenceTime = (state, seconds) => timelines[state].start + localTime(state, seconds);

const faceKeys = ['x', 'y', 'width', 'height', 'rotation', 'alpha'];
function recordedFace(state, t) {
  const frames=eyeTracks[state], index=clamp(t*60,0,frames.length-1), lower=Math.floor(index);
  const a=frames[lower], b=frames[Math.min(lower+1,frames.length-1)], u=index-lower;
  return a.map((eye,j)=>Object.fromEntries(faceKeys.map((key,k)=> {
    // Hidden eyes stay at the visible end of a segment instead of crossing
    // the entire face when they reappear after a turn.
    const value=k<5&&eye[5]!==b[j][5]?(eye[5]?eye[k]:b[j][k]):eye[k]+(b[j][k]-eye[k])*u;
    return [key,value];
  })));
}

// A shared 100-unit artwork frame. Eye tracks retarget onto each original face.
export function pose(state, seconds, { reduced = false } = {}) {
  if (!states.includes(state) || !Number.isFinite(seconds)) throw new RangeError('Unknown state or time');
  const t = Math.max(0, seconds), u=localTime(state,t);
  const p = { scaleX: 1, scaleY: 1, turn: 0, x: 0, y: 0, body: 1,
    open: 1, eyes: 1, face: [0,1].map(()=>({x:0,y:0,width:1,height:1,rotation:0,alpha:1})),
    dots: [0,1,2].map(()=>({x:50,y:50,r:0,alpha:1})),
    stemTop: 50, stemBottom: 50, stemWidth: 0, alertDotY: 50, alertDotR: 0, strokes: [] };
  if (eyeTracks[state]) p.face=recordedFace(state,u);
  // Idle, Working and Waiting use recorded eye contours in the preview.
  // Fitted faces remain here for the transitions into the symbolic states.
  if (state === 'Blocked') {
    p.body = 1 - smooth(.01, .2, t); p.eyes = 1 - smooth(0, .08, t);
    p.stemTop = 50 - 21 * smooth(.08, .26, t);
    p.stemBottom = 50 + 10 * smooth(.08, .26, t);
    p.stemWidth = 7.5 * smooth(.08, .2, t);
    p.alertDotR = (4.4+6.6*envelope(t,.08,.14,.14,.26))*smooth(.05,.12,t);
    p.alertDotY = 50 + 21 * smooth(.1, .28, t);
  } else if (state === 'Thinking') {
    p.body = 1 - smooth(.01, .21, t); p.eyes = 1 - smooth(0, .09, t);
    const spread=smooth(.1,.34,t);
    for (let i = 0; i < 3; i++) {
      // Peaks measured at 23.75, 24.20, 24.67 seconds in the recording.
      const phase=(t-(23.75-timelines.Thinking.start)-i*1.4/3)/1.4;
      const wave=((1+Math.cos(tau*phase))/2)**2;
      p.dots[i] = { x: 50 + (i - 1) * 21.5 * spread, y: 50,
        r: (6.5+1.8*wave)*smooth(i===1?.06:.12,i===1?.18:.3,t), alpha:.46+.54*wave };
    }
  } else if (state === 'Done') {
    p.body=smooth(0,.23,t);p.eyes=smooth(.07,.2,t);
    const orbit=envelope(t,.5167,1.0,3.13,3.9);
    for(let i=0;i<6;i++) if(orbit>0) p.strokes.push({lane:i,head:t*tau/.6+i*1.04,
      length:(1.5+i%3*.25)*orbit,width:(2.5+i%2*.6)*orbit,
      expansion:.94+.06*orbit,color:accents[i]});
  }
  if (reduced) {
    p.body=p.eyes=1;p.strokes=[];
    p.face=state==='Waiting'?recordedFace('Waiting',2):[0,1].map(()=>({x:0,y:0,width:1,height:1,rotation:0,alpha:1}));
    if (state === 'Blocked') { p.body = p.eyes = 0; p.stemTop = 29; p.stemBottom = 60; p.stemWidth = 7.5; p.alertDotY = 71; p.alertDotR = 4.4; }
    if (state === 'Thinking') { p.body = p.eyes = 0; p.dots = [0,1,2].map(i => ({ x: 50+(i-1)*21.5,y:50,r:7.15,alpha:i===1?1:.46 })); }
  }
  p.open=clamp((p.face[0].height+p.face[1].height)/2);
  return p;
}

export function blend(from, to, amount) {
  const t = clamp(amount), result = { ...to };
  for (const key of Object.keys(to)) if (typeof to[key] === 'number') result[key] = from[key] + (to[key] - from[key]) * t;
  for (const key of ['dots','face']) result[key]=to[key].map((part,i)=>Object.fromEntries(Object.keys(part).map(k=>[k,from[key][i][k]+(part[k]-from[key][i][k])*t])));
  if (t < 1) result.strokes = [...from.strokes.map(s => ({...s,width:s.width*(1-t),length:s.length*(1-t)})),...to.strokes.map(s => ({...s,width:s.width*t,length:s.length*t}))];
  return result;
}
