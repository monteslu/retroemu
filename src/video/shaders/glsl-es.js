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
  const declaresOwnOutput = /\bout\s+(?:highp|mediump|lowp|COMPAT_PRECISION)?\s*vec4\s+\w+/.test(body)
    || /#define\s+COMPAT_VARYING\s+out/.test(body);

  const header = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    `#define ${isVert ? 'VERTEX' : 'FRAGMENT'} 1`,
  ];
  // Parameters are NOT injected as uniforms here, and that is measured, not
  // assumed. Four variants against the 681-shader corpus:
  //
  //   define PARAMETER_UNIFORM + declare all params   30.4%  (416 redeclared)
  //   define PARAMETER_UNIFORM + declare missing only 80.5%
  //   declare missing only, macro undefined           80.9%
  //   inject nothing                                  81.6%  <- this
  //
  // With the macro undefined, the corpus's own `#ifndef PARAMETER_UNIFORM`
  // branch supplies constant defaults, which is what a preset with no
  // parameter overrides wants anyway. Binding real parameter VALUES needs the
  // runner to know which uniforms a linked program actually has, so it is done
  // there (per pass, by reflection) rather than by rewriting source.
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
  const re = /^\s*#pragma\s+parameter\s+(\w+)\s+"([^"]*)"\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s+([\d.eE+-]+))?/gm;
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
