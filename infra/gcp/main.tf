# Armable on Google Cloud's always-free tier: one e2-micro server running the app, Postgres and Caddy,
# locked down so a bad night costs a few dollars at most. See README.md.

locals {
  services = [
    "compute.googleapis.com", "cloudbilling.googleapis.com", "billingbudgets.googleapis.com", "pubsub.googleapis.com",
    "cloudfunctions.googleapis.com", "run.googleapis.com", "cloudbuild.googleapis.com", "eventarc.googleapis.com",
    "artifactregistry.googleapis.com", "storage.googleapis.com", "iam.googleapis.com", "iap.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

data "google_project" "this" {}

# ---- The server ------------------------------------------------------------------------------------------------

# A fixed address, so the DNS record never has to change. Standard tier, which has a free monthly allowance.
resource "google_compute_address" "app" {
  name         = "${var.name}-ip"
  region       = var.region
  network_tier = "STANDARD"
  depends_on   = [google_project_service.enabled]
}

# Web traffic only from Cloudflare, so attacks land on Cloudflare (free, unmetered), never on this server.
resource "google_compute_firewall" "web" {
  name          = "${var.name}-web"
  network       = "default"
  direction     = "INGRESS"
  target_tags   = ["${var.name}-web"]
  source_ranges = var.cloudflare_only ? var.cloudflare_ipv4 : ["0.0.0.0/0"]
  description   = "Armable: HTTP and HTTPS${var.cloudflare_only ? ", from Cloudflare only" : ""}"
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  allow {
    protocol = "udp"
    ports    = ["443"]
  }
  depends_on = [google_project_service.enabled]
}

# SSH only through Google's own tunnel (IAP), which checks your Google sign-in before a single packet reaches the
# server. New projects come with rules that open SSH and remote desktop to the whole internet; these override them.
resource "google_compute_firewall" "ssh_via_google" {
  name          = "${var.name}-ssh-via-google"
  network       = "default"
  direction     = "INGRESS"
  priority      = 900
  source_ranges = ["35.235.240.0/20"] # Google's IAP tunnel
  description   = "Armable: SSH through Google's IAP tunnel only"
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  depends_on = [google_project_service.enabled]
}

resource "google_compute_firewall" "no_remote_login" {
  name          = "${var.name}-no-remote-login"
  network       = "default"
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["0.0.0.0/0"]
  description   = "Armable: no SSH or remote desktop from the internet (overrides the project's default rules)"
  deny {
    protocol = "tcp"
    ports    = ["22", "3389"]
  }
  depends_on = [google_project_service.enabled]
}

resource "google_compute_instance" "app" {
  name                      = var.name
  zone                      = var.zone
  machine_type              = "e2-micro"
  tags                      = ["${var.name}-web"]
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 30
      type  = "pd-standard"
    }
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip       = google_compute_address.app.address
      network_tier = "STANDARD"
    }
  }

  metadata = {
    domain                 = var.domain
    repo                   = var.repo
    channel                = var.channel
    egress_mbit            = tostring(var.egress_mbit)
    behind_proxy           = var.cloudflare_only ? "cloudflare" : ""
    startup-script         = file("${path.module}/vm-startup.sh")
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }

  # No service_account block: the server has no Google permissions at all, so even if it were broken into,
  # it could not create machines, read data or touch billing.

  shielded_instance_config {
    enable_secure_boot = true
  }

  depends_on = [google_project_service.enabled]
}

# ---- Backups off the server ------------------------------------------------------------------------------------

# A snapshot of the whole disk every week, kept for snapshot_weeks. The nightly database backups live on the
# disk itself; this copy survives the disk. Snapshots only store what changed, so this costs cents a month.
resource "google_compute_resource_policy" "weekly" {
  count  = var.snapshot_weeks > 0 ? 1 : 0
  name   = "${var.name}-weekly"
  region = var.region
  snapshot_schedule_policy {
    schedule {
      weekly_schedule {
        day_of_weeks {
          day        = "SUNDAY"
          start_time = "04:00"
        }
      }
    }
    retention_policy {
      max_retention_days    = 7 * var.snapshot_weeks
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_compute_disk_resource_policy_attachment" "weekly" {
  count = var.snapshot_weeks > 0 ? 1 : 0
  name  = google_compute_resource_policy.weekly[0].name
  disk  = basename(google_compute_instance.app.boot_disk[0].source)
  zone  = var.zone
}
