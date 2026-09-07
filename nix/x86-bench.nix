# The translator's benchmark suite: a handful of store binaries chosen
# to cover what the translated lane has to get right (docs/translate.md),
# each with the output the same binary produces natively on the build
# machine. tools/x86-bench.mjs runs them through the translator and
# compares: an output that differs is a bug, and the translation counts
# and wall times say whether a change made the lane slower.
#
# The programs are run natively here, so this only builds on
# x86_64-linux and is not meant to be substituted.
{ pkgs }:
let
  # One entry per representative binary: the language and runtime the
  # entry stands for, the command, and what it reads on stdin.
  programs = [
    {
      name = "hello";
      lang = "C, static-ish";
      argv = [ "${pkgs.hello}/bin/hello" ];
    }
    {
      name = "jq";
      lang = "C";
      argv = [
        "${pkgs.jq}/bin/jq"
        "-c"
        "[range(1000)] | map(. * 2) | add"
      ];
      stdin = "null\n";
    }
    {
      name = "jj";
      lang = "Rust";
      argv = [
        "${pkgs.jujutsu}/bin/jj"
        "--version"
      ];
    }
    {
      name = "age";
      lang = "Go";
      argv = [
        "${pkgs.age}/bin/age"
        "--version"
      ];
    }
    {
      name = "fzf";
      lang = "Go, threads";
      argv = [
        "${pkgs.fzf}/bin/fzf"
        "--filter"
        "b"
      ];
      stdin = "alpha\nbravo\ncharlie\n";
    }
    {
      name = "python";
      lang = "interpreter";
      argv = [
        "${pkgs.python3}/bin/python3"
        "-c"
        "import json; print(json.dumps(sorted({'b': 2, 'a': 1}.items())))"
      ];
    }
    {
      name = "ruby";
      lang = "interpreter";
      argv = [
        "${pkgs.ruby}/bin/ruby"
        "-e"
        "puts [3, 1, 2].sort.map { |x| x * 2 }.inspect"
      ];
    }
    {
      name = "sh";
      lang = "fork, exec, pipes";
      argv = [
        "${pkgs.busybox}/bin/busybox"
        "sh"
        "-c"
        "echo $((6 * 7)) | ${pkgs.busybox}/bin/busybox tr 4 4; ${pkgs.busybox}/bin/busybox true && echo ok"
      ];
    }
  ];

  # The suite as JSON, minus the expected output the build fills in.
  suite = builtins.toJSON (
    map (p: {
      inherit (p) name lang argv;
      stdin = p.stdin or "";
    }) programs
  );
in
pkgs.runCommand "trynix-x86-bench-suite"
  {
    nativeBuildInputs = [ pkgs.python3 ];
    preferLocalBuild = true;
    allowSubstitutes = false;
    passAsFile = [ "suite" ];
    inherit suite;
  }
  ''
    # Run each program natively and record its stdout and status; the
    # translated run must reproduce both.
    export HOME=$TMPDIR
    python3 - "$suitePath" > $out <<'PY'
    import json, subprocess, sys
    programs = json.load(open(sys.argv[1]))
    for p in programs:
        r = subprocess.run(p["argv"], input=p["stdin"].encode(), capture_output=True)
        p["stdout"] = r.stdout.decode()
        p["status"] = r.returncode
    json.dump({"programs": programs}, sys.stdout, indent=2)
    PY
  ''
