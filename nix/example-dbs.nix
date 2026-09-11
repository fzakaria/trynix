# Example SQLite databases, to boot next to sqlite itself: an empty
# sqlite3 prompt is a demo of nothing, and typing a schema into one over
# a serial console is worse.
#
# Two databases, because the canonical example is two different things
# depending on who is asking. SCOTT is the employees-and-departments
# schema Oracle has shipped since the 1980s -- fourteen rows, a
# self-join on the manager column, salary grades to range-join against.
# Chinook is a digital music store with real volume: 3503 tracks, 347
# albums, 59 customers, and the 412 invoices between them.
#
# The closure is this one path. The databases are files with no store
# references, so publishing this to a cache costs one NAR, and the page
# fetches sqlite's own closure from cache.nixos.org as usual.
{ pkgs }:
let
  shareDir = "share/trynix-example-dbs";

  # The upstream SQL rather than the .sqlite file the same release
  # carries: the text is what says where every row came from, and
  # building the database here means the bytes are sqlite's own.
  chinookSql = pkgs.fetchurl {
    url = "https://github.com/lerocha/chinook-database/releases/download/v1.4.5/Chinook_Sqlite.sql";
    hash = "sha256-/csnGz6chAIWsJFodSvdypc+05F7QOSbYDsVgxEUrqE=";
  };

  databases = [
    {
      name = "scott";
      sql = ./example-dbs/scott.sql;
      summary = "14 employees, 4 departments, 5 salary grades (emp, dept, salgrade, bonus)";
      example = "select ename, job, sal from emp order by sal desc limit 5;";
    }
    {
      name = "chinook";
      sql = chinookSql;
      summary = "a music store: 3503 tracks, 275 artists, 347 albums, 59 customers, 412 invoices";
      example = "select Name, Composer from Track limit 5;";
    }
  ];

  # A launcher per database, so a boot is `scott` or `chinook` at the
  # prompt rather than a store path typed out by hand.
  #
  # The store arrives over a read-only 9p share and the point of an
  # example database is that you can write to it, so the file is copied
  # to /tmp on first use. sqlite3 comes from PATH -- this path carries
  # none of its own -- and saying so is more use than "not found".
  launcher = db: ''
    cat > $out/bin/${db.name} <<LAUNCHER
    #!/bin/sh
    set -eu

    if ! command -v sqlite3 > /dev/null; then
      echo "${db.name}: sqlite3 is not on PATH; boot this store path together with ?pkg=sqlite" >&2
      exit 127
    fi

    db="\''${TMPDIR:-/tmp}/${db.name}.db"

    if [ ! -f "\$db" ]; then
      cp $out/${shareDir}/${db.name}.db "\$db"
      chmod u+w "\$db"
      echo "${db.name}: ${db.summary}"
      echo "${db.name}: writable copy at \$db; try: ${db.example}"
    fi

    exec sqlite3 -init $out/${shareDir}/sqliterc "\$db" "\$@"
    LAUNCHER
    chmod 755 $out/bin/${db.name}
  '';

  build = db: ''
    sqlite3 $out/${shareDir}/${db.name}.db ".read ${db.sql}"
    ${launcher db}
  '';
in
pkgs.runCommand "trynix-example-dbs"
  {
    nativeBuildInputs = [ pkgs.sqlite ];

    meta = {
      description = "SCOTT and Chinook as SQLite databases, for booting next to sqlite";
      longDescription = ''
        SCOTT is Oracle's demobld.sql schema, transliterated to SQLite.
        Chinook is github.com/lerocha/chinook-database v1.4.5, built from
        its own Chinook_Sqlite.sql.
      '';
      license = pkgs.lib.licenses.mit;
    };
  }
  ''
    mkdir -p $out/bin $out/${shareDir}

    # Headers and boxed rows: the default pipe-separated output is
    # unreadable for anything wider than one column.
    cat > $out/${shareDir}/sqliterc <<'RC'
    .headers on
    .mode box
    RC

    ${pkgs.lib.concatMapStrings build databases}
  ''
