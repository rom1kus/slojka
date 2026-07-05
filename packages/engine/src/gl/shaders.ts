export const VERT = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec4 uRect; // NDC: x0, y0, w, h
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0.0, 1.0);
}
`

/**
 * Композит одного слоя поверх аккумулятора.
 * dst/src — premultiplied RGBA. Формулы separable-режимов считаются на
 * непремультиплицированных цветах (как в Photoshop/W3C compositing spec):
 *   co = as*(1-ab)*Cs + ab*(1-as)*Cb + as*ab*B(Cb, Cs)
 */
export const FRAG_BLEND = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDst;    // аккумулятор (premult)
uniform sampler2D uSrc;    // слой (premult)
uniform sampler2D uMask;   // маска слоя (R8)
uniform sampler2D uClip;   // база обтравочной маски (premult, берём альфу)
uniform int uUseMask;
uniform int uUseClip;
uniform float uOpacity;   // непрозрачность слоя 0..1
uniform int uMode;

vec3 blendChannel(vec3 Cb, vec3 Cs, int mode) {
  if (mode == 1) return Cb * Cs;                                    // multiply
  if (mode == 2) return Cb + Cs - Cb * Cs;                          // screen
  if (mode == 3) {                                                  // overlay
    vec3 lo = 2.0 * Cb * Cs;
    vec3 hi = 1.0 - 2.0 * (1.0 - Cb) * (1.0 - Cs);
    return mix(lo, hi, step(0.5, Cb));
  }
  if (mode == 4) {                                                  // soft-light (W3C)
    vec3 d = mix(
      ((16.0 * Cb - 12.0) * Cb + 4.0) * Cb,
      sqrt(Cb),
      step(0.25, Cb)
    );
    vec3 lo = Cb - (1.0 - 2.0 * Cs) * Cb * (1.0 - Cb);
    vec3 hi = Cb + (2.0 * Cs - 1.0) * (d - Cb);
    return mix(lo, hi, step(0.5, Cs));
  }
  if (mode == 5) return min(Cb, Cs);                                // darken
  if (mode == 6) return max(Cb, Cs);                                // lighten
  if (mode == 7) return min(Cb + Cs, vec3(1.0));                    // add
  return Cs;                                                        // normal
}

void main() {
  vec4 dst = texture(uDst, vUv);
  float maskFactor = uUseMask == 1 ? texture(uMask, vUv).r : 1.0;
  float clipFactor = uUseClip == 1 ? texture(uClip, vUv).a : 1.0;
  vec4 src = texture(uSrc, vUv) * (uOpacity * maskFactor * clipFactor);

  float ab = dst.a;
  float as = src.a;
  vec3 Cb = ab > 0.0 ? dst.rgb / ab : vec3(0.0);
  vec3 Cs = as > 0.0 ? src.rgb / as : vec3(0.0);

  vec3 B = blendChannel(Cb, Cs, uMode);
  vec3 co = as * (1.0 - ab) * Cs + ab * (1.0 - as) * Cb + as * ab * B;
  float ao = as + ab * (1.0 - as);
  outColor = vec4(co, ao);
}
`

/**
 * Мазок кисти: мягкий круг в буфер штриха (R8, coverage).
 * Активное выделение клипит мазок (uSel по gl_FragCoord в координатах документа).
 */
export const FRAG_DAB = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uHardness; // 0..1: доля радиуса без спада
uniform float uFlow;     // 0..1
uniform sampler2D uSel;  // маска выделения (R8)
uniform int uUseSel;
uniform vec2 uDocSize;
void main() {
  float d = length(vUv - 0.5) * 2.0; // 0 в центре, 1 на краю квада
  float edge0 = clamp(uHardness, 0.0, 0.995);
  float a = 1.0 - smoothstep(edge0, 1.0, d);
  if (uUseSel == 1) {
    a *= texture(uSel, gl_FragCoord.xy / uDocSize).r;
  }
  outColor = vec4(a * uFlow, 0.0, 0.0, a * uFlow);
}
`

/** Мазок текстурной кистью: coverage из типса (R8) вместо круга. */
export const FRAG_DAB_TIP = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTip;  // типс (R8 coverage)
uniform float uFlow;
uniform sampler2D uSel;
uniform int uUseSel;
uniform vec2 uDocSize;
void main() {
  float a = texture(uTip, vUv).r;
  if (uUseSel == 1) {
    a *= texture(uSel, gl_FragCoord.xy / uDocSize).r;
  }
  outColor = vec4(a * uFlow, 0.0, 0.0, a * uFlow);
}
`

