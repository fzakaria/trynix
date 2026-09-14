"""Tests for the pure parts of tools/share-link.py: composing the link
the GitHub action posts, naming a cache from its shorthand, reading a
store path's digest, and deciding what an attribute resolved to. Nothing
here builds or reaches the network. The resolution tests answer for nix
instead of running it."""

import contextlib
import importlib.util
import io
import os
import unittest
from urllib.parse import parse_qsl, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "share-link.py")

CACHE = "https://my-cache.cachix.org"
KEY = "my-cache.cachix.org-1:xmOWOHz2g/BlpCVQrTEZjSKWPk3S3Dukn1xiSWLidkY="
PATH = "/nix/store/vd1265k8rg8jgjvdm5hf5cvwbdbhywyh-hello-2.12.1"

# What `.outPath` gave back for a package built on a dynamic derivation,
# from the comment that opened issue #10: a slash and a hash, naming
# nothing a cache could serve.
PLACEHOLDER = "/0j78px59wbg76xis7aaj1vrvxwzc681pw013j66bzmra824fs69w"

ATTR = ".#hello"


class Nix:
    """The nix the tool shells out to, answering from a script rather
    than a store. Keyed by a prefix of the arguments as one string, so a
    test says what each invocation gives back and can then ask what was
    run. The longest matching prefix answers, so a test can single out
    one invocation without caring what order it lists the answers in."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, *args):
        call = " ".join(args)
        self.calls.append(call)

        # Pick the most specific scripted answer for this invocation.
        matches = [prefix for prefix in self.answers if call.startswith(prefix)]
        if not matches:
            raise AssertionError(f"unexpected: nix {call}")
        return self.answers[max(matches, key=len)]

    def ran(self, prefix):
        return self.count(prefix) > 0

    def count(self, prefix):
        return sum(call.startswith(prefix) for call in self.calls)


def resolving(answers):
    """The tool with its nix replaced by one that answers `answers`."""
    tool = load()
    tool.nix = Nix(answers)
    return tool


def resolve(tool, attr, build):
    """What the tool resolved, and what it said on the way there."""
    noise = io.StringIO()
    with contextlib.redirect_stderr(noise):
        paths = tool.store_paths(attr, build=build)
    return paths, noise.getvalue()


def load():
    spec = importlib.util.spec_from_file_location("share_link", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parameters(url):
    """The link's query as a list of pairs, decoded the way the page
    decodes it — `+` back to a space, `%2B` back to a plus."""
    return parse_qsl(urlparse(url).query)


class Link(unittest.TestCase):
    """What the action posts. The page reads the whole selection back out
    of the query string (site/js/url.js), so these check the round trip
    rather than the exact bytes: each path is its own `path`, a cache is
    one `cache` of a URL and a key with whitespace between, and `boot`
    only appears when it was asked for."""

    def test_a_path_and_its_cache_survive_the_round_trip(self):
        tool = load()
        url = tool.link(tool.SITE, [PATH], CACHE, [KEY], boot=False)
        self.assertEqual(
            parameters(url),
            [("path", PATH), ("cache", f"{CACHE} {KEY}")],
        )

    def test_every_path_gets_its_own_parameter(self):
        tool = load()
        other = "/nix/store/k8kmic5pxq0436rpi25a0pi3jbifcyp6-jq-1.7"
        url = tool.link(tool.SITE, [PATH, other], CACHE, [KEY], boot=False)
        self.assertEqual(
            [value for name, value in parameters(url) if name == "path"],
            [PATH, other],
        )

    def test_a_key_rotation_puts_the_cache_in_twice(self):
        tool = load()
        second = "my-cache.cachix.org-2:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        url = tool.link(tool.SITE, [PATH], CACHE, [KEY, second], boot=False)
        self.assertEqual(
            [value for name, value in parameters(url) if name == "cache"],
            [f"{CACHE} {KEY}", f"{CACHE} {second}"],
        )

    def test_boot_is_absent_unless_asked_for(self):
        tool = load()
        without = tool.link(tool.SITE, [PATH], CACHE, [KEY], boot=False)
        self.assertNotIn("boot", dict(parameters(without)))

        asked = tool.link(tool.SITE, [PATH], CACHE, [KEY], boot=True)
        self.assertEqual(dict(parameters(asked))["boot"], "1")

    def test_a_store_path_stays_readable(self):
        """The point of the encoding: someone reading the comment can see
        which build the link names, rather than a wall of %2F."""
        tool = load()
        url = tool.link(tool.SITE, [PATH], CACHE, [KEY], boot=False)
        self.assertIn(f"path={PATH}", url)

    def test_a_trailing_slash_on_the_site_does_not_double(self):
        tool = load()
        url = tool.link("https://trynix.dev/", [PATH], CACHE, [KEY], boot=False)
        self.assertTrue(url.startswith("https://trynix.dev/?"))


class NormalizeCacheUrl(unittest.TestCase):
    """Naming a cache. The URL is taken as given apart from a trailing
    slash, which the page would otherwise double when it joins a digest
    on. Nothing about a provider is inferred, so a bare name is an error
    rather than a guess."""

    def test_a_url_is_kept_as_it_was_given(self):
        tool = load()
        self.assertEqual(tool.normalize_cache_url(CACHE), CACHE)

    def test_a_trailing_slash_is_dropped(self):
        tool = load()
        self.assertEqual(tool.normalize_cache_url(f"{CACHE}/"), CACHE)

    def test_a_bare_name_is_refused(self):
        tool = load()
        with self.assertRaises(SystemExit):
            tool.normalize_cache_url("my-cache")


class ContainingStorePath(unittest.TestCase):
    """An app names a program inside a store path, and the guest mounts
    the store path. These check the trim, since evaluating an app is the
    default route and never builds anything to check the answer against."""

    def test_a_program_trims_to_its_store_path(self):
        tool = load()
        self.assertEqual(
            tool.containing_store_path(f"{PATH}/bin/hello"),
            PATH,
        )

    def test_a_deeper_program_trims_to_the_same_path(self):
        tool = load()
        self.assertEqual(
            tool.containing_store_path(f"{PATH}/libexec/inner/hello"),
            PATH,
        )

    def test_a_store_path_is_already_one(self):
        tool = load()
        self.assertEqual(tool.containing_store_path(PATH), PATH)

    def test_a_path_outside_the_store_is_refused(self):
        tool = load()
        with self.assertRaises(SystemExit):
            tool.containing_store_path("/usr/bin/hello")


class StorePathsAndPlaceholders(unittest.TestCase):
    """Telling a store path from the stand-in for one. An attribute whose
    output path is not a function of its inputs evaluates to a
    placeholder: a slash and 52 characters of nix's base32, with no store
    directory and no name. Each test hands the two predicates a string
    and checks which of them claims it."""

    def test_a_store_path_is_one(self):
        """A plain store path is a store path and not a placeholder."""
        tool = load()
        self.assertTrue(tool.is_store_path(PATH))
        self.assertFalse(tool.is_placeholder(PATH))

    def test_a_placeholder_is_not_a_store_path(self):
        """The placeholder from issue #10 is recognised as one."""
        tool = load()
        self.assertTrue(tool.is_placeholder(PLACEHOLDER))
        self.assertFalse(tool.is_store_path(PLACEHOLDER))

    def test_a_program_under_a_placeholder_is_still_a_placeholder(self):
        """An app's program string keeps the placeholder as its prefix."""
        tool = load()
        self.assertTrue(tool.is_placeholder(f"{PLACEHOLDER}/bin/hello"))

    def test_a_path_outside_the_store_is_neither(self):
        """An FHS path is refused by both predicates."""
        tool = load()
        self.assertFalse(tool.is_store_path("/usr/bin/hello"))
        self.assertFalse(tool.is_placeholder("/usr/bin/hello"))

    def test_a_file_inside_a_store_path_is_not_the_store_path(self):
        """A program inside a store path has to be trimmed before linking."""
        tool = load()
        self.assertFalse(tool.is_store_path(f"{PATH}/bin/hello"))

    def test_letters_outside_nix_base32_are_neither(self):
        """Nix's base32 has no e, o, u or t. A hash spelled with one of
        them came from something other than nix."""
        tool = load()
        self.assertFalse(tool.is_placeholder("/" + "e" * tool.PLACEHOLDER_LENGTH))
        self.assertFalse(
            tool.is_store_path(f"{tool.STORE_PREFIX}{'e' * tool.DIGEST_LENGTH}-hello")
        )


