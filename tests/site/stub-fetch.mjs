// A stand-in for the global fetch, for tests of the modules that read
// the multiverse index.

// Answers fetch's calls in order from `answers`, an Error to throw or a
// Response to resolve with, and counts the calls in the returned
// object's `calls`. The real fetch is put back once the test `t` ends.
export function stubFetch(t, answers) {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  const stub = { calls: 0 };
  globalThis.fetch = async () => {
    const answer = answers[stub.calls];
    stub.calls += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return stub;
}

// A response carrying `value` as JSON, and an empty one with `status`.
export const jsonResponse = (value) => new Response(JSON.stringify(value));
export const statusResponse = (status) => new Response("", { status });
