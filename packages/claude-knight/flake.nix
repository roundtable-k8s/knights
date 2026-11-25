{
  description = "claude-knight: development shell and knight tool set with the toolchain pinned for CI";

  # Same nixpkgs revision as roundtable-k8s/roundtable, so both repos get the same toolchain.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/2786a2a72088ecf32aea5b3ec52099e6a7cff78f";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Shared by devShells.default and packages.knight-tools so the two cannot drift.
      # CI runs Node 22 (actions/setup-node node-version: 22, see .github/workflows/ci.yml),
      # so nodejs_22 (which bundles npm) is what the build, tests and `npm ci` use.
      devTools =
        pkgs: with pkgs; [
          nodejs_22
          git
          gh
          jq
        ];
    in
    {
      packages = forAllSystems (pkgs: {
        # The same tools as the dev shell as one installable environment, for mounting
        # into a knight image through spec.tools.flakes. No shell hooks.
        knight-tools = pkgs.buildEnv {
          name = "knight-tools";
          paths = devTools pkgs;
        };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.knight-tools;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = devTools pkgs;
        };
      });
    };
}
