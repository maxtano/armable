# The spending guard: two budgets and a small function.
#
#   alert_usd       an email to the billing account's admins
#   cap_usd         the guard stops the server (its disk and data are kept)
#   2 x cap_usd     the guard unlinks billing, so nothing more can be charged
#
# Google's cost data can lag by hours, so the guard is a ceiling, not a brake. The server's own egress limit
# (egress_mbit) keeps the worst case small in between.

resource "google_pubsub_topic" "budget" {
  name       = "${var.name}-budget"
  depends_on = [google_project_service.enabled]
}

resource "google_billing_budget" "alert" {
  billing_account = var.billing_account
  display_name    = "${var.name}: first spending"
  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }
  amount {
    specified_amount {
      currency_code = var.currency
      units         = tostring(var.alert_usd)
    }
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  depends_on = [google_project_service.enabled]
}

resource "google_billing_budget" "cap" {
  billing_account = var.billing_account
  display_name    = "${var.name}: spending cap"
  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }
  amount {
    specified_amount {
      currency_code = var.currency
      units         = tostring(var.cap_usd)
    }
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 2.0
  }
  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.budget.id
    schema_version = "1.0"
  }
  depends_on = [google_project_service.enabled]
}

# The guard runs as its own account with only the permissions it needs.
resource "google_service_account" "guard" {
  account_id   = "${var.name}-guard"
  display_name = "Armable spending guard"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "guard" {
  for_each = toset([
    "roles/billing.projectManager",            # unlink billing from this project
    "roles/compute.instanceAdmin.v1",          # stop the server
    "roles/run.invoker",                       # let the budget topic call the function
    "roles/eventarc.eventReceiver",            # receive the budget events
    "roles/serviceusage.serviceUsageConsumer", # use the project's APIs; Eventarc checks this when it creates the trigger
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.guard.email}"
}

# Cloud Build builds the function with the project's default compute account.
data "google_compute_default_service_account" "default" {
  depends_on = [google_project_service.enabled]
}

resource "google_project_iam_member" "build" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_storage_bucket" "functions" {
  name                        = "${var.project_id}-${var.name}-functions"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  force_destroy               = true
  depends_on                  = [google_project_service.enabled]
}

data "archive_file" "guard" {
  type        = "zip"
  source_dir  = "${path.module}/guard"
  output_path = "${path.module}/.build/guard.zip"
  excludes    = ["test_main.py", "__pycache__"]
}

resource "google_storage_bucket_object" "guard" {
  name   = "guard-${data.archive_file.guard.output_md5}.zip"
  bucket = google_storage_bucket.functions.name
  source = data.archive_file.guard.output_path
}

resource "google_cloudfunctions2_function" "guard" {
  name     = "${var.name}-guard"
  location = var.region

  build_config {
    runtime     = "python312"
    entry_point = "guard"
    source {
      storage_source {
        bucket = google_storage_bucket.functions.name
        object = google_storage_bucket_object.guard.name
      }
    }
  }

  service_config {
    max_instance_count    = 1
    available_memory      = "256M"
    timeout_seconds       = 120
    ingress_settings      = "ALLOW_INTERNAL_ONLY"
    service_account_email = google_service_account.guard.email
    environment_variables = {
      PROJECT_ID = var.project_id
      ZONE       = var.zone
      INSTANCE   = google_compute_instance.app.name
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.budget.id
    retry_policy          = "RETRY_POLICY_DO_NOT_RETRY"
    service_account_email = google_service_account.guard.email
  }

  depends_on = [google_project_iam_member.guard, google_project_iam_member.build]
}
