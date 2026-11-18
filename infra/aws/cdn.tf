# CloudFront gives the app an HTTPS address with no domain needed (https://xxxx.cloudfront.net), carries
# WebSockets, and caches only the built assets. With domain_name set, it serves that domain instead and talks
# to the load balancer over HTTPS too.

locals {
  custom_domain = var.domain_name != ""
  origin_host   = local.custom_domain ? "origin.${var.domain_name}" : aws_lb.main.dns_name
  public_url    = local.custom_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
}

data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_origin_request_policy" "all_viewer" { name = "Managed-AllViewer" }

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = local.name
  price_class     = "PriceClass_100"
  aliases         = local.custom_domain ? [var.domain_name] : []
  http_version    = "http2and3"

  origin {
    origin_id   = "app"
    domain_name = local.origin_host
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = local.custom_domain ? "https-only" : "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
    custom_header {
      name  = "X-Armable-Origin"
      value = random_password.origin_secret.result
    }
  }

  # Everything is dynamic by default: cookies, headers and query strings go through untouched.
  default_cache_behavior {
    target_origin_id         = "app"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }
  # Built files carry a content hash in their names, so they can be cached hard.
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "app"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? aws_acm_certificate_validation.viewer[0].certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : null
  }
}

# ---- Optional custom domain ---------------------------------------------------------------------------------

resource "aws_acm_certificate" "viewer" {
  count             = local.custom_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_acm_certificate" "origin" {
  count             = local.custom_domain ? 1 : 0
  domain_name       = "origin.${var.domain_name}"
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
locals {
  validation_records = local.custom_domain ? merge(
    { for o in aws_acm_certificate.viewer[0].domain_validation_options : o.domain_name => o },
    { for o in aws_acm_certificate.origin[0].domain_validation_options : o.domain_name => o },
  ) : {}
}
resource "aws_route53_record" "validation" {
  for_each        = local.validation_records
  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}
resource "aws_acm_certificate_validation" "viewer" {
  count                   = local.custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.viewer[0].arn
  validation_record_fqdns = [aws_route53_record.validation[var.domain_name].fqdn]
}
resource "aws_acm_certificate_validation" "origin" {
  count                   = local.custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.origin[0].arn
  validation_record_fqdns = [aws_route53_record.validation["origin.${var.domain_name}"].fqdn]
}
resource "aws_route53_record" "app" {
  for_each = local.custom_domain ? toset(["A", "AAAA"]) : toset([])
  zone_id  = var.route53_zone_id
  name     = var.domain_name
  type     = each.value
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
resource "aws_route53_record" "origin" {
  count   = local.custom_domain ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "origin.${var.domain_name}"
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
