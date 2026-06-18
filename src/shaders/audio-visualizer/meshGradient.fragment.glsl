precision highp float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform float u_phase;
uniform float u_accent_gesture;
uniform float u_bend_gesture;
uniform float u_density_pulse;
uniform float u_focus_gesture;
uniform float u_flow_gesture;
uniform float u_size_pulse;
uniform float u_travel_gesture;
uniform vec3 u_background;
uniform vec3 u_color0;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;
uniform vec3 u_color4;
uniform vec3 u_color5;
uniform float u_color_mix;
uniform float u_shadow;
uniform float u_vignette;

vec2 squareCoverUv(vec2 uv, float aspect) {
  vec2 c = uv - 0.5;
  if (aspect > 1.0) {
    c.x *= aspect;
  } else {
    c.y /= max(aspect, 0.0001);
  }

  return c + 0.5;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);

  return fract((p3.x + p3.y) * p3.z);
}

mat2 rotate2d(float angle) {
  float s = sin(angle);
  float c = cos(angle);

  return mat2(c, -s, s, c);
}

vec2 forwardMeshField(vec2 uv, float t) {
  vec2 c = uv - 0.5;
  float angle = t * 0.34;
  c *= rotate2d(angle);

  return c + 0.5;
}

vec2 colorPoint(float index, float t) {
  float a = index * 1.71;
  float stride = t * (0.52 + index * 0.045) + a;
  vec2 anchor = vec2(
    0.5 + 0.33 * cos(stride),
    0.5 + 0.27 * sin(stride)
  );

  return anchor;
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 shapeUv = squareCoverUv(v_uv, aspect);
  float travel = clamp(u_travel_gesture, 0.0, 1.0);
  float bend = clamp(u_bend_gesture, 0.0, 1.0);
  float accent = clamp(u_accent_gesture, 0.0, 1.0);
  float focus = clamp(u_focus_gesture, 0.0, 1.0);
  float flow = clamp(u_flow_gesture, 0.0, 1.0);
  float density = clamp(u_density_pulse, 0.0, 1.0);
  float size = clamp(u_size_pulse, 0.0, 1.0);
  float t = u_phase + 41.5;

  shapeUv = forwardMeshField(shapeUv, t);

  vec3 color = vec3(0.0);
  vec3 avgColor = (u_color0 + u_color1 + u_color2 + u_color3 + u_color4 + u_color5) / 6.0;
  float total = 0.0;

  for (int i = 0; i < 6; i++) {
    float index = float(i);
    vec3 colorStop = u_color0;
    if (i == 1) {
      colorStop = u_color1;
    } else if (i == 2) {
      colorStop = u_color2;
    } else if (i == 3) {
      colorStop = u_color3;
    } else if (i == 4) {
      colorStop = u_color4;
    } else if (i == 5) {
      colorStop = u_color5;
    }
    vec2 pos = colorPoint(index, t);
    float dist = length(shapeUv - pos) / (1.0 + size * 0.92 + accent * 0.12);
    float melt = (flow * 0.78 + bend * 0.3) * (1.0 - focus * 0.3) * 0.62;
    float clarity = focus * 0.78 + density * 0.5 + accent * 0.24;
    float silhouette = clamp(2.55 + clarity * 1.55 - melt * 0.72, 2.15, 4.9);
    dist = pow(dist, silhouette);
    float softness = 0.0022 + melt * 0.009 + size * 0.0024 - focus * 0.0011 - density * 0.0009;
    float weight = 1.0 / (dist + max(0.0009, softness));

    color += colorStop * weight;
    total += weight;
  }

  color = (color + avgColor * 0.42) / max(total + 0.42, 0.00001);

  float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  color += dither;

  float curtain = clamp(
    u_color_mix + focus * 0.14 + density * 0.1 + accent * 0.08 - bend * 0.026,
    0.0,
    1.0
  );
  vec3 finalColor = mix(u_background, color, curtain);
  float lift = clamp(accent * 0.055 + density * 0.045 + focus * 0.035, 0.0, 0.14);
  float saturation = clamp(1.0 + accent * 0.16 + density * 0.12 - flow * 0.08, 0.82, 1.22);
  float luminance = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
  finalColor = mix(vec3(luminance), finalColor, saturation) + lift;
  finalColor = mix(avgColor, finalColor, 0.9);
  vec2 centered = v_uv - 0.5;
  float edge = smoothstep(0.18, 0.82, length(centered));
  finalColor = mix(finalColor, u_background, edge * clamp(u_vignette, 0.0, 1.0));
  finalColor *= 1.0 - clamp(u_shadow, 0.0, 0.72) * edge;

  gl_FragColor = vec4(finalColor, 1.0);
}
