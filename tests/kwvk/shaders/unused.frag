// GZDoom's texture12: a sampler declared and never read must go, with
// the never-read bone buffer; the light buffer, read, stays.
#version 450
layout(set = 2, binding = 0) uniform sampler2D tex;
layout(set = 2, binding = 1) uniform sampler2D texture2;
layout(set = 2, binding = 11) uniform sampler2D texture12;
layout(set = 1, binding = 3, std430) buffer LightBufferSSO { vec4 lights[]; };
layout(set = 1, binding = 4, std430) buffer BoneBufferSSO { mat4 bones[]; };
layout(location = 0) out vec4 color;
void main() { color = texture(tex, vec2(0.5)) + texture(texture2, vec2(0.5)) + lights[0]; }
