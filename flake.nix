{
  description = "Ideation Workbench Cloudflare and NixOS application";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.stdenv.mkDerivation {
            pname = "ideation-workbench";
            version = "2.0.0";
            src = ./.;
            npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
            nativeBuildInputs = [ pkgs.nodejs_22 pkgs.npmHooks.npmConfigHook pkgs.makeWrapper ];
            buildPhase = "npm run build";
            installPhase = ''
              mkdir -p $out/lib/ideation-workbench $out/bin
              cp -r build public server src package.json node_modules $out/lib/ideation-workbench/
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/ideation-workbench \
                --add-flags "$out/lib/ideation-workbench/server/node-adapter.mjs"
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/ideation-workbench-maintenance \
                --add-flags "$out/lib/ideation-workbench/server/node-maintenance.mjs"
            '';
          };
        });

      nixosModules.default = import ./nix/module.nix self;

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
      });
    };
}
