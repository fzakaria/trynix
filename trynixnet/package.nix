{ pkgs }:
pkgs.buildGoModule {
  pname = "trynixnet";
  version = "0.1.0";
  src = pkgs.lib.cleanSource ./.;
  vendorHash = "sha256-uXNzxbxQAIoK/S0283WalVwpBnEsPN8tRTVrrtnwlW4=";
  nativeBuildInputs = [ pkgs.go ];
  # Build the Ethernet/HTTP stack for the browser, not the build machine.
  buildPhase = ''
    runHook preBuild
    GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o trynixnet.wasm ./cmd/trynixnet
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    go test ./...
    runHook postCheck
  '';
  installPhase = ''
    mkdir -p $out
    cp trynixnet.wasm $out/
    cp ${pkgs.go}/share/go/lib/wasm/wasm_exec.js $out/
  '';
}
