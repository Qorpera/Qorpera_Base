import { recordedClips } from './recorded-clips.mjs';
import { workingPalette } from './working-palette.mjs';

const sheets={};
let cached='', eyePath;
let source, colors, front, eyeMask, eyeRaster, soft;
const loading = new Map();

export function loadRecordedMotion(state, base) {
  if (!recordedClips[state]) return Promise.resolve();
  if (loading.has(state)) return loading.get(state);
  if (!source) {
    [source, colors, front, eyeMask, eyeRaster, soft] = Array.from({length:6}, () => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=160;return canvas;
    });
  }
  const run=Promise.all(recordedClips[state].atlases.map(async file=>{
    const image=new Image();image.src=new URL(file,base);await image.decode();return image;
  })).then(images=>{sheets[state]=images;}).catch(error=>{loading.delete(state);throw error;});
  loading.set(state,run);
  return run;
}

function prepare(state,frame) {
  const key=state+':'+frame;
  if(cached===key)return;
  const data=recordedClips[state].frames[frame], tile=frame%130, sheet=sheets[state][Math.floor(frame/130)];
  source.getContext('2d').drawImage(sheet,(tile%10)*160,Math.floor(tile/10)*160,160,160,0,0,160,160);
  eyePath=new Path2D();
  for(const ring of data.eyes) {
    if(!ring.length)continue;eyePath.moveTo(...ring[0]);
    for(let i=1;i<ring.length;i++)eyePath.lineTo(...ring[i]);eyePath.closePath();
  }
  const c=colors.getContext('2d'), pixels=source.getContext('2d').getImageData(0,0,160,160).data, overlay=c.createImageData(160,160);
  // Recover the recording's soft eye edges instead of enlarging the hard
  // pixel-cell contours used for inspection. Keep edge fragments within the
  // source silhouette so its dark background cannot become part of an eye.
  const mask=eyeMask.getContext('2d');mask.clearRect(0,0,160,160);mask.fillStyle=mask.strokeStyle='#fff';mask.fill(eyePath);
  const core=mask.getImageData(0,0,160,160).data;
  mask.lineWidth=2;mask.lineJoin='round';mask.stroke(eyePath);
  const expanded=mask.getImageData(0,0,160,160).data,eyes=mask.createImageData(160,160);
  for(let y=0;y<160;y++)for(let x=0;x<160;x++) {
    const i=(y*160+x)*4;
    const interior=(x+.5-data.c[0])**2+(y+.5-data.c[1])**2<(data.c[2]-2.5)**2;
    if(!(interior?expanded:core)[i+3])continue;
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(Math.max(r,g,b)-Math.min(r,g,b)>25)continue;
    eyes.data.set([255,255,255,Math.round(255-(r+g+b)/3)],i);
  }
  eyeRaster.getContext('2d').putImageData(eyes,0,0);
  // Recover transparency from the recording's background, avoiding dark
  // fringes when its colored strokes are displayed on a light surface.
  const backgroundAt=(x,y)=>(x+.5-data.c[0])**2+(y+.5-data.c[1])**2<data.c[2]**2?[255,255,255]:[8,10,8];
  const fit=(index,color,background)=>{
    const v=color.map((n,j)=>n-background[j]),p=[0,1,2].map(j=>pixels[index+j]-background[j]);
    const a=Math.max(0,Math.min(1,p.reduce((sum,n,j)=>sum+n*v[j],0)/v.reduce((sum,n)=>sum+n*n,0)));
    return [a,p.reduce((sum,n,j)=>sum+(n-v[j]*a)**2,0)];
  };
  const choice=new Int8Array(160*160).fill(-1),strength=new Float32Array(160*160);
  let left=160,top=160,right=-1,bottom=-1;
  for(let i=0;i<data.runs.length;i+=3)for(let x=data.runs[i+1];x<data.runs[i+1]+data.runs[i+2];x++) {
    const y=data.runs[i],cell=y*160+x,background=backgroundAt(x,y);
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    let best=Infinity;
    workingPalette.forEach((color,k)=>{const [a,error]=fit(cell*4,color,background);if(error<best){best=error;choice[cell]=k;strength[cell]=a;}});
  }
  left=Math.max(0,left-1);top=Math.max(0,top-1);right=Math.min(159,right+1);bottom=Math.min(159,bottom+1);
  // The per-pixel match leaves stray specks inside a stroke and a hard edge
  // where the recording's soft fringe lies outside the stroke mask. Settle a
  // speck on the colour most of its neighbours chose, and let the fringe
  // pixels take their neighbours' colour at the transparency the recording
  // shows, away from the body's rim where the background changes.
  const counts=new Uint8Array(workingPalette.length);
  const around=(x,y,source)=>{
    counts.fill(0);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
      if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=160||ny>=160)continue;
      const k=source[ny*160+nx];if(k>=0)counts[k]++;
    }
    let majority=-1,most=0;counts.forEach((n,k)=>{if(n>most){most=n;majority=k;}});
    return [majority,most];
  };
  const settled=Int8Array.from(choice);
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++) {
    const cell=y*160+x;if(choice[cell]<0)continue;
    const [majority,most]=around(x,y,choice);
    if(majority!==choice[cell]&&most>=3&&counts[choice[cell]]<=1) {
      settled[cell]=majority;strength[cell]=fit(cell*4,workingPalette[majority],backgroundAt(x,y))[0];
    }
  }
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++) {
    const cell=y*160+x;
    let k=settled[cell],a=strength[cell];
    if(k<0) {
      const [majority,most]=around(x,y,settled);
      if(majority<0||most<2||Math.abs(Math.hypot(x+.5-data.c[0],y+.5-data.c[1])-data.c[2])<2)continue;
      a=fit(cell*4,workingPalette[majority],backgroundAt(x,y))[0];
      if(a<.12)continue;
      k=majority;
    }
    overlay.data.set([...workingPalette[k],Math.round(a*255)],cell*4);
  }
  c.putImageData(overlay,0,0);
  // Soften the pixel steps by half a source pixel, as the body's silhouette is.
  soft.getContext('2d').clearRect(0,0,160,160);
  const sc=soft.getContext('2d');sc.filter='blur(0.5px)';sc.drawImage(colors,0,0);sc.filter='none';
  c.clearRect(0,0,160,160);c.drawImage(soft,0,0);
  const f=front.getContext('2d');f.clearRect(0,0,160,160);f.globalCompositeOperation='source-over';f.drawImage(colors,0,0);
  f.globalCompositeOperation='destination-in';f.beginPath();f.arc(data.c[0],data.c[1],data.c[2]+1,0,Math.PI*2);f.fill();f.globalCompositeOperation='source-over';
  cached=key;
}

