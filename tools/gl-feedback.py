"""Draw into a texture that is still bound to a sampler of the program,
through EGL surfaceless and GLES 3.0 with ctypes, and read each draw
back. This runs inside the unkernel guest: gui-test.py's feedback case
copies it there and runs it with the guest's python3.

GL lets a program declare a sampler whose unit holds the texture the
draw renders into, as long as the draw does not read that texture; the
shader here samples it only in a branch a uniform keeps closed. GL calls
the values such a draw would sample undefined. WebGL 2 refuses the draw
with INVALID_OPERATION instead, and unkernel's GL renderer, which
replays the guest's GL on the page's WebGL 2, then puts the program's
whole context in error, so a later draw with no loop fails too. The
site's Mesa sends the renderer a stand-in view for such a draw
(patches/mesa/).

    python3 gl-feedback.py [<libEGL.so.1> <libGLESv2.so.2>]

Without paths, libglvnd's from the store. Prints the renderer and one
line per step, then FEEDBACK-TEST PASS or FAIL, and exits 1 on FAIL.
"""

import ctypes
import glob
import sys

# libglvnd's dispatch libraries, when no paths are given.
GLVND_EGL = "/nix/store/*-libglvnd-*/lib/libEGL.so.1"
GLVND_GLES = "/nix/store/*-libglvnd-*/lib/libGLESv2.so.2"

EGL_NONE = 0x3038
EGL_OPENGL_ES_API = 0x30A0
EGL_CONTEXT_MAJOR_VERSION = 0x3098
EGL_PLATFORM_SURFACELESS_MESA = 0x31DD
GLES_MAJOR_VERSION = 3

GL_RENDERER = 0x1F01
GL_VERTEX_SHADER = 0x8B31
GL_FRAGMENT_SHADER = 0x8B30
GL_COMPILE_STATUS = 0x8B81
GL_LINK_STATUS = 0x8B82
GL_ARRAY_BUFFER = 0x8892
GL_STATIC_DRAW = 0x88E4
GL_FLOAT = 0x1406
GL_TEXTURE_2D = 0x0DE1
GL_TEXTURE0 = 0x84C0
GL_RGBA8 = 0x8058
GL_RGBA = 0x1908
GL_UNSIGNED_BYTE = 0x1401
GL_FRAMEBUFFER = 0x8D40
GL_COLOR_ATTACHMENT0 = 0x8CE0
GL_FRAMEBUFFER_COMPLETE = 0x8CD5
GL_TRIANGLES = 0x0004
GL_TEXTURE_MIN_FILTER = 0x2801
GL_NEAREST = 0x2600

# The side of the square textures, in pixels, and the one mipmap level
# each has.
SIZE = 64
LEVELS = 1

# Two triangles that cover the target, as x, y pairs.
QUAD = (-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1)
QUAD_VERTICES = 6
COORDINATES_PER_VERTEX = 2

# The texture unit the sampler reads, which the loop puts the target on.
SAMPLER_UNIT = 0

VS = b"""#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
"""

# The sampler is declared and sampled, but only in a branch that a
# uniform keeps closed, so no draw here reads the texture it writes.
FS = b"""#version 300 es
precision mediump float;
uniform sampler2D s;
uniform float never;
uniform vec4 color;
out vec4 o;
void main() {
  o = color;
  if (never > 0.5) {
    o = texture(s, vec2(0.5));
  }
}
"""
CLOSED = 0.0

RED = (1.0, 0.0, 0.0, 1.0)
GREEN = (0.0, 1.0, 0.0, 1.0)
BLUE = (0.0, 0.0, 1.0, 1.0)
CHANNEL_MAX = 255

PASS = "FEEDBACK-TEST PASS"
FAIL = "FEEDBACK-TEST FAIL"


def libraries():
    """The EGL and GLES libraries: the command line's, or libglvnd's."""
    if len(sys.argv) == 3:
        return sys.argv[1], sys.argv[2]
    egl = sorted(glob.glob(GLVND_EGL))
    gles = sorted(glob.glob(GLVND_GLES))
    if not egl or not gles:
        raise SystemExit(f"no libglvnd in the store: {GLVND_EGL}, {GLVND_GLES}")
    return egl[-1], gles[-1]


def context(egl):
    """Make a GLES 3.0 context with no surface current: the test draws
    into textures."""
    pointer = ctypes.c_void_p
    egl.eglGetPlatformDisplay.restype = pointer
    egl.eglGetPlatformDisplay.argtypes = [ctypes.c_uint, pointer, pointer]
    egl.eglInitialize.argtypes = [pointer] * 3
    egl.eglCreateContext.restype = pointer
    egl.eglCreateContext.argtypes = [pointer] * 4
    egl.eglMakeCurrent.argtypes = [pointer] * 4

    display = egl.eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, None, None)
    if not display or not egl.eglInitialize(display, None, None):
        raise SystemExit("no EGL surfaceless display")

    egl.eglBindAPI(EGL_OPENGL_ES_API)
    attributes = (ctypes.c_int * 3)(EGL_CONTEXT_MAJOR_VERSION, GLES_MAJOR_VERSION, EGL_NONE)
    made = egl.eglCreateContext(display, None, None, attributes)
    if not made or not egl.eglMakeCurrent(display, None, None, made):
        raise SystemExit("no GLES 3.0 context")


