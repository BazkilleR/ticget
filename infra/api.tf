# API tier: API Gateway -> VPC Link -> internal ALB -> ASG

resource "aws_lb" "api" {
  name               = "${local.name}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.sg["alb"].id]
  subnets            = aws_subnet.private[*].id
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.name}-api"
  port                 = local.app_port
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    path              = "/health"
    interval          = 15
    healthy_threshold = 2
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_autoscaling_policy" "api_cpu" {
  name                   = "cpu"
  autoscaling_group_name = aws_autoscaling_group.app["api"].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 60
  }
}

resource "aws_apigatewayv2_vpc_link" "api" {
  name               = local.name
  security_group_ids = [aws_security_group.sg["vpclink"].id]
  subnet_ids         = aws_subnet.private[*].id
}

resource "aws_apigatewayv2_api" "http" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "alb" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = aws_lb_listener.http.arn
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.api.id
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

# Rate limit at the edge, before anything reaches the ALB. Sized to let the 1,000-user load test through.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 1000
    throttling_burst_limit = 2000
  }
}
