# Armable on Google Cloud, free and capped

Everything here is Terraform. One small server on Google Cloud's always-free tier runs the app, its database, and Caddy for HTTPS, behind Cloudflare. The website stays on GitHub Pages.

| Address | What | Where |
| --- | --- | --- |
| `armable.ai` | The website | GitHub Pages |
| `app.armable.ai` | The app, and the address assistants connect to | This server, behind Cloudflare |

## What it creates

| | |
| --- | --- |
| **Server** | One e2-micro (free tier), 30 GB standard disk, Debian 12, fixed address. It sets itself up on boot: swap, Docker, the app, Postgres, Caddy. Runs the newest release, checking every 10 minutes; backs up the database nightly. |
| **Locked down** | No Google service account, so even a broken-into server can’t create anything or touch billing. Web ports open to Cloudflare only. SSH through Google sign-in only. Outgoing traffic limited to 20 Mbit/s. |
| **Spending guard** | An email at **$1**. At the **$5 cap** a small function stops the server (its disk and data are kept). At **$10** it unlinks billing, so nothing more can be charged. |
| **State** | Terraform’s state in a private bucket in your project. Your project ID and billing account stay in `terraform.tfvars`, which is never committed. |

Google’s cost data can lag by hours, so the guard is a ceiling, not a brake. The speed limit keeps the worst case in between to well under a dollar an hour.

## Set it up

**1. Your Google account.** Turn on 2-Step Verification or a passkey at [myaccount.google.com/security](https://myaccount.google.com/security). Someone in your account is the one risk no setting here can cap.

**2. A project with billing.** At [console.cloud.google.com](https://console.cloud.google.com), create a project, for example `armable`, then **Billing → Link a billing account**.

**3. Run it.** Open **Cloud Shell** (the `>_` button at the top right) and paste:

```sh
gcloud config set project YOUR_PROJECT_ID
git clone https://github.com/maxtano/armable && cd armable/infra/gcp && ./deploy.sh
```

It shows what it will create; type `yes`. At the end it prints the server’s address and the next step. It takes about five minutes, mostly the spending guard’s first build.

**4. Cloudflare.** For `armable.ai`:

- **DNS → Records → Add record:** type `A`, name `app`, IPv4 the address from step 3, **Proxied** (orange cloud).
- **SSL/TLS → Overview:** **Full (strict)**.
- **SSL/TLS → Edge Certificates:** **Always Use HTTPS off.** The server redirects to HTTPS itself, and leaving this on blocks it from getting its first certificate.

And the website’s records, if you haven’t added them: four `A` records for `@` (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`), four `AAAA` records for `@` (`2606:50c0:8000::153` to `8003::153`), and a `CNAME` for `www` to `maxtano.github.io`, all **DNS only**.

**5. GitHub,** in the repository’s settings:

- **Pages → Custom domain:** `armable.ai`, then **Enforce HTTPS**.
- **Secrets and variables → Actions → Variables:** `ARMABLE_URL` = `https://app.armable.ai`. This switches on the website’s demo buttons.
- **The app image:** your profile → **Packages → armable → Package settings → Change visibility → Public**, so the server can pull it. Until then it builds the app itself, which is slow but works.

**6. Try it.** Within 15 minutes, **https://app.armable.ai** opens. In Claude: **Settings → Connectors → Add custom connector** → `https://app.armable.ai/mcp`. ChatGPT takes the same address. Open the demo drone and ask *“My new quad won’t arm. Why?”*

## Release it

The server runs the newest **release**, not whatever was last pushed to `main`. Pushing to `main` builds an `edge` image and changes nothing live. To ship:

```sh
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0
```

GitHub builds the image and writes the release notes; the server picks it up within 15 minutes. To roll back, tag the older commit as a newer version (`v0.2.1`). Tags such as `v0.3.0-rc.1` get an image but never go live on their own.

To have the server follow `main` instead, put `channel = "edge"` in `terraform.tfvars` and run `./deploy.sh` again.

## Change it

Edit `terraform.tfvars` in Cloud Shell, for example `cap_usd = 10`, and run `./deploy.sh` again. Every setting is in [`variables.tf`](variables.tf).

## Run it

From Cloud Shell:

| To | Run |
| --- | --- |
| Watch it start | `gcloud compute ssh armable --zone us-central1-a -- sudo tail -f /var/log/armable-startup.log` |
| See the app’s log | `gcloud compute ssh armable --zone us-central1-a -- sudo docker compose -f /opt/armable/infra/gcp/compose.yaml logs -f app` |
| Add Google sign-in, feedback alerts or admins | `gcloud compute ssh armable --zone us-central1-a -- sudo nano /opt/armable-data/.env`, then the next line |
| See which release is live | `gcloud compute ssh armable --zone us-central1-a -- git -C /opt/armable describe --tags` |
| Update now, or restart the app | `gcloud compute ssh armable --zone us-central1-a -- sudo /opt/armable/infra/gcp/update.sh` |
| Start it after the guard stopped it | `gcloud compute instances start armable --zone us-central1-a` |
| Restore billing after the guard unlinked it | **Billing → Account management** in the console, link the project again |

**Backups** run nightly, keeping seven, in `/opt/armable-data/backups`. To restore one:

```sh
gunzip -c /opt/armable-data/backups/armable-2026-01-01.sql.gz | sudo docker compose -f /opt/armable/infra/gcp/compose.yaml exec -T db psql -U armable armable
```

**If the certificate doesn’t arrive** within 30 minutes, check *Always Use HTTPS* is off in Cloudflare. As a fallback, set the `app` record to **DNS only**, put `cloudflare_only = false` in `terraform.tfvars`, and run `./deploy.sh` again.

## What it costs

Free for a small number of users:

- **Server and disk:** free in `us-central1`, `us-east1` and `us-west1`.
- **Network:** Standard tier, which has a free monthly allowance. Cloudflare serves the cached files, and the drone talks to the browser, not the server.
- **Guard:** Pub/Sub, a small function, its build and its storage all sit in Google’s free allowances.
- **The fixed IP address** may show as a few dollars a month under “External IPv4”. Google’s free-tier page says it is free, but Google charges for many public IPv4 addresses. The $1 email tells you within a day.

When it outgrows this, [`../aws`](../aws/README.md) runs the same app with room to grow.