def compile_shader(gl, kind, text):
    shader = gl.glCreateShader(kind)
    source = ctypes.c_char_p(text)
    gl.glShaderSource(shader, 1, ctypes.byref(source), None)
    gl.glCompileShader(shader)
    ok = ctypes.c_int()
    gl.glGetShaderiv(shader, GL_COMPILE_STATUS, ctypes.byref(ok))
    if not ok.value:
        raise SystemExit("shader did not compile")
    return shader


def program(gl):
    """Link and use the program; returns the location of its colour."""
    linked = gl.glCreateProgram()
    gl.glAttachShader(linked, compile_shader(gl, GL_VERTEX_SHADER, VS))
    gl.glAttachShader(linked, compile_shader(gl, GL_FRAGMENT_SHADER, FS))
    gl.glLinkProgram(linked)
    ok = ctypes.c_int()
    gl.glGetProgramiv(linked, GL_LINK_STATUS, ctypes.byref(ok))
    if not ok.value:
        raise SystemExit("program did not link")
    gl.glUseProgram(linked)

    # The sampler reads SAMPLER_UNIT, in a branch that stays closed.
    gl.glUniform1i(gl.glGetUniformLocation(linked, b"s"), SAMPLER_UNIT)
    gl.glUniform1f.argtypes = [ctypes.c_int, ctypes.c_float]
    gl.glUniform1f(gl.glGetUniformLocation(linked, b"never"), CLOSED)
    gl.glUniform4f.argtypes = [ctypes.c_int] + [ctypes.c_float] * 4
    return gl.glGetUniformLocation(linked, b"color")


def quad(gl):
    """Upload the quad and point the program's one input at it."""
    vertices = (ctypes.c_float * len(QUAD))(*QUAD)
    buffer = ctypes.c_uint()
    gl.glGenBuffers(1, ctypes.byref(buffer))
    gl.glBindBuffer(GL_ARRAY_BUFFER, buffer)
    gl.glBufferData(GL_ARRAY_BUFFER, ctypes.sizeof(vertices), vertices, GL_STATIC_DRAW)
    array = ctypes.c_uint()
    gl.glGenVertexArrays(1, ctypes.byref(array))
    gl.glBindVertexArray(array)
    gl.glEnableVertexAttribArray(0)
    gl.glVertexAttribPointer(0, COORDINATES_PER_VERTEX, GL_FLOAT, 0, 0, None)


def textures(gl):
    """Two textures to draw into, and the framebuffer they take turns
    in; returns the two."""
    names = (ctypes.c_uint * 2)()
    gl.glGenTextures(2, names)
    for name in names:
        gl.glBindTexture(GL_TEXTURE_2D, name)
        gl.glTexStorage2D(GL_TEXTURE_2D, LEVELS, GL_RGBA8, SIZE, SIZE)
        gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST)

    framebuffer = ctypes.c_uint()
    gl.glGenFramebuffers(1, ctypes.byref(framebuffer))
    gl.glBindFramebuffer(GL_FRAMEBUFFER, framebuffer)
    gl.glViewport(0, 0, SIZE, SIZE)
    return names[0], names[1]


def draw(gl, color_location, target, bound, color):
    """Draw `color` into `target` with `bound` on the sampler's unit and
    read the middle pixel back."""
    gl.glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target, 0)
    if gl.glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE:
        raise SystemExit("framebuffer incomplete")

    gl.glActiveTexture(GL_TEXTURE0 + SAMPLER_UNIT)
    gl.glBindTexture(GL_TEXTURE_2D, bound)
    gl.glUniform4f(color_location, *color)
    gl.glDrawArrays(GL_TRIANGLES, 0, QUAD_VERTICES)
    gl.glFinish()

    pixel = (ctypes.c_ubyte * 4)()
    gl.glReadPixels(SIZE // 2, SIZE // 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel)
    return tuple(pixel)


def main():
    egl_path, gles_path = libraries()
    egl = ctypes.CDLL(egl_path)
    gl = ctypes.CDLL(gles_path)
    gl.glGetString.restype = ctypes.c_char_p

    context(egl)
    print("renderer:", gl.glGetString(GL_RENDERER).decode(), flush=True)
    color_location = program(gl)
    quad(gl)
    a, b = textures(gl)

    # 1: into B with A on the sampler's unit (no loop); 2: into A with A
    # still on the unit (a loop WebGL refuses, never sampled); 3: into B
    # with no texture on the unit (no loop), which fails too when the
    # second draw put the context in error.
    steps = [
        ("draw into B, A bound", b, a, RED),
        ("draw into A, A bound", a, a, GREEN),
        ("draw into B, nothing bound", b, 0, BLUE),
    ]
    failed = 0
    for label, target, bound, color in steps:
        got = draw(gl, color_location, target, bound, color)
        want = tuple(round(channel * CHANNEL_MAX) for channel in color)
        verdict = "ok" if got == want else "WRONG"
        if got != want:
            failed += 1
        print(f"{label}: read {got}, want {want}: {verdict}", flush=True)

    print(FAIL if failed else PASS)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
