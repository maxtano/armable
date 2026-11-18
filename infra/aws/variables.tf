variable "region" {
  description = "AWS region for everything except the CloudFront certificate."
  type        = string
  default     = "us-east-1"
}
variable "environment" {
  description = "Name used in resource names and tags, e.g. prod or staging."
  type        = string
  default     = "prod"
}
variable "domain_name" {
  description = "Optional custom domain, e.g. app.lucidity.dev. Leave empty to use the CloudFront address."
  type        = string
  default     = ""
}
variable "route53_zone_id" {
  description = "Route 53 hosted zone for domain_name. Required when domain_name is set."
  type        = string
  default     = ""
}
variable "image_tag" {
  description = "Container image tag the service runs. The deploy workflow pushes both the commit SHA and latest."
  type        = string
  default     = "latest"
}
variable "task_cpu" {
  description = "Fargate CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 512
}
variable "task_memory" {
  description = "Fargate memory in MiB."
  type        = number
  default     = 1024
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}
variable "db_allocated_storage" {
  description = "Initial database storage in GiB. It grows automatically up to ten times this."
  type        = number
  default     = 20
}
variable "db_deletion_protection" {
  description = "Refuse to delete the database. Set false only when tearing everything down on purpose."
  type        = bool
  default     = true
}
variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to deploy."
  type        = string
  default     = "maxtano/lucidity"
}
variable "github_deploy_branch" {
  description = "Only this branch may deploy."
  type        = string
  default     = "main"
}
variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC identity provider. Set false if the account already has one."
  type        = bool
  default     = true
}
variable "log_retention_days" {
  type    = number
  default = 30
}

# Optional: sign in with Google, feedback alerts, and who may read all feedback.
variable "google_client_id" {
  description = "OAuth client ID for Sign in with Google. Leave empty to offer email and guest benches only."
  type        = string
  default     = ""
}
variable "google_client_secret" {
  description = "OAuth client secret for Sign in with Google. Stored in SSM as a SecureString."
  type        = string
  default     = ""
  sensitive   = true
}
variable "feedback_webhook_url" {
  description = "Where feedback is also posted, such as a Discord webhook. Stored in SSM as a SecureString."
  type        = string
  default     = ""
  sensitive   = true
}
variable "admin_emails" {
  description = "Comma-separated emails that may read all feedback at /api/admin/feedback."
  type        = string
  default     = ""
}
