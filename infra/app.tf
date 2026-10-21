# The two EC2 tiers (API and worker): same image, same boot script, different command and permissions.

locals {
  # Non-secret config only. The containers resolve the two ARNs to DATABASE_URL / JWT_SECRET at boot.
  base_env = {
    NODE_ENV              = "production"
    LOG_LEVEL             = "info"
    AWS_REGION            = var.region
    REDIS_URL             = "redis://${aws_elasticache_cluster.cache.cache_nodes[0].address}:${aws_elasticache_cluster.cache.cache_nodes[0].port}"
    SQS_BOOKING_QUEUE_URL = aws_sqs_queue.booking.url
    DB_SECRET_ARN         = aws_secretsmanager_secret.db.arn
    JWT_SECRET_ARN        = aws_secretsmanager_secret.jwt.arn
    DB_NAME               = local.db_name
  }

  tiers = {
    api = {
      command        = "node src/api.js"
      run_migrations = true
      sqs_actions    = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    }
    worker = {
      command        = "node src/worker.js"
      run_migrations = false
      sqs_actions = [
        "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes", "sqs:GetQueueUrl",
      ]
    }
  }
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.tiers
  name              = "/${local.name}/${each.key}"
  retention_in_days = 3
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  for_each           = local.tiers
  name_prefix        = "${local.name}-${each.key}-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

data "aws_iam_policy_document" "app" {
  for_each = local.tiers

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action has no resource-level permissions
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [local.ecr_repository_arn]
  }
  statement {
    sid       = "Secrets"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.db.arn, aws_secretsmanager_secret.jwt.arn]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app[each.key].arn}:*"]
  }
  statement {
    sid       = "Queue"
    actions   = each.value.sqs_actions
    resources = [aws_sqs_queue.booking.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  for_each = local.tiers
  name     = "app"
  role     = aws_iam_role.app[each.key].id
  policy   = data.aws_iam_policy_document.app[each.key].json
}

resource "aws_iam_instance_profile" "app" {
  for_each    = local.tiers
  name_prefix = "${local.name}-${each.key}-"
  role        = aws_iam_role.app[each.key].name
}

resource "aws_launch_template" "app" {
  for_each               = local.tiers
  name_prefix            = "${local.name}-${each.key}-"
  image_id               = data.aws_ssm_parameter.al2023.insecure_value
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.sg[each.key].id]
  update_default_version = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.app[each.key].arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    image          = var.image_uri
    registry       = split("/", var.image_uri)[0]
    region         = var.region
    env            = merge(local.base_env, { DB_CA_FILE = "/app/certs/rds-global-bundle.pem" })
    log_group      = aws_cloudwatch_log_group.app[each.key].name
    command        = each.value.command
    run_migrations = each.value.run_migrations
  }))

  # default_tags do not reach instances launched by the ASG.
  dynamic "tag_specifications" {
    for_each = ["instance", "volume"]
    content {
      resource_type = tag_specifications.value
      tags          = { Name = "${local.name}-${each.key}", project = local.name }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[0-9]+\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/.+@sha256:[0-9a-f]{64}$", var.image_uri))
      error_message = "image_uri is not set to an ECR image digest. Run \"npm run aws:build-image\" first (it writes infra/image.auto.tfvars)."
    }
  }
}

resource "aws_autoscaling_group" "app" {
  for_each            = local.tiers
  name_prefix         = "${local.name}-${each.key}-"
  vpc_zone_identifier = aws_subnet.private[*].id
  min_size            = 1
  max_size            = 2

  # Boot (install Docker, pull the image, migrate) takes a few minutes before /health can pass.
  target_group_arns         = each.key == "api" ? [aws_lb_target_group.api.arn] : []
  health_check_type         = each.key == "api" ? "ELB" : "EC2"
  health_check_grace_period = each.key == "api" ? 600 : 300

  launch_template {
    id      = aws_launch_template.app[each.key].id
    version = aws_launch_template.app[each.key].latest_version
  }

  # A new launch template version (e.g. a new app image) replaces instances one at a time,
  # starting the new one before stopping the old one.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 100
      max_healthy_percentage = 200
    }
  }

  # The boot script needs the secrets filled in and the VPC endpoints up, or it fails before the app starts.
  depends_on = [
    aws_secretsmanager_secret_version.db,
    aws_secretsmanager_secret_version.jwt,
    aws_vpc_endpoint.interface,
    aws_vpc_endpoint.s3,
    aws_route_table_association.private,
    aws_iam_role_policy.app,
  ]
}
