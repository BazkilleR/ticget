# CDK opened these ports implicitly (connections.allow*, ALB -> targets). Here every rule is spelled out.

locals {
  security_groups = {
    api       = "API instances"
    worker    = "Worker instances"
    lambda    = "Cleanup Lambda"
    eic       = "EC2 Instance Connect Endpoint"
    db        = "RDS PostgreSQL"
    cache     = "ElastiCache Redis"
    alb       = "Internal ALB"
    vpclink   = "API Gateway VPC Link"
    endpoints = "Interface VPC endpoints"
  }

  # "<target>-from-<source>" = port
  ingress_rules = {
    api-from-eic      = { to = "api", from = "eic", port = 22 }
    worker-from-eic   = { to = "worker", from = "eic", port = 22 }
    db-from-api       = { to = "db", from = "api", port = 5432 }
    db-from-worker    = { to = "db", from = "worker", port = 5432 }
    db-from-lambda    = { to = "db", from = "lambda", port = 5432 }
    cache-from-api    = { to = "cache", from = "api", port = 6379 }
    cache-from-worker = { to = "cache", from = "worker", port = 6379 }
    cache-from-lambda = { to = "cache", from = "lambda", port = 6379 }
    alb-from-vpclink  = { to = "alb", from = "vpclink", port = 80 }
    api-from-alb      = { to = "api", from = "alb", port = local.app_port }
  }
}

resource "aws_security_group" "sg" {
  for_each    = local.security_groups
  name        = "${local.name}-${each.key}"
  description = each.value
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-${each.key}" }
}

# Terraform drops the default allow-all egress rule, so add it back (CDK's default allowAllOutbound).
resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = aws_security_group.sg
  security_group_id = each.value.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "rule" {
  for_each                     = local.ingress_rules
  security_group_id            = aws_security_group.sg[each.value.to].id
  referenced_security_group_id = aws_security_group.sg[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = each.key
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.sg["endpoints"].id
  cidr_ipv4         = aws_vpc.main.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from the VPC"
}
