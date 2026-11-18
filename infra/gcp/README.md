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
| **Locked down** | No Google service account, so even a broken-into server can’t create anything or touch billing. Web ports open to Cloudflare only. SSH only through Google’s IAP tunnel, after Google sign-in; the project’s default “SSH and remote desktop from anywhere” rules are overridden. Outgoing traffic limited to 10 Mbit/s. Security updates install nightly. |
| **Spending guard** | Emails at **$0.50**, **$1** and **$2.50**. At the **$5 cap** a small function stops the server (its disk and data are kept). At **$10** it unlinks billing, so nothing more can be charged. A separate email when your **whole billing account**, any project, reaches **$2**. |
| **Backups** | The database nightly, on the server, seven kept. The whole disk weekly as a snapshot, four kept, which survives the server. |
| **State** | Terraform’s state in a private bucket in your project. Your project ID and billing account stay in `terraform.tfvars`, which is never committed. |

Google’s cost data can lag by hours, so the guard is a ceiling, not a brake. The only thing outsiders can make cost money is outgoing traffic, and the speed limit caps that at about 4.5 GB an hour: the first 200 GB a month are free, and after that it is under 40 cents an hour until the guard catches up.

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

## Watch it

| To see | Where |
| --- | --- |
| What it costs, line by line | Console → **Billing → Reports**, this month, **Group by → SKU**. Save the view. |
| Sudden jumps | **Billing → Anomalies**, with email notifications on |
| The budgets | **Billing → Budgets & alerts**: two `armable` budgets and one for the whole account |
| Everything in the project | `gcloud asset search-all-resources --scope=projects/YOUR_PROJECT_ID --format="table(assetType.basename(),displayName,location)"` |
| On your phone | The **Google Cloud** app: spending, and a button to stop the server |

**Test the guard** once, so you know it works: send it a pretend “$5.50 of $5 spent”. The server stops within a minute; then start it again.

```sh
gcloud pubsub topics publish armable-budget --message='{"costAmount": 5.5, "budgetAmount": 5, "currencyCode": "USD"}'
gcloud compute instances start armable --zone us-central1-a
```

Never send $10 or more: that unlinks billing for real.

**Also worth doing,** outside Terraform: 2-Step Verification on your Google and Cloudflare accounts; **IAM & Admin → Quotas**, *CPUs (all regions)* set to `2`, so nobody can start a fleet of machines; and in Cloudflare, **Security → WAF → Rate limiting rules**, paths starting `/api/`, 100 requests per 10 seconds per IP, block. Leave Bot Fight Mode off: it blocks assistants’ connectors.

## Limits in the app

Armable keeps itself healthy when anyone can use it: sign-in and sign-up are limited per address; new guests, sign-ups and feedback are capped across everyone each hour; each guest bench keeps up to 20 MB and each saved account 200 MB; and below 2 GB of free disk it stops saving anything new, with a plain message, while everything else keeps working. The numbers are in [`limits.ts`](../../drone-studio/server/limits.ts).

## Change it

Edit `terraform.tfvars` in Cloud Shell, for example `cap_usd = 10`, and run `./deploy.sh` again. Every setting is in [`variables.tf`](variables.tf).

## Run it

From Cloud Shell:

| To | Run |
| --- | --- |
| Watch it start | `gcloud compute ssh armable --zone us-central1-a --tunnel-through-iap -- sudo tail -f /var/log/armable-startup.log` |
| See the app’s log | `gcloud compute ssh armable --zone us-central1-a --tunnel-through-iap -- sudo docker compose -f /opt/armable/infra/gcp/compose.yaml logs -f app` |
| Add Google sign-in, feedback alerts or admins | `gcloud compute ssh armable --zone us-central1-a --tunnel-through-iap -- sudo nano /opt/armable-data/.env`, then the next line |
| See which release is live | `gcloud compute ssh armable --zone us-central1-a --tunnel-through-iap -- git -C /opt/armable describe --tags` |
| Update now, or restart the app | `gcloud compute ssh armable --zone us-central1-a --tunnel-through-iap -- sudo /opt/armable/infra/gcp/update.sh` |
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
- **Disk snapshots:** a few cents a month; they only store what changed. Set `snapshot_weeks = 0` to turn them off.
- **Network:** Standard tier, which has a free monthly allowance. Cloudflare serves the cached files, and the drone talks to the browser, not the server.
- **Guard:** Pub/Sub, a small function, its build and its storage all sit in Google’s free allowances.
- **The fixed IP address** may show as a few dollars a month under “External IPv4”. Google’s free-tier page says it is free, but Google charges for many public IPv4 addresses. The $1 email tells you within a day.

When it outgrows this, [`../aws`](../aws/README.md) runs the same app with room to grow.
