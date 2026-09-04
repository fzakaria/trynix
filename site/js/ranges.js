// The version-range lane: a line of specs, each an attribute and an
// optional range, resolved against the multiverse index.
//
//   python3@3.10.*  ripgrep  jujutsu@>=0.40
//
// Each spec is resolved on its own — the newest version in the index
// that matches. That is deliberately less than what [grail] does:
// grail solves for a moment in nixpkgs history where every constraint
// held *simultaneously*, which is a different (NP-hard) question and
// the reason it carries a solver. Independent resolution can hand back
// a set that never coexisted in one nixpkgs, which is fine here —
// trynix mounts store paths side by side rather than evaluating them
// together — but it is not a coexistence guarantee, and the page says
// so with a link.
//
// [grail]: https://github.com/fzakaria/grail

import { versionsOf, compareVersions } from "./multiverse.js";

// attr, an optional operator, and a version pattern.
const SPEC = /^([^@\s]+)(?:@(>=|<=|>|<|=)?(.+))?$/;

export function parseSpecs(line) {
  return line
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      const match = SPEC.exec(text);
      if (match === null) {
        throw new Error(`cannot parse "${text}"`);
      }
      const [, attr, operator, pattern] = match;
      return {
        text,
        attr,
        operator: operator ?? null,
        pattern: pattern ?? null,
      };
    });
}

// Does one version satisfy one spec? A pattern with no operator is a
// prefix match, so 3.10.* and 3.10 both accept 3.10.6; with an
// operator it is a comparison.
export function matches(spec, version) {
  if (spec.pattern === null) {
    return true;
  }

  if (spec.operator === null || spec.operator === "=") {
    const prefix = spec.pattern.replace(/\.?\*$/, "");
    return version === prefix || version.startsWith(`${prefix}.`);
  }

  const order = compareVersions(version, spec.pattern);
  switch (spec.operator) {
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    default:
      return false;
  }
}

// Resolve every spec to its newest matching build that the census has
// not marked dead. Returns { resolved, problems }.
export async function resolveSpecs(specs) {
  const resolved = [];
  const problems = [];

  for (const spec of specs) {
    const versions = await versionsOf(spec.attr);
    if (versions.length === 0) {
      problems.push(`${spec.attr} is not in the index`);
      continue;
    }

    // versionsOf returns newest first, so the first match wins.
    const hit = versions.find(
      (v) => v.alive !== false && matches(spec, v.version),
    );
    if (hit === undefined) {
      problems.push(
        `no live version of ${spec.attr} matches ${spec.pattern ?? "any"}`,
      );
      continue;
    }
    resolved.push(hit);
  }

  return { resolved, problems };
}
