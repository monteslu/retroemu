// Make a libretro .glsl shader compile as GLSL ES 3.00.
//
// The corpus targets desktop GLSL 110/120/130. It is ALREADY written for
// portability — 674 of 681 shaders carry `#ifdef GL_ES` branches — so this is
// not a port, it is a header plus a handful of mechanical rewrites.
//
// Measured before any shim (scripts/probe-gl-context.mjs): 645/681 vertex and
// 446/681 fragment stages compiled, 440 both. The dominant failure was ONE
// cause — 141 of 241 were "initializer of global variable must be a constant
// expression". That is the hoist below.
//
// THE THING THAT LOOKS LIKE A BUG AND IS NOT: a .glsl holds BOTH stages in one
// file, split by `#if defined(VERTEX)` / `#if defined(FRAGMENT)`. RetroArch
// compiles the same file TWICE with -DVERTEX / -DFRAGMENT and lets the
// shader's own #if branches select. Do not hand-strip the branches: that
// leaves both COMPAT_* macro definitions in scope and fails every file on a
// macro redefinition, which is indistinguishable from the corpus being
// incompatible. An early probe did exactly this and reported 5% compatibility.

/**
 * Hoist non-constant global initializers into main().
 *
 * Desktop GLSL lets a global be initialized from a uniform:
 *
 *     uniform float scanlinealpha;
 *     float ScanlineAlpha = scanlinealpha;   // legal on desktop, NOT in ES 3.00
 *
 * ES 3.00 requires global initializers to be constant expressions. rcheevos of
 * the shader world: the fix is mechanical — declare the global bare, and
 * assign it at the top of main().
 *
 * Only touches declarations whose initializer references a non-literal, so
 * `const float pi = 3.14;` and `float x = 1.0;` are left alone.
 */
function hoistGlobalInitializers(src) {
  const lines = src.split('\n');
  const hoisted = [];
  let depth = 0;
  let condDepth = 0;   // #if / #ifdef nesting

  const out = lines.map((line) => {
    // Track brace depth so we only touch GLOBAL scope. A local
    // `float a = uniformThing;` inside a function is perfectly legal.
    //
    // Depth alone is the test. An earlier version also latched an `inMain`
    // flag on the first `void main(`, which broke every two-stage file: a
    // .glsl contains BOTH stages, so the vertex stage's main appears before
    // the fragment stage's globals and the flag suppressed the very
    // declarations this exists to fix. 140 shaders kept failing.
    const t = line.trim();
    if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) condDepth++;
    else if (/^#\s*endif\b/.test(t)) condDepth = Math.max(0, condDepth - 1);

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    const wasGlobal = depth === 0;
    depth += opens - closes;
    // selectStage() has already cut the other stage, so a global here really
    // is global for THIS stage. Remaining conditionals (GL_ES, __VERSION__)
    // are still skipped: their declarations may not survive the real
    // preprocessor while a hoisted assignment would.
    if (!wasGlobal || condDepth > 0) return line;

    // float NAME = EXPR;  — with optional precision qualifier and array-free
    // scalar/vector/matrix types. Deliberately narrow: this rewrite is only
    // safe on shapes we fully recognise.
    const m = /^(\s*)((?:highp|mediump|lowp|COMPAT_PRECISION)?\s*(?:float|vec2|vec3|vec4|int|ivec2|ivec3|ivec4|mat2|mat3|mat4)\s+)(\w+)\s*=\s*([^;]+);\s*$/.exec(line);
    if (!m) return line;
    const [, indent, typePart, name, expr] = m;
    if (/^\s*const\b/.test(line)) return line;              // const must keep its initializer
    // A literal-only initializer is already a constant expression.
    if (/^[\s\d.+\-*/()eE,]*$/.test(expr)) return line;
    // vec3(0.5, 0.5, 0.5) and friends are constant too.
    if (/^\s*(?:vec[234]|mat[234]|ivec[234])\s*\([\s\d.+\-*/(),eE]*\)\s*$/.test(expr)) return line;

    hoisted.push(`  ${name} = ${expr};`);
    return `${indent}${typePart}${name};`;
  });

  if (!hoisted.length) return out.join('\n');

  // Inject at the top of EVERY main() body, not just the first.
  //
  // A .glsl holds both stages, each with its own main, and which one survives
  // is decided by the preprocessor AFTER this runs. Injecting only into the
  // first main put fragment-stage assignments inside the vertex main, where
  // those variables do not exist: 172 shaders failed with "`X' undeclared"
  // and vertex coverage fell from 95.6% to 75.5%.
  //
  // Guarding each assignment on its own `#ifdef` is not possible here (the
  // declaration and the use are in the same branch), so instead every hoisted
  // assignment is emitted into every main, and the ones whose declaration was
  // cut are cut with it — because the DECLARATION line stays inside its
  // original #if branch, and an assignment to a name that was never declared
  // in this stage would fail. So: only hoist names declared at global scope
  // OUTSIDE any conditional, which is the safe subset.
  const joined = out.join('\n');
  const mainRe = /(\bvoid\s+main\s*\([^)]*\)\s*\{)/g;
  if (!mainRe.test(joined)) return joined;
  mainRe.lastIndex = 0;
  return joined.replace(mainRe, `$1\n${hoisted.join('\n')}`);
}

