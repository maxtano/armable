terraform {
  required_version = ">= 1.6"
  required_providers {
    google  = { source = "hashicorp/google", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
  # State lives in a private bucket in your own project. Its name is passed at init time, so it is not in the
  # repository:  terraform init -backend-config="bucket=YOUR_PROJECT_ID-tfstate"   (deploy.sh does this)
  backend "gcs" {
    prefix = "armable"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
  # The budget API needs a project to bill quota to when you sign in as yourself.
  user_project_override = true
  billing_project       = var.project_id
}