export function drawRecordedReference(canvas,state,frame,outline=false) {
  prepare(state,frame);const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0,canvas.width,canvas.height);
  if(outline){ctx.save();ctx.scale(canvas.width/160,canvas.height/160);ctx.strokeStyle='#35cbae';ctx.lineWidth=.6;ctx.stroke(eyePath);ctx.restore();}
  canvas.dataset.frame=String(frame);
  canvas.dataset.activity=state;
}

export function drawRecordedEyes(ctx,eyes,state,frame,field) {
  prepare(state,frame);
  const scale=(eyes[0].height+eyes[1].height)/2/26.788061;
  ctx.save();ctx.fillStyle='#fff';
  // One fixed transform for the complete eye field. No eye reassignment,
  // angle reconstruction, gaze gain, silhouette clamp or temporal easing.
  ctx.translate((eyes[0].x+eyes[1].x)/2,(eyes[0].y+eyes[1].y)/2);
  ctx.scale(scale,scale);ctx.translate(-96.495,-71.789);
  // The Working sequencer may mirror or turn the whole field about the
  // source body's centre, and slide it in source pixels while a join settles.
  if(field){ctx.translate(80,80);ctx.rotate(field.tilt*Math.PI/180);ctx.scale(field.mirror?-1:1,1);ctx.translate(field.x-80,field.y-80);}
  ctx.drawImage(eyeRaster,0,0);ctx.restore();
}

export function drawWorkingStrokes(ctx,frame,isFront,field) {
  prepare('Working',frame);
  // The original recording's visible stroke pixels, on the same frame as
  // the eyes. Source circle diameter 112 px maps to an 80-unit avatar body.
  ctx.save();
  if(field){ctx.translate(50,50);ctx.rotate(field.tilt*Math.PI/180);ctx.scale(field.mirror?-1:1,1);ctx.translate(-50,-50);}
  ctx.drawImage(isFront?front:colors,50-80/112*80,50-80/112*80,160*80/112,160*80/112);
  ctx.restore();
}
