// How much of the corpus compiles once the ES 3.00 shim is applied?
//
// The number to beat is the pre-shim baseline measured by
// probe-gl-context.mjs: 440/681 (65%) with a naive header. Target is >90%.
import gl from 'native-gles';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { stagesFor } from '../src/video/shaders/glsl-es.js';

const CORPUS = process.argv[2]
  ?? '/tmp/claude-1000/-home-monteslu-code-cliemu/8d607e85-2b00-4f01-b123-94d31845fea9/scratchpad/glslsh';
const GL_VERTEX_SHADER = 0x8B31, GL_FRAGMENT_SHADER = 0x8B30, GL_COMPILE_STATUS = 0x8B81;

gl.createContext(256, 224);
gl.makeCurrent();

function compile(type, src) {
  const s = gl.glCreateShader(type);
  gl.glShaderSource(s, src);
  gl.glCompileShader(s);
  const ok = gl.glGetShaderiv(s, GL_COMPILE_STATUS);
  const log = ok ? '' : String(gl.glGetShaderInfoLog(s) ?? '').replace(/\0/g, '').trim().split('\n')[0];
  gl.glDeleteShader?.(s);
  return { ok: !!ok, log };
}

const all = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.glsl')) all.push(p);
  }
})(CORPUS);

let v = 0, f = 0, both = 0;
const causes = new Map();
for (const file of all) {
  const st = stagesFor(readFileSync(file, 'utf8'));
  const rv = compile(GL_VERTEX_SHADER, st.vertex);
  const rf = compile(GL_FRAGMENT_SHADER, st.fragment);
  if (rv.ok) v++;
  if (rf.ok) f++;
  if (rv.ok && rf.ok) both++;
  else {
    const msg = (rv.ok ? rf.log : rv.log) || '(no log)';
    const k = msg.replace(/`[^`]*'/g, "`X'").replace(/^\d+:\d+\(\d+\):\s*/, '').slice(0, 68);
    causes.set(k, (causes.get(k) ?? 0) + 1);
  }
}

const pct = (n) => `${((n / all.length) * 100).toFixed(1)}%`;
console.log(`corpus: ${all.length} shaders`);
console.log(`vertex   ${v}/${all.length}  ${pct(v)}`);
console.log(`fragment ${f}/${all.length}  ${pct(f)}`);
console.log(`BOTH     ${both}/${all.length}  ${pct(both)}   (pre-shim baseline: 440, 64.6%)`);
console.log('\nremaining failure causes:');
[...causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
process.exit(0);
