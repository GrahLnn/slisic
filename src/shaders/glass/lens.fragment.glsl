precision highp float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform float u_time;
uniform float u_activation;
uniform float u_pressed;
uniform float u_theme;
uniform float u_variant;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; ++i) {
    v += a * noise(p);
    p = p * 2.03 + 17.13;
    a *= 0.5;
  }
  return v;
}

vec3 lightPalette(float dark) {
  return mix(vec3(0.985, 0.995, 1.0), vec3(0.34, 0.52, 0.72), dark);
}

vec3 shadowPalette(float dark) {
  return mix(vec3(0.86, 0.92, 0.98), vec3(0.04, 0.09, 0.15), dark);
}

void main() {
  vec2 resolution = max(u_resolution, vec2(1.0));
  vec2 uv = v_uv;
  vec2 center = uv * 2.0 - 1.0;
  center.x *= resolution.x / resolution.y;

  float titlebar = step(0.5, u_variant);
  float activation = mix(u_activation, 0.82, titlebar);
  float dark = clamp(u_theme, 0.0, 1.0);
  float press = clamp(u_pressed, 0.0, 1.0);
  float light = 1.0 - dark;

  vec2 edgeDistance = min(uv, 1.0 - uv);
  float edge = min(edgeDistance.x, edgeDistance.y);
  float innerEdge = 1.0 - smoothstep(0.0, mix(0.22, 0.12, titlebar), edge);

  vec2 pointer = mix(vec2(0.5), u_pointer, 1.0 - titlebar);
  vec2 pointerUv = vec2(pointer.x, 1.0 - pointer.y);
  float pointerDist = distance(uv, pointerUv);

  vec2 flow = vec2(
    fbm(uv * vec2(2.4, 1.6) + vec2(u_time * 0.10, -u_time * 0.035)),
    fbm(uv * vec2(2.1, 1.8) + vec2(-u_time * 0.055, u_time * 0.085))
  );
  flow = flow * 2.0 - 1.0;

  float lens = fbm(uv * vec2(5.4, 2.8) + flow * 0.42 + u_time * 0.045);
  float fine = fbm(uv * vec2(16.0, 7.0) - flow * 0.25 - u_time * 0.09);
  vec2 normal = normalize(flow + vec2(lens - 0.5, fine - 0.5) * 0.72 + 0.0001);

  float pointerGlow = 1.0 - smoothstep(0.0, mix(0.72, 1.2, titlebar), pointerDist);
  float caustic = smoothstep(0.62, 0.96, lens + fine * 0.35 + pointerGlow * 0.18);
  float sweep = smoothstep(
    0.018,
    0.0,
    abs(dot(uv - 0.5, normalize(vec2(0.76, -0.42))) + sin(u_time * 0.32) * 0.18)
  );

  vec3 cool = lightPalette(dark);
  vec3 shade = shadowPalette(dark);
  vec3 prismA = mix(vec3(0.84, 0.94, 1.0), vec3(0.32, 0.70, 1.0), dark);
  vec3 prismB = mix(vec3(1.0, 0.88, 0.96), vec3(0.72, 0.42, 0.96), dark);

  float directional = clamp(dot(normal, normalize(vec2(-0.45, 0.88))) * 0.5 + 0.5, 0.0, 1.0);
  float fill = mix(0.12, 0.28, dark) + caustic * mix(0.22, 0.16, dark);
  fill += pointerGlow * mix(0.16, 0.08, dark) * (1.0 - titlebar);
  fill += press * 0.08;

  vec3 color = mix(shade, cool, directional) * fill;
  color += prismA * innerEdge * mix(0.24, 0.18, dark);
  color += prismB * caustic * mix(0.13, 0.09, dark);
  color += vec3(1.0) * sweep * mix(0.10, 0.07, dark);
  color += vec3(1.0) * smoothstep(0.92, 1.0, uv.y) * mix(0.16, 0.08, dark);
  color += vec3(0.98, 0.995, 1.0) * light * mix(0.34, 0.12, titlebar);

  float alpha = mix(0.08, 0.22, dark);
  alpha += caustic * mix(0.13, 0.14, dark);
  alpha += innerEdge * mix(0.22, 0.22, dark);
  alpha += sweep * 0.12;
  alpha = mix(alpha, alpha * 0.82, titlebar);
  alpha *= activation;

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.58));
}