/**
 * Слияние буфера штриха со слоем (paint или erase).
 * Выход — новый слой (premult RGBA), пишется в scratch и свопается.
 */
export const FRAG_MERGE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uLayer;   // premult RGBA
uniform sampler2D uStroke;  // R8 coverage
uniform vec4 uColor;        // цвет кисти, непремультиплицированный
uniform float uOpacity;     // непрозрачность штриха
uniform int uErase;         // 0 = кисть, 1 = ластик
void main() {
  vec4 layer = texture(uLayer, vUv);
  float s = texture(uStroke, vUv).r * uOpacity;
  if (uErase == 1) {
    outColor = layer * (1.0 - s);
  } else {
    vec4 srcPremult = vec4(uColor.rgb, 1.0) * (uColor.a * s);
    outColor = srcPremult + layer * (1.0 - srcPremult.a);
  }
}
`

/**
 * Present: шахматка + текстура документа + пиксельная сетка на большом зуме
 * (как в Photoshop: появляется от ~800% и рисует границы текселей).
 */
export const FRAG_PRESENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDocSizePx;   // размер документа в экранных px (для шахматки)
uniform vec2 uDocDims;     // размер документа в текселях
uniform float uCheckSize;  // размер клетки в px
uniform float uGridAlpha;  // 0 = сетка выключена
void main() {
  vec2 px = vUv * uDocSizePx;
  float check = mod(floor(px.x / uCheckSize) + floor(px.y / uCheckSize), 2.0);
  vec3 bg = mix(vec3(0.42), vec3(0.58), check);
  vec4 c = texture(uTex, vUv); // premult
  vec3 rgb = bg * (1.0 - c.a) + c.rgb;

  if (uGridAlpha > 0.0) {
    vec2 texel = vUv * uDocDims;               // координата в текселях
    vec2 pxPerTexel = uDocSizePx / uDocDims;   // экранных px на тексель
    vec2 f = abs(fract(texel) - 0.5);          // 0.5 на границе текселя
    vec2 distPx = (0.5 - f) * pxPerTexel;      // расстояние до границы, screen px
    float line = step(min(distPx.x, distPx.y), 0.5);
    rgb = mix(rgb, vec3(0.35), line * uGridAlpha);
  }
  outColor = vec4(rgb, 1.0);
}
`

/** Извлечение выделенной области слоя: out = layer × sel (для floating/Ctrl+J). */
export const FRAG_EXTRACT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uLayer;
uniform sampler2D uSel;
void main() {
  outColor = texture(uLayer, vUv) * texture(uSel, vUv).r;
}
`

/**
 * Отрисовка ОРИГИНАЛА smart-слоя (произвольного размера) в док-текстуру:
 * точка оригинала s → док: q = R·S·(s − srcSize/2) + center + delta.
 */
export const FRAG_PLACE = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uTex;    // оригинал (premult)
uniform vec2 uSrcSize;     // размер оригинала в px
uniform vec2 uCenter;      // центр размещения (док-px)
uniform vec2 uDelta;
uniform vec2 uScale;
uniform float uRot;
void main() {
  vec2 q = gl_FragCoord.xy;
  vec2 v = q - uCenter - uDelta;
  float cs = cos(-uRot);
  float sn = sin(-uRot);
  v = vec2(cs * v.x - sn * v.y, sn * v.x + cs * v.y);
  v /= max(uScale, vec2(1e-4));
  vec2 s = v + uSrcSize * 0.5;
  vec2 uv = s / uSrcSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  outColor = texture(uTex, uv);
}
`

/**
 * Отрисовка floating-фрагмента с аффинной трансформацией
 * (перенос + масштаб + поворот вокруг центра). Вне исходной области — discard.
 */
