// GZDoom's shape: bone and light buffers declared without `readonly`
// and only read, in a vertex stage, where WebGPU refuses a writable one.
#version 450
layout(set = 1, binding = 4, std430) buffer BoneBufferSSO { mat4 bones[]; };
layout(set = 1, binding = 3, std430) buffer LightBufferSSO { vec4 lights[]; };
layout(location = 0) in vec4 aPosition;
layout(location = 1) in int aBone;
void main() {
	vec4 p = bones[aBone] * aPosition;
	gl_Position = p + lights[0] * 0.0;
}