/**
 * Resolve ONLY the VERTEX/FRAGMENT stage conditionals, leaving every other
 * #if (GL_ES, __VERSION__, feature checks) untouched for the real
 * preprocessor.
 *
 * This is needed because the hoist has to know which declarations survive in
 * THIS stage: the target declarations live inside `#if defined(FRAGMENT)`,
 * so a hoist that skips conditionals never sees them, and one that ignores
 * conditionals injects fragment assignments into the vertex main. Cutting the
 * stage branches first makes both problems disappear.
 */
function selectStage(src, stage) {
  const keep = stage === 'vertex' ? 'VERTEX' : 'FRAGMENT';
  const drop = stage === 'vertex' ? 'FRAGMENT' : 'VERTEX';
  const out = [];
  // Stack of { isStageCond, emitting }
  const stack = [];
  let emitting = true;

  for (const line of src.split('\n')) {
    const t = line.trim();
    const ifm = /^#\s*if\s+defined\s*\(\s*(VERTEX|FRAGMENT)\s*\)\s*$/.exec(t)
      ?? /^#\s*ifdef\s+(VERTEX|FRAGMENT)\s*$/.exec(t);
    if (ifm) {
      const on = ifm[1] === keep;
      stack.push({ stageCond: true, prev: emitting });
      emitting = emitting && on;
      continue;                       // the directive itself is consumed
    }
    if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) {
      stack.push({ stageCond: false, prev: emitting });
      if (emitting) out.push(line);
      continue;
    }
    // #elif belongs to the innermost #if. For a stage conditional it can only
    // turn emission back on if the stage branch was off; for anything else it
    // must pass through, or the real preprocessor sees "#elif without #if"
    // because we consumed the opening directive.
    if (/^#\s*elif\b/.test(t) && stack.length) {
      const top = stack[stack.length - 1];
      if (top.stageCond) {
        // `#elif defined(FRAGMENT)` is the OTHER half of a stage split, and
        // it is how most of the corpus is written — crt-geom-mini included.
        // Treating it as a plain elif forced the fragment stage off and the
        // program failed to link with "fragment shader lacks `main'".
        const em = /^#\s*elif\s+defined\s*\(\s*(VERTEX|FRAGMENT)\s*\)\s*$/.exec(t);
        emitting = em ? (top.prev && em[1] === keep) : false;
        continue;
      }
      if (emitting || top.prev) out.push(line);
      continue;
    }
    if (/^#\s*else\b/.test(t) && stack.length) {
      const top = stack[stack.length - 1];
      if (top.stageCond) { emitting = top.prev && !emitting; continue; }
      // A NON-stage #else must be passed through whenever its enclosing scope
      // is live — and `emitting` is exactly that, because a non-stage #if
      // never changed it. Testing `emitting || top.prev` emitted the directive
      // even inside a cut stage branch, so BOTH halves of a
      // `#if __VERSION__ >= 130 / #else` survived: `out vec4 FragColor;` AND
      // `#define FragColor gl_FragColor`. The macro then renamed the declared
      // output, every write went to a nonexistent gl_FragColor, and the
      // program linked with ONE uniform and rendered black.
      if (emitting) out.push(line);
      continue;
    }
    if (/^#\s*endif\b/.test(t) && stack.length) {
      const top = stack.pop();
      if (top.stageCond) { emitting = top.prev; continue; }
      if (emitting) out.push(line);
      continue;
    }
    if (emitting) out.push(line);
  }
  void drop;
  return out.join('\n');
}