export const FRAG_FLOAT = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDocSize;
uniform vec2 uCenter;  // центр трансформации (док-px)
uniform vec2 uDelta;   // смещение
uniform vec2 uScale;
uniform float uRot;    // радианы
void main() {
  vec2 q = gl_FragCoord.xy;
  vec2 v = q - uCenter - uDelta;
  float cs = cos(-uRot);
  float sn = sin(-uRot);
  v = vec2(cs * v.x - sn * v.y, sn * v.x + cs * v.y);
  v /= max(uScale, vec2(1e-4));
  vec2 uv = (v + uCenter) / uDocSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  outColor = texture(uTex, uv);
}
`

/** Простая заливка цветом (инициализация фонового слоя). */
export const FRAG_FILL = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec4 uColor; // premult
void main() { outColor = uColor; }
`

/** Копирование текстуры 1:1. */
export const FRAG_COPY = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() { outColor = texture(uTex, vUv); }
`

/**
 * Слияние буфера штриха с МАСКОЙ слоя (R8): кисть пишет яркость цвета,
 * ластик пишет белый (открывает).
 */
export const FRAG_MERGE_MASK = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uLayer;   // текущая маска (R8)
uniform sampler2D uStroke;  // R8 coverage
uniform float uValue;       // целевое значение (яркость цвета кисти)
uniform float uOpacity;
uniform int uErase;
void main() {
  float m = texture(uLayer, vUv).r;
  float s = texture(uStroke, vUv).r * uOpacity;
  float target = uErase == 1 ? 1.0 : uValue;
  float v = mix(m, target, s);
  outColor = vec4(v, 0.0, 0.0, 1.0);
}
`

/**
 * Маска тени: альфа слоя со смещением (drop) или инвертированная альфа
 * со смещением (inner). Результат в R8, дальше — гаусс и колоризация.
 */
export const FRAG_SHADOW_MASK = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;   // слой (premult RGBA)
uniform sampler2D uMask;  // маска слоя (R8)
uniform int uUseMask;
uniform vec2 uOffset;     // смещение в UV
uniform int uInvert;      // 1 для внутренней тени
void main() {
  vec2 uv = vUv - uOffset;
  // За пределами слоя альфа: 0 для drop, 1 для inner (край отбрасывает тень внутрь).
  float a;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    a = 0.0;
  } else {
    a = texture(uSrc, uv).a;
    if (uUseMask == 1) a *= texture(uMask, uv).r;
  }
  outColor = vec4(uInvert == 1 ? 1.0 - a : a, 0.0, 0.0, 1.0);
}
`

/**
 * Колоризация маски тени в premult RGBA.
 * Для inner дополнительно умножается на альфу слоя (тень только внутри).
 */
export const FRAG_SHADOW_COLOR = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMaskTex;  // размытая маска тени (R8)
uniform sampler2D uSrc;      // слой (для inner-клипа)
uniform sampler2D uMask;     // маска слоя (R8)
uniform int uUseMask;
uniform vec4 uColor;         // rgb + opacity
uniform int uClipToAlpha;    // 1 = inner shadow
void main() {
  float m = texture(uMaskTex, vUv).r * uColor.a;
  if (uClipToAlpha == 1) {
    float a = texture(uSrc, vUv).a;
    if (uUseMask == 1) a *= texture(uMask, vUv).r;
    m *= a;
  }
  outColor = vec4(uColor.rgb * m, m);
}
`

/** Булево комбинирование выделений: replace/add/subtract/intersect. */
export const FRAG_SEL_COMBINE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA; // текущее выделение
uniform sampler2D uB; // новая фигура
uniform int uOp;      // 0 replace, 1 add, 2 subtract, 3 intersect
void main() {
  float a = texture(uA, vUv).r;
  float b = texture(uB, vUv).r;
  float v = b;
  if (uOp == 1) v = max(a, b);
  if (uOp == 2) v = min(a, 1.0 - b);
  if (uOp == 3) v = min(a, b);
  outColor = vec4(v, 0.0, 0.0, 1.0);
}
`

/** Порог по одноканальной маске (для расширения/сжатия выделения). */
export const FRAG_THRESHOLD = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uThreshold;
void main() {
  float v = texture(uTex, vUv).r;
  // Мягкий порог шириной ~0.08 — без алиасинга по краю.
  outColor = vec4(smoothstep(uThreshold - 0.04, uThreshold + 0.04, v), 0.0, 0.0, 1.0);
}
`

