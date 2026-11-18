# Armable on Google Cloud, free

One small server on Google Cloud's always-free tier runs the app, its database, and Caddy for HTTPS. The website stays on GitHub Pages. About 20 minutes, once.

| Address | What | Where |
| --- | --- | --- |
| `armable.ai` | The website | GitHub Pages |
| `app.armable.ai` | The app, and the address assistants connect to | This server |

## 1. Google Cloud

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project, for example `armable`. Note its **project ID**.
2. **Billing → Link a billing account.** Google asks for a card even for the free tier. Then **Billing → Budgets & alerts → Create budget**: $1, with email alerts, so you hear about any charge at once.
3. Open **Cloud Shell**: the `>_` button at the top right. In it, run:

   ```sh
   gcloud config set project YOUR_PROJECT_ID
   curl -fsSL https://raw.githubusercontent.com/maxtano/armable/main/infra/gcp/cloud-shell.sh | bash
   ```

   It creates a fixed address, opens the web ports, and starts the server. At the end it prints the server's **IP address**.

## 2. Cloudflare DNS

In Cloudflare, open **armable.ai → DNS → Records** and add the app:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `app` | the IP address from step 1 | DNS only (grey cloud) |

And the website, if you have not yet:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (one record each) | DNS only |
| AAAA | `@` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` (one record each) | DNS only |
| CNAME | `www` | `maxtano.github.io` | DNS only |

Keep them **DNS only**: the server gets its own certificate, and that needs to reach it directly.

## 3. GitHub

1. **Settings → Pages → Custom domain:** `armable.ai`, then **Enforce HTTPS** once the check passes.
2. **Settings → Secrets and variables → Actions → Variables → New variable:** `ARMABLE_URL` = `https://app.armable.ai`. This turns on the website's “Try the demo drone” buttons.
3. **Make the app image public.** After the first push to `main`, the **Build the app image** workflow publishes it. Open your profile → **Packages → armable → Package settings → Change visibility → Public**. Until then the server builds the image itself, which works but takes 15 minutes or more on the small machine.

## 4. Check it

- Open **https://app.armable.ai**. The first visit can take up to 15 minutes after step 1 while the server installs itself and gets its certificate.
- In Claude: **Settings → Connectors → Add custom connector**, address `https://app.armable.ai/mcp`. In ChatGPT: **Settings → Connectors → Create**, same address.
- Open the demo drone and ask: *“My new quad won’t arm. Why?”*

## Running it

Everything below runs from Cloud Shell.

| To | Run |
| --- | --- |
| Watch it start | `gcloud compute ssh armable --zone us-central1-a -- sudo tail -f /var/log/armable-startup.log` |
| See the app’s log | `gcloud compute ssh armable --zone us-central1-a -- sudo docker compose -f /opt/armable/infra/gcp/compose.yaml logs -f app` |
| Change settings (Google sign-in, feedback alerts, admins) | `gcloud compute ssh armable --zone us-central1-a -- sudo nano /opt/armable-data/.env`, then restart below |
| Restart | `gcloud compute ssh armable --zone us-central1-a -- sudo /opt/armable/infra/gcp/update.sh` |
| Restart the whole server | `gcloud compute instances reset armable --zone us-central1-a` |

**Updates are automatic.** Every push to `main` builds a new image, and the server picks it up within 10 minutes.

**Backups** run every night at 03:17, keeping the last 7, in `/opt/armable-data/backups`. To restore one:

```sh
gunzip -c /opt/armable-data/backups/armable-2026-01-01.sql.gz | sudo docker compose -f /opt/armable/infra/gcp/compose.yaml exec -T db psql -U armable armable
```

## Costs

Free for a small number of users, with three things to watch:

- **The server and disk** (one e2-micro, 30 GB standard disk) are free only in `us-central1`, `us-east1` or `us-west1`. The script uses `us-central1`.
- **Network.** The script uses Google’s Standard network tier, which includes a free monthly allowance. Armable sends little data: the drone talks to your browser, not the server.
- **The fixed IP address.** Google’s free-tier page says the address is free, but Google charges for many public IPv4 addresses since 2024. If your bill shows an “External IPv4” charge, it is a few dollars a month. The $1 budget alert tells you within a day.

When it outgrows this, the AWS setup in [`../aws`](../aws/README.md) runs the same app with room to grow.
