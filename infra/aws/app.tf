# The app: one container image in ECR, run on ECS Fargate behind an Application Load Balancer.
#
# Exactly one task runs. Lucidity keeps live state in memory (which browser tab holds the drone, calls waiting
# on that tab), so a second task would split assistants from the tab they need. Deploys therefore stop the old
# task before starting the new one, with a short gap.

resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({ rules = [{
    rulePriority = 1, description = "Keep the last 20 images"
    selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
    action       = { type = "expire" }
  }] })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
# Used by ECS itself to pull the image, write logs and read the database secret.
resource "aws_iam_role" "execution" {
  name_prefix        = "${local.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["ssm:GetParameters"], Resource = [aws_ssm_parameter.database_url.arn]
  }] })
}
# Used by the app while it runs. It needs no AWS permissions.
resource "aws_iam_role" "task" {
  name_prefix        = "${local.name}-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name         = "app"
    image        = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 8787, protocol = "tcp" }]
    environment = [
      { name = "PUBLIC_URL", value = local.public_url },
      { name = "PORT", value = "8787" },
      { name = "STATIC_DIR", value = "dist" },
      { name = "TRUST_PROXY", value = "2" },
      { name = "DATABASE_CA_FILE", value = "/app/rds-global-bundle.pem" },
    ]
    secrets = [{ name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "app"
      }
    }
    readonlyRootFilesystem = false
  }])
}

resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 120
  drop_invalid_header_fields = true
}
resource "aws_lb_target_group" "app" {
  name                 = local.name
  port                 = 8787
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 10
  health_check {
    path                = "/api/me"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# CloudFront adds this header; requests without it are refused, so the load balancer cannot be used directly.
resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

resource "aws_lb_listener" "app" {
  load_balancer_arn = aws_lb.main.arn
  port              = local.custom_domain ? 443 : 80
  protocol          = local.custom_domain ? "HTTPS" : "HTTP"
  ssl_policy        = local.custom_domain ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null
  certificate_arn   = local.custom_domain ? aws_acm_certificate_validation.origin[0].certificate_arn : null
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}
resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.app.arn
  priority     = 1
  condition {
    http_header {
      http_header_name = "X-Lucidity-Origin"
      values           = [random_password.origin_secret.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_service" "app" {
  name                               = local.name
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 30
  enable_execute_command             = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 8787
  }
  depends_on = [aws_lb_listener_rule.from_cloudfront]
}