/** Инверсия одноканальной маски. */
export const FRAG_INVERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() { outColor = vec4(1.0 - texture(uTex, vUv).r, 0.0, 0.0, 1.0); }
`

/**
 * Сепарабельный гаусс для растушёвки маски (один проход по направлению uDir).
 * uRadius в пикселях, вес — гауссиана с сигмой radius/2.
 */
export const FRAG_GAUSS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDir;     // (1/w, 0) или (0, 1/h)
uniform int uRadius;   // px, <= 100
void main() {
  float sigma = max(float(uRadius) * 0.5, 0.5);
  float twoSigma2 = 2.0 * sigma * sigma;
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -100; i <= 100; i++) {
    if (abs(i) > uRadius) continue;
    float w = exp(-float(i * i) / twoSigma2);
    sum += texture(uTex, vUv + uDir * float(i)).r * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}
`

/**
 * Наложение цвета (стиль слоя): видимые пиксели слоя перекрашиваются в
 * заданный цвет с заданной непрозрачностью; альфа-форма сохраняется.
 */
export const FRAG_COLOR_OVERLAY = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec4 uColor; // rgb + непрозрачность наложения
void main() {
  vec4 src = texture(uTex, vUv);
  vec4 overlay = vec4(uColor.rgb * src.a, src.a); // premult по альфе слоя
  outColor = mix(src, overlay, uColor.a);
}
`

/**
 * Сепарабельный гаусс по premult-RGBA (стиль слоя «Размытие по Гауссу»).
 * За краем документа — CLAMP_TO_EDGE (как в Photoshop): слой во весь холст
 * остаётся непрозрачным у границ; растворение краёв объекта дают его же
 * прозрачные пиксели внутри текстуры.
 */
export const FRAG_GAUSS_RGBA = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDir;     // (1/w, 0) или (0, 1/h)
uniform int uRadius;   // px, <= 100
void main() {
  float sigma = max(float(uRadius) * 0.5, 0.5);
  float twoSigma2 = 2.0 * sigma * sigma;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -100; i <= 100; i++) {
    if (abs(i) > uRadius) continue;
    float w = exp(-float(i * i) / twoSigma2);
    sum += texture(uTex, vUv + uDir * float(i)) * w;
    wsum += w;
  }
  outColor = sum / wsum;
}
`

/**
 * Размытие в движении (стиль слоя): усреднение по отрезку через пиксель
 * вдоль направления. premult-RGBA, за краем документа — CLAMP_TO_EDGE
 * (края холста не растворяются).
 */
export const FRAG_MOTION = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uVec; // полный вектор смаза в uv-единицах (dir * dist / размер)
void main() {
  const int TAPS = 64;
  vec4 sum = vec4(0.0);
  for (int i = 0; i <= TAPS; i++) {
    float t = float(i) / float(TAPS) - 0.5;
    sum += texture(uTex, vUv + uVec * t);
  }
  outColor = sum / float(TAPS + 1);
}
`

/**
 * Марширующие муравьи поверх выделения: граница = «внутри, но сосед в
 * 1 экранном пикселе снаружи» (явная выборка соседей — производные в
 * 2×2-квадах пропускают рёбра, совпадающие с границей квада).
 */
export const FRAG_ANTS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSel;
uniform vec2 uQuadPx; // размер дока на экране в px (для шага в 1 экранный px)
uniform float uTime;  // секунды

// За пределами документа — «снаружи»: иначе Ctrl+A (весь холст)
// не рисует муравьёв по периметру (CLAMP_TO_EDGE прятал границу).
float inside(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return step(0.5, texture(uSel, uv).r);
}

void main() {
  vec2 texel = 1.0 / uQuadPx;
  float c = inside(vUv);
  float nMin = min(
    min(inside(vUv + vec2(texel.x, 0.0)), inside(vUv - vec2(texel.x, 0.0))),
    min(inside(vUv + vec2(0.0, texel.y)), inside(vUv - vec2(0.0, texel.y)))
  );
  bool boundary = c > 0.5 && nMin < 0.5;
  if (!boundary) discard;
  float stripe = step(4.0, mod(gl_FragCoord.x + gl_FragCoord.y + uTime * 20.0, 8.0));
  outColor = vec4(vec3(stripe), 1.0);
}
`