class Resolving(unittest.TestCase):
    """What an attribute resolves to, and when that costs a build. Each
    test scripts nix's answers, resolves `.#hello`, and checks the paths
    and which nix commands ran.

    Evaluating is the default and stays that way. An attribute that
    evaluates to a placeholder is the exception: the only way to name the
    path behind it is to realise it (#10), and a placeholder in a link
    would be a comment nobody could boot."""

    def test_a_package_is_evaluated_and_not_built(self):
        """A package with a real outPath is linked without a build."""
        tool = resolving(
            {
                "eval --json": '"derivation"',
                "eval --raw": PATH,
            }
        )
        self.assertEqual(tool.store_paths(ATTR, build=False), [PATH])
        self.assertFalse(tool.nix.ran("build"))

    def test_an_app_resolves_to_the_store_path_holding_its_program(self):
        """An app's program is trimmed to its store path without a build."""
        tool = resolving(
            {
                "eval --json": '"app"',
                "eval --raw": f"{PATH}/bin/hello",
            }
        )
        self.assertEqual(tool.store_paths(ATTR, build=False), [PATH])
        self.assertFalse(tool.nix.ran("build"))

    def test_a_placeholder_is_realised_rather_than_linked(self):
        """A package whose outPath is a placeholder is built, the built
        path is linked, and the log names the placeholder."""
        tool = resolving(
            {
                "eval --json": '"derivation"',
                "eval --raw": PLACEHOLDER,
                "build": PATH,
            }
        )
        paths, said = resolve(tool, ATTR, build=False)
        self.assertEqual(paths, [PATH])
        self.assertTrue(tool.nix.ran(f"build {ATTR} --no-link --print-out-paths"))
        self.assertIn(PLACEHOLDER, said)

    def test_an_app_under_a_placeholder_is_realised_through_its_drv(self):
        """An app whose program sits under a placeholder is built through
        the drv named in the program's string context."""
        drv = "/nix/store/xa1h0qrwyzjd3kzf06rk0sk6wdlnqm4z-hello.drv"
        tool = resolving(
            {
                "eval --json": '"app"',
                "eval --raw": f"{PLACEHOLDER}/bin/hello",
                "eval --raw .#hello.program --apply": drv,
                "build": PATH,
            }
        )
        paths, _ = resolve(tool, ATTR, build=False)
        self.assertEqual(paths, [PATH])
        self.assertTrue(tool.nix.ran(f"build {drv}^out"))

    def test_the_attribute_type_is_evaluated_once(self):
        """Falling back from evaluating to building reuses the answer to
        whether the attribute is an app, rather than evaluating the
        flake a second time to ask again."""
        tool = resolving(
            {
                "eval --json": '"derivation"',
                "eval --raw": PLACEHOLDER,
                "build": PATH,
            }
        )
        resolve(tool, ATTR, build=False)
        self.assertEqual(tool.nix.count("eval --json"), 1)

    def test_every_output_of_a_build_is_kept(self):
        """A build that prints two outputs links both."""
        other = "/nix/store/k8kmic5pxq0436rpi25a0pi3jbifcyp6-hello-2.12.1-man"
        tool = resolving(
            {
                "eval --json": '"derivation"',
                "build": f"{PATH}\n{other}",
            }
        )
        self.assertEqual(tool.store_paths(ATTR, build=True), [PATH, other])

    def test_something_that_is_not_a_store_path_is_refused(self):
        """Whatever the route, a link may only name a path a cache can
        serve. A build that printed a placeholder exits instead of being
        posted as though it were a path."""
        tool = resolving(
            {
                "eval --json": '"derivation"',
                "build": PLACEHOLDER,
            }
        )
        with self.assertRaises(SystemExit):
            tool.store_paths(ATTR, build=True)

    def test_a_build_that_names_nothing_is_refused(self):
        """A build that printed no paths exits rather than linking none."""
        tool = resolving(
            {
                "eval --json": '"derivation"',
                "build": "",
            }
        )
        with self.assertRaises(SystemExit):
            tool.store_paths(ATTR, build=True)


class Digest(unittest.TestCase):
    """The name a cache serves a path's narinfo under: the 32 characters
    before the first dash of the basename, and nothing else."""

    def test_the_digest_is_the_basename_up_to_the_dash(self):
        tool = load()
        self.assertEqual(tool.digest_of(PATH), "vd1265k8rg8jgjvdm5hf5cvwbdbhywyh")
        self.assertEqual(len(tool.digest_of(PATH)), tool.DIGEST_LENGTH)


if __name__ == "__main__":
    unittest.main()
