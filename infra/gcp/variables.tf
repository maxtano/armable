variable "project_id" {
  description = "Your Google Cloud project ID."
  type        = string
}
variable "billing_account" {
  description = "The billing account the project uses, e.g. 012345-6789AB-CDEF01. deploy.sh fills it in."
  type        = string
}
variable "name" {
  description = "Prefix for everything this creates."
  type        = string
  default     = "armable"
}
variable "region" {
  description = "Free tier only in us-central1, us-east1 or us-west1."
  type        = string
  default     = "us-central1"
  validation {
    condition     = contains(["us-central1", "us-east1", "us-west1"], var.region)
    error_message = "Use us-central1, us-east1 or us-west1: the free server is only free there."
  }
}
variable "zone" {
  type    = string
  default = "us-central1-a"
}
variable "domain" {
  description = "Where people open the app."
  type        = string
  default     = "app.armable.ai"
}
variable "repo" {
  description = "The repository the server runs."
  type        = string
  default     = "https://github.com/maxtano/armable.git"
}
variable "cap_usd" {
  description = "Spending cap. At this amount the server stops; at twice it, billing is unlinked."
  type        = number
  default     = 5
}
variable "alert_usd" {
  description = "An email to the billing account's admins at this amount."
  type        = number
  default     = 1
}
variable "currency" {
  description = "The billing account's currency."
  type        = string
  default     = "USD"
}
variable "egress_mbit" {
  description = "Most the server may send, in megabits a second. 0 removes the limit."
  type        = number
  default     = 20
}
variable "cloudflare_only" {
  description = "Accept web traffic only from Cloudflare. Needs the DNS record proxied (orange cloud)."
  type        = bool
  default     = true
}
variable "cloudflare_ipv4" {
  description = "Cloudflare's published IPv4 ranges, from https://www.cloudflare.com/ips-v4."
  type        = list(string)
  default = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
}