/**
 * Rewrite legacy GLSL keywords the corpus's own #if branches do not cover.
 *
 * Most files define COMPAT_VARYING/COMPAT_TEXTURE themselves and pick the
 * right one from __VERSION__. Older ones use `varying`/`attribute`/`texture2D`
 * bare, which ES 3.00 rejects outright.
 */
function modernizeKeywords(src, stage) {
  let s = src;
  // Only rewrite where the file did NOT already define the compat macros —
  // touching those files would fight their own branches.
  const hasCompat = /#define\s+COMPAT_VARYING/.test(s);
  if (!hasCompat) {
    s = s.replace(/^\s*attribute\b/gm, 'in');
    s = s.replace(/^\s*varying\b/gm, stage === 'vertex' ? 'out' : 'in');
  }
  // texture2D/texture3D are gone in ES 3.00; `texture` is overloaded.
  s = s.replace(/\btexture2D\s*\(/g, 'texture(');
  s = s.replace(/\btexture2DLod\s*\(/g, 'textureLod(');
  s = s.replace(/\btexture2DProj\s*\(/g, 'textureProj(');
  s = s.replace(/\btexture3D\s*\(/g, 'texture(');
  return s;
}

/**
 * Build the compilable source for ONE stage of a libretro .glsl.
 *
 * @param {string} source raw file contents
 * @param {'vertex'|'fragment'} stage
 * @returns {string}
 */
export function toGlslEs300(source, stage) {
  // The file's own #version is for desktop GL and must not survive: ES 3.00
  // requires `#version 300 es` to be the very first line.
  let body = String(source).replace(/^\s*#version.*$/gm, '');
  body = selectStage(body, stage);
  body = modernizeKeywords(body, stage);
  body = hoistGlobalInitializers(body);

  const isVert = stage === 'vertex';
  // gl_FragColor is gone in ES 3.00. Files that already declare their own
  // output under __VERSION__ >= 130 must NOT get a second declaration — that
  // is a `FragColor redeclared` error, and an early probe hit it on every file.
  // Does the shader declare its OWN fragment output? Only a real `out vec4`
  // counts. An earlier version also accepted `#define COMPAT_VARYING out`,
  // which is about VARYINGS, not the colour output — shaders that use it but
  // write to gl_FragColor then got no output declared at all and failed with
  // "`gl_FragColor' undeclared". 39 presets.
  const declaresOwnOutput = /^\s*out\s+(?:highp|mediump|lowp|COMPAT_PRECISION\s+)?vec4\s+\w+/m.test(body);

  const header = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    `#define ${isVert ? 'VERTEX' : 'FRAGMENT'} 1`,
  ];
  // PARAMETER_UNIFORM must be DEFINED, and each `#pragma parameter` the shader
  // does not declare itself must be declared here.
  //
  // This was originally decided by shader COMPILE rate, which picked the wrong
  // answer. Compile rate says "inject nothing" wins by 0.7 points:
  //
  //   define + declare all params      30.4%   (416 redeclared)
  //   define + declare missing only    80.5%
  //   declare missing, macro undefined 80.9%
  //   inject nothing                   81.6%
  //
  // But a shader that COMPILES is not a shader that RENDERS. With the macro
  // undefined the corpus falls into its `#else` branch, whose values are
  // placeholders, not defaults — ntsc-simple-2 sets `#define steps 0.1`, so
  // `int N = int(steps)` is 0, `for (i=-N; i<N; i++)` never runs, the only
  // texture read is dead code, the driver eliminates the sampler, and the pass
  // outputs a constant. It compiles perfectly and renders black. RetroArch
  // defines PARAMETER_UNIFORM, which is why the same preset works there.
  //
  // Declaring only what the shader does not declare itself avoids the 416
  // redeclaration errors that made the naive version score 30%.
  const params = parseParameters(source);
  if (params.length) {
    const selfDeclared = new Set();
    // Any qualifier, not just COMPAT_PRECISION — shaders spell it PRECISION,
    // COMPAT_PRECISION, highp/mediump/lowp, or nothing. Missing one means we
    // declare a uniform the shader already has ("`SHARPNESS' redeclared").
    const declRe = /\buniform\s+(?:\w+\s+)?float\s+(\w+)/g;
    let dm;
    while ((dm = declRe.exec(body)) !== null) selfDeclared.add(dm[1]);
    const missing = params.filter((x) => !selfDeclared.has(x.name));
    // Match the precision the shader ITSELF uses for its uniforms. Guessing
    // wrong either way is a cross-stage link error ("declared as type float
    // and type float16_t"): COMPAT_PRECISION is mediump in most ES builds but
    // some shaders spell out highp. Read it off the file.
    // Precision must match what the SHADER uses for the SAME uniform in its
    // other stage, or the program fails to link ("declared as type float16_t
    // and type float"). Two traps:
    //   - a shader often declares its parameter uniforms in only ONE stage, so
    //     a per-stage guess differs between vertex and fragment
    //   - an UNQUALIFIED `uniform float X` is highp, not mediump
    // So: look at the whole source, and prefer the qualifier actually used on
    // a parameter declaration; unqualified wins because it is the strictest.
    const src = String(source);
    const unqualified = /^\s*uniform\s+float\s+\w+/m.test(src);
    const precM = /uniform\s+(highp|mediump|lowp)\s+float\s+\w+/.exec(src)
      ?? /#define\s+COMPAT_PRECISION\s+(highp|mediump|lowp)/.exec(src);
    const prec = unqualified ? 'highp' : (precM ? precM[1] : 'mediump');
    header.push('#define PARAMETER_UNIFORM 1');
    // mediump, matching what the corpus's own `uniform COMPAT_PRECISION float
    // NAME` resolves to in an ES build. Declaring the same name as highp
    // `float` is a cross-stage precision mismatch ("declared as type float and
    // type float16_t") that fails the LINK on ~100 shaders. COMPAT_PRECISION
    // itself cannot be used here — the shader defines it further down, after
    // this header.
    for (const x of missing) header.push(`uniform ${prec} float ${x.name};`);
  }
  // gl_FragColor does not exist in ES 3.00. A shader that declares no output
  // of its own (GLSL-120-era files that only `#define FragColor gl_FragColor`)
  // needs one supplied, or it fails with "`gl_FragColor' undeclared".
  if (!isVert && !declaresOwnOutput) {
    header.push('out vec4 _retroemuFragColor;', '#define gl_FragColor _retroemuFragColor');
  }
  return `${header.join('\n')}\n${body}`;
}

/** Both stages at once, the way a pass needs them. */
export function stagesFor(source) {
  return {
    vertex: toGlslEs300(source, 'vertex'),
    fragment: toGlslEs300(source, 'fragment'),
  };
}

/**
 * Parse `#pragma parameter NAME "Label" default min max step`.
 *
 * These become uniforms a preset (or a UI) can override — the mechanism that
 * lets one crt-geom serve twenty different looks.
 */
export function parseParameters(source) {
  const out = [];
  // COMMENTED-OUT pragmas count too.
  //
  // artifact-colors1 has `//#pragma parameter FIR_SIZE "FIR Size" 29.0 ...`
  // while still declaring `uniform float FIR_SIZE` inside its
  // `#ifdef PARAMETER_UNIFORM` block. Skipping the commented line left the
  // uniform unbound at 0, so `for (i = 0; i < int(FIR_SIZE); i++)` never ran,
  // the texture read inside it was dead, and the pass rendered black. The
  // commented pragma still carries the right default (29.0), which is exactly
  // the value the shader needs.
  const re = /^\s*(?:\/\/)?\s*#pragma\s+parameter\s+(\w+)\s+"([^"]*)"\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s+([\d.eE+-]+))?/gm;
  let m;
  while ((m = re.exec(String(source))) !== null) {
    out.push({
      name: m[1],
      label: m[2],
      default: Number(m[3]),
      min: Number(m[4]),
      max: Number(m[5]),
      step: m[6] === undefined ? null : Number(m[6]),
    });
  }
  return out;
}
