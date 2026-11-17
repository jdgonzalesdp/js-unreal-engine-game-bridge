// GLSL names HLSL reserves get a jsgb_ prefix before translation (Runtime/src/hlslNames.ts): PrepViz's print grid has a
// function named `line`, and Unreal's compiler rejected the whole material for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {escapeHlslNames} from '../../Runtime/src/hlslNames.ts';

test('a function, a local and a struct member named after HLSL keywords are renamed with all their uses', () => {
  const src = 'struct S { float point; };\nfloat line(float s) { return s; }\nvoid main() { S v; v.point = 1.0; float triangle = line(v.point); }';
  const out = escapeHlslNames(src);
  assert.match(out, /float jsgb_line\(float s\)/);
  assert.match(out, /float jsgb_triangle = jsgb_line\(v\.jsgb_point\)/);
  assert.match(out, /struct S \{ float jsgb_point; \}/);
  assert.doesNotMatch(out, /[^_]\bline\(/);
});

test('uniforms and attributes keep their names, and so do texture(), longer names and the #line directive', () => {
  const src = '#line 3\nuniform float matrix;\nattribute vec3 point;\nfloat lineWidth = 1.0;\nvoid main() { gl_FragColor = texture(map, uv) * matrix * point.x * lineWidth; }';
  assert.equal(escapeHlslNames(src), src);
});

test('a shader without any such name comes back unchanged', () => {
  const src = 'void main() { gl_FragColor = vec4(1.0); }';
  assert.equal(escapeHlslNames(src), src);
});
