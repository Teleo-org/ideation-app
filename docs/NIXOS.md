# NixOS deployment

The NixOS target runs the same built web client as Cloudflare, with SQLite for
structured data and a private filesystem directory for attachments.

```nix
{
  inputs.ideation-workbench.url = "github:Teleo-org/ideation-app";
  imports = [ inputs.ideation-workbench.nixosModules.default ];

  services.ideation-workbench = {
    enable = true;
    baseUrl = "https://ideas.example.net";
    oidc = {
      enable = true;
      issuerUrl = "https://auth.example.net/application/o/ideation/";
      clientId = "ideation-workbench";
      clientSecretFile = "/run/keys/ideation-oidc-client-secret";
      cookieSecretFile = "/run/keys/ideation-cookie-secret";
    };
  };
}
```

Point the public reverse proxy at `127.0.0.1:4317`. The application itself
listens on the private `internalPort` when the bundled OIDC proxy is enabled.

For an existing authentication proxy, leave `oidc.enable = false`, forward to
the configured application port, and set the configured identity header. Only
addresses listed in `trustedProxyAddresses` may supply that header. Never expose
the private application port directly.

Persistent data lives in `/var/lib/ideation-workbench` by default. The
maintenance command checkpoints SQLite and backs up the database and
attachments together:

```sh
sudo -u ideation-workbench \
  IW_DATA_DIR=/var/lib/ideation-workbench \
  ideation-workbench-maintenance backup /var/backups/ideation-workbench/2026-07-28
```

Stop the service before restoring, then start it and verify `/readyz`:

```sh
sudo systemctl stop ideation-workbench
sudo -u ideation-workbench \
  IW_DATA_DIR=/var/lib/ideation-workbench \
  ideation-workbench-maintenance restore /var/backups/ideation-workbench/2026-07-28
sudo systemctl start ideation-workbench
```
