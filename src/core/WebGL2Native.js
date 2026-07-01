// WebGL2Native.js — WebGL2RenderingContext adapter backed by native-gles
//
// Emscripten's GL subsystem calls canvas.getContext("webgl2") and then uses
// standard WebGL2 API methods (createBuffer, bindTexture, drawArrays, etc).
// This adapter translates those calls to native-gles EGL+GLES3 calls.
//
// WebGL uses JS objects (WebGLBuffer, WebGLTexture, etc.) while native-gles
// uses integer IDs. We maintain maps between them.

import gl from 'native-gles';

class GLObject {
  constructor(id) { this.id = id; }
}

export function createWebGL2Context() {
  let nextId = 1;
  const buffers = new Map();   // GLObject → native id
  const textures = new Map();
  const programs = new Map();
  const shaders = new Map();
  const fbos = new Map();
  const rbos = new Map();
  const uniforms = new Map();  // GLObject → {program native id, location}
  const vaos = new Map();

  // Reverse maps: native id → GLObject
  const buffersByNative = new Map();
  const texturesByNative = new Map();
  const programsByNative = new Map();
  const shadersByNative = new Map();
  const fbosByNative = new Map();
  const rbosByNative = new Map();

  function makeObj(nativeId, map, reverseMap) {
    const obj = new GLObject(nativeId);
    map.set(obj, nativeId);
    if (reverseMap) reverseMap.set(nativeId, obj);
    return obj;
  }

  function nativeId(obj, map) {
    if (!obj) return 0;
    return map.get(obj) || 0;
  }

  // Track current state for Emscripten's GL layer
  const ctx = {
    canvas: { width: 640, height: 480 },
    currentArrayBufferBinding: null,
    currentElementArrayBufferBinding: null,
    currentPixelPackBufferBinding: null,
    currentPixelUnpackBufferBinding: null,
    currentProgram: null,
    disjointTimerQueryExt: null,

    getSupportedExtensions() {
      return [];
    },

    getExtension(name) {
      // Return null for most extensions — core GL is enough
      return null;
    },

    getParameter(pname) {
      // String parameters
      if (pname === 0x1F00) return 'OpenGL ES'; // GL_VENDOR
      if (pname === 0x1F01) return 'native-gles'; // GL_RENDERER
      if (pname === 0x1F02) return 'OpenGL ES 3.0'; // GL_VERSION
      if (pname === 0x8B8C) return 'OpenGL ES GLSL ES 3.00'; // GL_SHADING_LANGUAGE_VERSION
      if (pname === 0x1F03) return ''; // GL_EXTENSIONS
      // Float parameters
      if (pname === 0x846E) { // GL_ALIASED_POINT_SIZE_RANGE
        const out = new Float32Array(2);
        gl.glGetFloatv(pname, out);
        return out;
      }
      const out = new Int32Array(1);
      gl.glGetIntegerv(pname, out);
      return out[0];
    },

    getTexParameter(target, pname) {
      const out = new Int32Array(1);
      gl.glGetTexParameteriv(target, pname, out);
      return out[0];
    },

    // Buffer operations
    createBuffer() {
      const ids = new Uint32Array(1);
      gl.glGenBuffers(1, ids);
      return makeObj(ids[0], buffers, buffersByNative);
    },
    deleteBuffer(buf) {
      const id = nativeId(buf, buffers);
      if (id) {
        const ids = new Uint32Array([id]);
        gl.glDeleteBuffers(1, ids);
        buffersByNative.delete(id);
        buffers.delete(buf);
      }
    },
    bindBuffer(target, buf) {
      const id = nativeId(buf, buffers);
      gl.glBindBuffer(target, id);
      if (target === 0x8892) ctx.currentArrayBufferBinding = buf;        // ARRAY_BUFFER
      if (target === 0x8893) ctx.currentElementArrayBufferBinding = buf; // ELEMENT_ARRAY_BUFFER
      if (target === 0x88EC) ctx.currentPixelPackBufferBinding = buf;    // PIXEL_PACK_BUFFER
      if (target === 0x88ED) ctx.currentPixelUnpackBufferBinding = buf;  // PIXEL_UNPACK_BUFFER
    },
    bufferData(target, dataOrSize, usage) {
      // native-gles uses 3-arg form: glBufferData(target, data, usage)
      // Size is inferred from the typed array
      if (typeof dataOrSize === 'number') {
        const empty = new Uint8Array(dataOrSize);
        gl.glBufferData(target, empty, usage);
      } else if (dataOrSize) {
        gl.glBufferData(target, dataOrSize, usage);
      }
    },
    bufferSubData(target, offset, data) {
      gl.glBufferSubData(target, offset, data);
    },

    // Texture operations
    createTexture() {
      const ids = new Uint32Array(1);
      gl.glGenTextures(1, ids);
      return makeObj(ids[0], textures, texturesByNative);
    },
    deleteTexture(tex) {
      const id = nativeId(tex, textures);
      if (id) {
        const ids = new Uint32Array([id]);
        gl.glDeleteTextures(1, ids);
        texturesByNative.delete(id);
        textures.delete(tex);
      }
    },
    bindTexture(target, tex) {
      gl.glBindTexture(target, nativeId(tex, textures));
    },
    activeTexture(unit) { gl.glActiveTexture(unit); },
    generateMipmap(target) { gl.glGenerateMipmap(target); },
    texParameteri(target, pname, param) { gl.glTexParameteri(target, pname, param); },

    texImage2D(target, level, internalformat, width, height, border, format, type, data) {
      // WebGL2 texImage2D has multiple overloads
      if (arguments.length === 6) {
        // texImage2D(target, level, internalformat, format, type, source)
        // This is the ImageData/HTMLImageElement overload — shouldn't happen in Node
        console.error('[WebGL2Native] texImage2D 6-arg form not supported');
        return;
      }
      gl.glTexImage2D(target, level, internalformat, width, height, border, format, type, data || null);
    },

    texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, data) {
      if (arguments.length === 7) {
        console.error('[WebGL2Native] texSubImage2D 7-arg form not supported');
        return;
      }
      gl.glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, data || null);
    },

    pixelStorei(pname, param) { gl.glPixelStorei(pname, param); },

    // Shader operations
    createShader(type) {
      const id = gl.glCreateShader(type);
      return makeObj(id, shaders, shadersByNative);
    },
    deleteShader(sh) {
      const id = nativeId(sh, shaders);
      if (id) { gl.glDeleteShader(id); shadersByNative.delete(id); shaders.delete(sh); }
    },
    shaderSource(sh, source) {
      gl.glShaderSource(nativeId(sh, shaders), source);
    },
    compileShader(sh) { gl.glCompileShader(nativeId(sh, shaders)); },
    getShaderParameter(sh, pname) {
      const out = new Int32Array(1);
      gl.glGetShaderiv(nativeId(sh, shaders), pname, out);
      // COMPILE_STATUS (0x8B81) returns boolean in WebGL
      if (pname === 0x8B81) return out[0] !== 0;
      return out[0];
    },
    getShaderInfoLog(sh) {
      return gl.glGetShaderInfoLog(nativeId(sh, shaders));
    },
    getShaderSource(sh) {
      return gl.glGetShaderSource(nativeId(sh, shaders));
    },

    // Program operations
    createProgram() {
      const id = gl.glCreateProgram();
      return makeObj(id, programs, programsByNative);
    },
    deleteProgram(prog) {
      const id = nativeId(prog, programs);
      if (id) { gl.glDeleteProgram(id); programsByNative.delete(id); programs.delete(prog); }
    },
    attachShader(prog, sh) {
      gl.glAttachShader(nativeId(prog, programs), nativeId(sh, shaders));
    },
    linkProgram(prog) { gl.glLinkProgram(nativeId(prog, programs)); },
    useProgram(prog) {
      gl.glUseProgram(nativeId(prog, programs));
      ctx.currentProgram = prog;
    },
    isProgram(prog) {
      return !!nativeId(prog, programs);
    },
    getProgramParameter(prog, pname) {
      const out = new Int32Array(1);
      gl.glGetProgramiv(nativeId(prog, programs), pname, out);
      if (pname === 0x8B82) return out[0] !== 0; // LINK_STATUS
      return out[0];
    },
    getProgramInfoLog(prog) {
      return gl.glGetProgramInfoLog(nativeId(prog, programs));
    },
    bindAttribLocation(prog, index, name) {
      gl.glBindAttribLocation(nativeId(prog, programs), index, name);
    },
    getActiveAttrib(prog, index) {
      const info = gl.glGetActiveAttrib(nativeId(prog, programs), index);
      return info; // {name, type, size}
    },
    getActiveUniform(prog, index) {
      const info = gl.glGetActiveUniform(nativeId(prog, programs), index);
      return info; // {name, type, size}
    },
    getActiveUniformBlockName(prog, index) {
      // Stubbed — parallel-n64 might not use UBOs
      return '';
    },
    getUniformLocation(prog, name) {
      const loc = gl.glGetUniformLocation(nativeId(prog, programs), name);
      if (loc < 0) return null;
      const obj = new GLObject(loc);
      uniforms.set(obj, loc);
      return obj;
    },

    // Uniform setters — WebGL uses uniform location objects
    uniform1i(loc, v0) { gl.glUniform1i(nativeId(loc, uniforms), v0); },
    uniform1f(loc, v0) { gl.glUniform1f(nativeId(loc, uniforms), v0); },
    uniform2f(loc, v0, v1) { gl.glUniform2f(nativeId(loc, uniforms), v0, v1); },
    uniform3f(loc, v0, v1, v2) { gl.glUniform3f(nativeId(loc, uniforms), v0, v1, v2); },
    uniform4f(loc, v0, v1, v2, v3) { gl.glUniform4f(nativeId(loc, uniforms), v0, v1, v2, v3); },
    uniform1iv(loc, data) { gl.glUniform1iv(nativeId(loc, uniforms), data.length, data); },
    uniform1fv(loc, data) { gl.glUniform1fv(nativeId(loc, uniforms), data.length, data); },
    uniform2fv(loc, data) { gl.glUniform2fv(nativeId(loc, uniforms), data.length / 2, data); },
    uniform3fv(loc, data) { gl.glUniform3fv(nativeId(loc, uniforms), data.length / 3, data); },
    uniform4fv(loc, data) { gl.glUniform4fv(nativeId(loc, uniforms), data.length / 4, data); },
    uniformMatrix2fv(loc, transpose, data) { gl.glUniformMatrix2fv(nativeId(loc, uniforms), data.length / 4, !!transpose, data); },
    uniformMatrix3fv(loc, transpose, data) { gl.glUniformMatrix3fv(nativeId(loc, uniforms), data.length / 9, !!transpose, data); },
    uniformMatrix4fv(loc, transpose, data) { gl.glUniformMatrix4fv(nativeId(loc, uniforms), data.length / 16, !!transpose, data); },

    // Vertex attribute operations
    enableVertexAttribArray(index) { gl.glEnableVertexAttribArray(index); },
    disableVertexAttribArray(index) { gl.glDisableVertexAttribArray(index); },
    vertexAttribPointer(index, size, type, normalized, stride, offset) {
      gl.glVertexAttribPointer(index, size, type, !!normalized, stride, offset);
    },
    vertexAttrib4f(index, v0, v1, v2, v3) { gl.glVertexAttrib4f(index, v0, v1, v2, v3); },
    vertexAttrib4fv(index, data) { gl.glVertexAttrib4fv(index, data); },

    // Draw operations
    drawArrays(mode, first, count) { gl.glDrawArrays(mode, first, count); },
    drawElements(mode, count, type, offset) { gl.glDrawElements(mode, count, type, offset); },

    // Framebuffer operations
    createFramebuffer() {
      const ids = new Uint32Array(1);
      gl.glGenFramebuffers(1, ids);
      return makeObj(ids[0], fbos, fbosByNative);
    },
    deleteFramebuffer(fbo) {
      const id = nativeId(fbo, fbos);
      if (id) {
        const ids = new Uint32Array([id]);
        gl.glDeleteFramebuffers(1, ids);
        fbosByNative.delete(id);
        fbos.delete(fbo);
      }
    },
    bindFramebuffer(target, fbo) {
      gl.glBindFramebuffer(target, nativeId(fbo, fbos));
    },
    framebufferTexture2D(target, attachment, textarget, tex, level) {
      gl.glFramebufferTexture2D(target, attachment, textarget, nativeId(tex, textures), level);
    },
    checkFramebufferStatus(target) { return gl.glCheckFramebufferStatus(target); },

    // Renderbuffer operations
    createRenderbuffer() {
      const ids = new Uint32Array(1);
      gl.glGenRenderbuffers(1, ids);
      return makeObj(ids[0], rbos, rbosByNative);
    },
    deleteRenderbuffer(rbo) {
      const id = nativeId(rbo, rbos);
      if (id) {
        const ids = new Uint32Array([id]);
        gl.glDeleteRenderbuffers(1, ids);
        rbosByNative.delete(id);
        rbos.delete(rbo);
      }
    },
    bindRenderbuffer(target, rbo) {
      gl.glBindRenderbuffer(target, nativeId(rbo, rbos));
    },
    renderbufferStorage(target, internalformat, width, height) {
      gl.glRenderbufferStorage(target, internalformat, width, height);
    },
    framebufferRenderbuffer(target, attachment, rbtarget, rbo) {
      gl.glFramebufferRenderbuffer(target, attachment, rbtarget, nativeId(rbo, rbos));
    },

    // State operations
    enable(cap) { gl.glEnable(cap); },
    disable(cap) { gl.glDisable(cap); },
    clear(mask) { gl.glClear(mask); },
    clearColor(r, g, b, a) { gl.glClearColor(r, g, b, a); },
    clearDepth(d) { gl.glClearDepthf(d); },
    depthFunc(func) { gl.glDepthFunc(func); },
    depthMask(flag) { gl.glDepthMask(!!flag); },
    depthRange(near, far) { gl.glDepthRangef(near, far); },
    colorMask(r, g, b, a) { gl.glColorMask(!!r, !!g, !!b, !!a); },
    blendFunc(sfactor, dfactor) { gl.glBlendFunc(sfactor, dfactor); },
    blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha) { gl.glBlendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha); },
    cullFace(mode) { gl.glCullFace(mode); },
    frontFace(mode) { gl.glFrontFace(mode); },
    lineWidth(width) { gl.glLineWidth(width); },
    polygonOffset(factor, units) { gl.glPolygonOffset(factor, units); },
    scissor(x, y, w, h) { gl.glScissor(x, y, w, h); },
    viewport(x, y, w, h) { gl.glViewport(x, y, w, h); },
    stencilFunc(func, ref, mask) { gl.glStencilFunc(func, ref, mask); },
    stencilMask(mask) { gl.glStencilMask(mask); },
    stencilOp(fail, zfail, zpass) { gl.glStencilOp(fail, zfail, zpass); },
    flush() { gl.glFlush(); },

    readPixels(x, y, w, h, format, type, pixels) {
      gl.glReadPixels(x, y, w, h, format, type, pixels);
    },

    // Constants that Emscripten GL layer checks
    TEXTURE_2D: 0x0DE1,
    FRAMEBUFFER: 0x8D40,
  };

  // Handle partial method names from minified glue (e.g., GLctx.texImage, GLctx.texSubImage, GLctx.uniform, GLctx.vertexAttrib)
  // These are used as prefixes — the glue code does GLctx.texImage2D etc directly
  // But some minified builds might reference GLctx.uniform1i directly, which we have above.

  // Debug proxy to log GL calls
  if (process.env.DEBUG_GL) {
    return new Proxy(ctx, {
      get(target, prop) {
        const val = target[prop];
        if (typeof val === 'function') {
          return (...args) => {
            try {
              const result = val.apply(target, args);
              return result;
            } catch (e) {
              console.error(`[GL ERROR] ${prop}(${args.map(a => typeof a === 'object' ? '[obj]' : a).join(', ')}): ${e.message}`);
              throw e;
            }
          };
        }
        return val;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    });
  }

  return ctx;
}

// Create a fake canvas object that returns our WebGL2 adapter
export function createFakeCanvas(width = 640, height = 480) {
  const glCtx = createWebGL2Context();
  glCtx.canvas.width = width;
  glCtx.canvas.height = height;

  return {
    width,
    height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
    getContext(type, attrs) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
        return glCtx;
      }
      return null;
    },
    setAttribute() {},
    // For Emscripten's canvas handling
    clientWidth: width,
    clientHeight: height,
  };
}
