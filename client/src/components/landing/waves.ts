// Hero backdrop: a slow fluid gradient in the site's blues; the pointer bends the flow.
// Returns a stop function; a browser without WebGL keeps the CSS gradient under the canvas.
const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FS = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec3 m;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n2(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*(3.0-2.0*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.0,a=0.5;
  mat2 rot=mat2(0.8,0.6,-0.6,0.8);
  for(int i=0;i<5;i++){v+=a*n2(p);p=rot*p*2.03;a*=0.5;}
  return v;
}
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*r)/r.y;
  vec2 mp=(m.xy-0.5*r)/r.y;
  float tt=t*0.045;
  vec2 pull=(mp-uv)*m.z*0.35*exp(-length(mp-uv)*2.2);
  vec2 p=uv*1.6+pull;
  vec2 q=vec2(fbm(p+vec2(0.0,tt)),fbm(p+vec2(5.2,1.3)-tt));
  vec2 w=vec2(fbm(p+3.0*q+vec2(1.7,9.2)+0.6*tt),fbm(p+3.0*q+vec2(8.3,2.8)-0.4*tt));
  float f=fbm(p+3.2*w);
  vec3 night=vec3(0.067,0.082,0.239);
  vec3 navy=vec3(0.094,0.184,0.49);
  vec3 sky=vec3(0.459,0.737,1.0);
  vec3 pale=vec3(0.714,0.827,1.0);
  vec3 amber=vec3(0.906,0.675,0.4);
  vec3 col=mix(night,navy,smoothstep(0.25,0.7,f));
  col=mix(col,sky,smoothstep(0.55,0.95,f)*0.55);
  col=mix(col,pale,smoothstep(0.78,1.0,f+0.25*length(w))*0.22);
  col=mix(col,amber,smoothstep(0.6,0.95,length(q))*smoothstep(0.7,0.95,f)*0.22);
  col*=0.82+0.18*smoothstep(0.0,0.6,f);
  col+=(h(gl_FragCoord.xy+t)-0.5)*0.02;
  gl_FragColor=vec4(col,1.0);
}`;

export function startWaves(canvas: HTMLCanvasElement): () => void {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return () => {};
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => {};
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const p = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(prog, 'r');
  const uT = gl.getUniformLocation(prog, 't');
  const uM = gl.getUniformLocation(prog, 'm');

  const mouse = { x: 0, y: 0, on: 0 };
  const hero = canvas.parentElement!;
  const onMove = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect();
    mouse.x = e.clientX - b.left;
    mouse.y = b.bottom - e.clientY;
    mouse.on = 1;
  };
  const onLeave = () => {
    mouse.on = 0;
  };
  hero.addEventListener('pointermove', onMove);
  hero.addEventListener('pointerleave', onLeave);

  const scale = Math.min(devicePixelRatio, 1.5);
  const size = () => {
    const w = Math.round(canvas.clientWidth * scale);
    const h = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };
  let visible = true;
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
  });
  io.observe(canvas);
  const start = performance.now();
  let raf = 0;
  const frame = () => {
    if (visible) {
      size();
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uT, still ? 0 : (performance.now() - start) / 1000);
      gl.uniform3f(uM, mouse.x * scale, mouse.y * scale, mouse.on);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (!still) raf = requestAnimationFrame(frame);
  };
  frame();

  return () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    hero.removeEventListener('pointermove', onMove);
    hero.removeEventListener('pointerleave', onLeave);
    // The context is left alive: StrictMode re-runs the effect on the same canvas, and a lost context stays lost.
  };
}
