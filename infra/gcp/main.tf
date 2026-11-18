# Armable on Google Cloud's always-free tier: one e2-micro server running the app, Postgres and Caddy,
# locked down so a bad night costs a few dollars at most. See README.md.

locals {
  services = [
    "compute.googleapis.com", "cloudbilling.googleapis.com", "billingbudgets.googleapis.com", "pubsub.googleapis.com",
    "cloudfunctions.googleapis.com", "run.googleapis.com", "cloudbuild.googleapis.com", "eventarc.googleapis.com",
    "artifactregistry.googleapis.com", "storage.googleapis.com", "iam.googleapis.com",
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
