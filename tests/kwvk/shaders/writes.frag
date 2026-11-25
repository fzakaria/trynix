// One buffer stored to and one only read: the first stays writable.
#version 450
layout(set = 0, binding = 0, std430) buffer Out { vec4 outv[]; };
layout(set = 0, binding = 1, std430) buffer In { vec4 inv[]; };
layout(location = 0) out vec4 color;
void main() {
	outv[int(gl_FragCoord.x)] = inv[0];
	color = inv[1];
}
