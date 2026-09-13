{ pkgs }:
pkgs.buildGoModule {
  pname = "trynixsproxy";
  version = "0.1.0";
  src = pkgs.lib.cleanSource ./.;
  vendorHash = "sha256-Nxfe1eXZEbN/BCb6TgpLqLiIowaghR2EliyXRPWuoMQ=";
  meta.mainProgram = "trynixsproxy";
}
