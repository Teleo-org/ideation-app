self: { config, lib, pkgs, ... }:
let
  cfg = config.services.ideation-workbench;
  inherit (lib) mkEnableOption mkIf mkOption types;
  appPort = if cfg.oidc.enable then cfg.internalPort else cfg.port;
in {
  options.services.ideation-workbench = {
    enable = mkEnableOption "Ideation Workbench";
    package = mkOption { type = types.package; default = self.packages.${pkgs.system}.default; };
    user = mkOption { type = types.str; default = "ideation-workbench"; };
    group = mkOption { type = types.str; default = "ideation-workbench"; };
    dataDir = mkOption { type = types.path; default = "/var/lib/ideation-workbench"; };
    address = mkOption { type = types.str; default = "127.0.0.1"; };
    port = mkOption { type = types.port; default = 4317; description = "Port exposed to the reverse proxy."; };
    internalPort = mkOption { type = types.port; default = 4318; description = "Private application port used when the OIDC proxy is enabled."; };
    baseUrl = mkOption { type = types.str; example = "https://ideas.example.net"; };
    identityHeader = mkOption { type = types.str; default = "x-forwarded-user"; };
    trustedProxyAddresses = mkOption { type = types.listOf types.str; default = [ "127.0.0.1" "::1" "::ffff:127.0.0.1" ]; };
    oidc = {
      enable = mkEnableOption "the bundled generic OIDC reverse proxy";
      issuerUrl = mkOption { type = types.str; default = ""; };
      clientId = mkOption { type = types.str; default = ""; };
      clientSecretFile = mkOption { type = types.nullOr types.path; default = null; };
      cookieSecretFile = mkOption { type = types.nullOr types.path; default = null; };
      allowedEmailDomains = mkOption { type = types.listOf types.str; default = [ "*" ]; };
    };
  };

  config = mkIf cfg.enable {
    users.users.${cfg.user} = { isSystemUser = true; group = cfg.group; home = cfg.dataDir; };
    users.groups.${cfg.group} = {};
    systemd.tmpfiles.rules = [ "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -" ];

    systemd.services.ideation-workbench = {
      description = "Ideation Workbench";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        IW_HOST = cfg.address;
        IW_PORT = toString appPort;
        IW_BASE_URL = cfg.baseUrl;
        IW_DATA_DIR = cfg.dataDir;
        IW_IDENTITY_HEADER = cfg.identityHeader;
        IW_TRUSTED_PROXY_ADDRESSES = lib.concatStringsSep "," cfg.trustedProxyAddresses;
      };
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStart = "${cfg.package}/bin/ideation-workbench";
        Restart = "on-failure";
        RestartSec = 2;
        StateDirectory = "ideation-workbench";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
      };
    };

    systemd.services.ideation-workbench-oidc = mkIf cfg.oidc.enable {
      description = "Ideation Workbench OIDC proxy";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "ideation-workbench.service" ];
      requires = [ "ideation-workbench.service" ];
      path = [ pkgs.oauth2-proxy ];
      script = ''
        exec oauth2-proxy \
          --provider=oidc \
          --oidc-issuer-url=${lib.escapeShellArg cfg.oidc.issuerUrl} \
          --client-id=${lib.escapeShellArg cfg.oidc.clientId} \
          --client-secret="$(cat "$CREDENTIALS_DIRECTORY/client-secret")" \
          --cookie-secret="$(cat "$CREDENTIALS_DIRECTORY/cookie-secret")" \
          --redirect-url=${lib.escapeShellArg "${cfg.baseUrl}/oauth2/callback"} \
          --http-address=${cfg.address}:${toString cfg.port} \
          --upstream=http://${cfg.address}:${toString cfg.internalPort} \
          --reverse-proxy=true \
          --set-xauthrequest=true \
          --pass-user-headers=true \
          ${lib.concatMapStringsSep " \\\n          " (domain: "--email-domain=${lib.escapeShellArg domain}") cfg.oidc.allowedEmailDomains}
      '';
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        LoadCredential = [
          "client-secret:${toString cfg.oidc.clientSecretFile}"
          "cookie-secret:${toString cfg.oidc.cookieSecretFile}"
        ];
        Restart = "on-failure";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      };
    };

    assertions = [
      { assertion = cfg.baseUrl != ""; message = "services.ideation-workbench.baseUrl must be configured."; }
      { assertion = !cfg.oidc.enable || (cfg.oidc.issuerUrl != "" && cfg.oidc.clientId != "" && cfg.oidc.clientSecretFile != null && cfg.oidc.cookieSecretFile != null); message = "OIDC requires issuerUrl, clientId, clientSecretFile, and cookieSecretFile."; }
    ];
  };
}
