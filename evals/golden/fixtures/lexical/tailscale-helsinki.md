# Tailscale exit nodes — Helsinki box

The Helsinki NUC runs `tailscale up --advertise-exit-node --advertise-routes=10.10.0.0/24`. Approved the routes from the admin console. Set DNS to use MagicDNS so the in-vault names still resolve.

ExitNode flag on the laptop: `tailscale up --exit-node=helsinki-nuc`.
