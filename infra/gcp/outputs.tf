output "ip" {
  description = "The server's fixed address."
  value       = google_compute_address.app.address
}
output "url" {
  value = "https://${var.domain}"
}
output "next" {
  description = "What to do once this has run."
  value       = <<-EOT

    In Cloudflare, open your domain, then DNS, Records, Add record:

        Type  A    Name  ${split(".", var.domain)[0]}    IPv4  ${google_compute_address.app.address}    Proxy  ${var.cloudflare_only ? "Proxied (orange cloud)" : "DNS only (grey cloud)"}

    ${var.cloudflare_only ? "Then SSL/TLS, Overview: Full (strict). And SSL/TLS, Edge Certificates: Always Use HTTPS off (the server redirects itself).\n" : ""}
    The server sets itself up in the next 5 to 15 minutes, then opens at https://${var.domain}
    Watch it:  gcloud compute ssh ${var.name} --zone ${var.zone} -- sudo tail -f /var/log/armable-startup.log
  EOT
}
