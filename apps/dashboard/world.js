(() => {
  const canvas = document.getElementById("shader-world");
  if (!(canvas instanceof HTMLCanvasElement)) return;

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: true,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });

  if (!gl) {
    document.documentElement.classList.add("no-webgl");
    return;
  }

  const vertexSource = `#version 300 es
    precision highp float;
    const vec2 POSITIONS[3] = vec2[](
      vec2(-1.0, -1.0),
      vec2( 3.0, -1.0),
      vec2(-1.0,  3.0)
    );
    void main() {
      gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;

    out vec4 fragColor;
    uniform vec2 uResolution;
    uniform vec2 uPointer;
    uniform float uTime;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.52;
      mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = rot * p * 2.03 + 11.7;
        a *= 0.5;
      }
      return v;
    }

    float starField(vec2 uv, float scale, float seed) {
      vec2 g = uv * scale;
      vec2 id = floor(g);
      vec2 f = fract(g) - 0.5;
      float n = hash21(id + seed);
      vec2 jitter = vec2(hash21(id + seed + 7.1), hash21(id + seed + 13.4)) - 0.5;
      float d = length(f - jitter * 0.42);
      float s = smoothstep(0.09, 0.0, d) * step(0.86, n);
      float twinkle = 0.65 + 0.35 * sin(uTime * 1.8 + n * 21.0);
      return s * twinkle;
    }

    void main() {
      vec2 frag = gl_FragCoord.xy;
      vec2 uv = (frag * 2.0 - uResolution.xy) / max(uResolution.y, 1.0);
      vec2 pointer = (uPointer * 2.0 - 1.0) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);

      float t = uTime * 0.065;
      vec2 drift = vec2(t * 0.55, -t * 0.31);
      vec2 warped = uv + drift + 0.05 * pointer;

      float n1 = fbm(warped * 1.18);
      float n2 = fbm((warped + vec2(3.2, -1.7)) * 1.75);
      float ribbon = sin((uv.x * 1.35 + uv.y * 0.72 + n1 * 1.8 - t * 5.4) * 2.4);
      ribbon = smoothstep(0.92, 0.1, abs(ribbon)) * (0.28 + n2 * 0.48);

      vec3 deep = vec3(0.035, 0.035, 0.12);
      vec3 violet = vec3(0.31, 0.18, 0.62);
      vec3 cyan = vec3(0.17, 0.72, 0.83);
      vec3 pink = vec3(0.75, 0.28, 0.58);
      vec3 color = mix(deep, violet, clamp(n1 * 0.72 + 0.05, 0.0, 1.0));
      color += cyan * ribbon * 0.23;
      color += pink * smoothstep(0.55, 0.9, n2) * 0.13;

      float vignette = smoothstep(1.55, 0.18, length(uv * vec2(0.72, 1.0)));
      color *= 0.68 + vignette * 0.42;

      float stars = starField(uv + vec2(t * 0.08, 0.0), 18.0, 2.0);
      stars += starField(uv * 1.13 - vec2(t * 0.04, 0.0), 31.0, 9.0) * 0.45;
      color += stars * vec3(1.0, 0.9, 0.56) * 0.85;

      float pointerGlow = exp(-3.2 * length(uv - pointer * 0.16));
      color += pointerGlow * vec3(0.13, 0.18, 0.31);

      fragColor = vec4(color, 1.0);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Unable to create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader) || "Unknown shader error";
      gl.deleteShader(shader);
      throw new Error(error);
    }
    return shader;
  }

  let program;
  try {
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
    }
  } catch (error) {
    console.warn("[dashboard] WebGL shader fallback:", error);
    document.documentElement.classList.add("no-webgl");
    return;
  }

  const resolutionLocation = gl.getUniformLocation(program, "uResolution");
  const pointerLocation = gl.getUniformLocation(program, "uPointer");
  const timeLocation = gl.getUniformLocation(program, "uTime");
  const pointer = { x: 0.72, y: 0.22 };
  const target = { ...pointer };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.floor(innerWidth * dpr));
    const height = Math.max(1, Math.floor(innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = innerWidth + "px";
      canvas.style.height = innerHeight + "px";
    }
    gl.viewport(0, 0, width, height);
  }

  addEventListener("resize", resize, { passive: true });
  addEventListener("pointermove", (event) => {
    target.x = event.clientX / Math.max(innerWidth, 1);
    target.y = 1 - event.clientY / Math.max(innerHeight, 1);
  }, { passive: true });

  resize();
  gl.useProgram(program);

  const started = performance.now();
  let frame = 0;

  function render(now) {
    pointer.x += (target.x - pointer.x) * 0.035;
    pointer.y += (target.y - pointer.y) * 0.035;

    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform2f(pointerLocation, pointer.x, pointer.y);
    gl.uniform1f(timeLocation, reduceMotion ? 0.0 : (now - started) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!reduceMotion) frame = requestAnimationFrame(render);
  }

  render(performance.now());

  if (reduceMotion) {
    document.documentElement.classList.add("reduced-motion");
  }

  document.addEventListener("visibilitychange", () => {
    if (reduceMotion) return;
    if (document.hidden && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else if (!document.hidden && !frame) {
      frame = requestAnimationFrame(render);
    }
  });
})();