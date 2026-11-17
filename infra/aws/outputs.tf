output "url" {
  description = "Where people open Lucidity."
  value       = local.public_url
}
output "mcp_url" {
  description = "The address to add as a connector in Claude or ChatGPT."
  value       = "${local.public_url}/mcp"
}
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "ecs_cluster" { value = aws_ecs_cluster.main.name }
output "ecs_service" { value = aws_ecs_service.app.name }
output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.deploy.arn
}
output "log_group" { value = aws_cloudwatch_log_group.app.name }
output "region" { value = var.region }
