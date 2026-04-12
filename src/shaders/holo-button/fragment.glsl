precision highp float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform float u_hover_state;
uniform float u_click_state;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(
        permute(
            permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
                i.y +
                vec4(0.0, i1.y, i2.y, 1.0)
        ) +
            i.x +
            vec4(0.0, i1.x, i2.x, 1.0)
    );

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(
        vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3))
    );
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(
        0.49 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)),
        0.0
    );
    m = m * m;

    return 42.0 * dot(
        m * m,
        vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3))
    );
}

float fbm(vec3 x) {
    float v = 0.0;
    float a = 0.5;
    vec3 shift = vec3(100.0);

    for (int i = 0; i < 4; ++i) {
        v += a * snoise(x);
        x = x * 2.0 + shift;
        a *= 0.5;
    }

    return v;
}

void main() {
    vec2 st = v_uv;
    vec2 mouse = u_mouse;

    float aspect = u_resolution.x / u_resolution.y;
    st.x *= aspect;
    mouse.x *= aspect;

    float time = u_time * 0.2;
    float distToMouse = distance(st, mouse);

    vec2 warp = vec2(
        fbm(vec3(st * 2.5, time)),
        fbm(vec3(st * 2.5 + vec2(5.2, 1.3), time * 1.1))
    );

    vec2 warp2 = vec2(
        fbm(vec3(st * 3.5 + warp * 2.0, time * 1.2)),
        fbm(vec3(st * 3.5 - warp * 2.0, time * 0.9))
    );

    float fluidMap = fbm(vec3(st * 4.0 + warp2 * 1.8, time * 1.5));

    float spotlightRadius = 1.0 + (u_click_state * 2.5);
    float spotlight = smoothstep(spotlightRadius, 0.0, distToMouse);
    float intensity = fluidMap * spotlight * 1.8;

    float glassWaves = sin(
        st.x * 20.0 + st.y * 20.0 + fluidMap * 15.0 - u_time * 3.0
    );
    intensity += smoothstep(0.8, 1.0, glassWaves) * spotlight * 0.4;

    vec3 col = vec3(0.0);

    vec3 deepBlue = vec3(0.0, 0.1, 0.6);
    vec3 electricCyan = vec3(0.0, 0.85, 1.0);
    vec3 vividOrange = vec3(1.0, 0.4, 0.0);
    vec3 coreWhite = vec3(1.0, 1.0, 1.0);

    col = mix(col, deepBlue, smoothstep(0.0, 0.25, intensity));
    col = mix(col, electricCyan, smoothstep(0.25, 0.5, intensity));
    col = mix(col, vividOrange, smoothstep(0.5, 0.8, intensity));
    col = mix(col, coreWhite, smoothstep(0.8, 1.1, intensity));

    float ripple = smoothstep(
        0.1,
        0.0,
        abs(distToMouse - u_click_state * 1.5)
    ) * u_click_state;
    col += coreWhite * ripple * 2.0;

    float edgeMask = length(v_uv - vec2(0.5));
    float vignette = smoothstep(0.85, 0.3, edgeMask * 1.6);

    col *= vignette * u_hover_state;
    float alpha = max(max(col.r, col.g), col.b);
    alpha = smoothstep(0.0, 0.18, alpha);

    gl_FragColor = vec4(col, alpha);
}
