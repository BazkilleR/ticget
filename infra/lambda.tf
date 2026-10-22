# Cleanup job: EventBridge Scheduler -> Lambda (src/jobs/expire-lambda.js).
# `npm run aws:build-lambda` bundles it with esbuild into .build/expire/ (CDK's NodejsFunction did this).

data "archive_file" "expire" {
  type        = "zip"
  source_dir  = "${path.module}/.build/expire"
  output_path = "${path.module}/.build/expire.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "expire" {
  name_prefix        = "${local.name}-expire-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "expire_vpc" {
  role       = aws_iam_role.expire.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "expire" {
  name = "secrets"
  role = aws_iam_role.expire.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.db.arn, aws_secretsmanager_secret.jwt.arn]
    }]
  })
}

resource "aws_cloudwatch_log_group" "expire" {
  name              = "/aws/lambda/${local.name}-expire"
  retention_in_days = 3
}

resource "aws_lambda_function" "expire" {
  function_name    = "${local.name}-expire"
  role             = aws_iam_role.expire.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.expire.output_path
  source_code_hash = data.archive_file.expire.output_base64sha256
  memory_size      = 256
  timeout          = 60

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.sg["lambda"].id]
  }

  # AWS_REGION is reserved: the Lambda runtime sets it and rejects it in the function configuration.
  environment {
    variables = merge(
      { for key, value in local.base_env : key => value if key != "AWS_REGION" },
      { DB_CA_FILE = "/var/task/rds-global-bundle.pem" },
    )
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.expire.name
  }

  depends_on = [
    aws_iam_role_policy_attachment.expire_vpc,
    aws_iam_role_policy.expire,
    aws_secretsmanager_secret_version.db,
    aws_secretsmanager_secret_version.jwt,
  ]
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name_prefix        = "${local.name}-scheduler-"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke-expire"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [aws_lambda_function.expire.arn, "${aws_lambda_function.expire.arn}:*"]
    }]
  })
}

resource "aws_scheduler_schedule" "expire" {
  name                = "${local.name}-expire"
  description         = "Release expired booking holds (src/jobs/expire.js)"
  schedule_expression = "rate(15 minutes)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.expire.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = "{}"
  }
}
