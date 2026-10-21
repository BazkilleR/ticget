# Read by infra/scripts/*.sh through `terraform output -raw <name>`. Names kept from the CDK stack.

output "Region" {
  value = var.region
}

output "ApiUrl" {
  value = aws_apigatewayv2_stage.default.invoke_url
}

output "ApiAsgName" {
  value = aws_autoscaling_group.app["api"].name
}

output "WorkerAsgName" {
  value = aws_autoscaling_group.app["worker"].name
}

output "DbEndpoint" {
  value = aws_db_instance.db.address
}

output "DbSecretArn" {
  value = aws_secretsmanager_secret.db.arn
}

output "JwtSecretArn" {
  value = aws_secretsmanager_secret.jwt.arn
}

output "RedisEndpoint" {
  value = aws_elasticache_cluster.cache.cache_nodes[0].address
}

output "QueueUrl" {
  value = aws_sqs_queue.booking.url
}

output "DlqUrl" {
  value = aws_sqs_queue.dlq.url
}

output "ApiLogGroup" {
  value = aws_cloudwatch_log_group.app["api"].name
}

output "WorkerLogGroup" {
  value = aws_cloudwatch_log_group.app["worker"].name
}

output "ExpireFunctionName" {
  value = aws_lambda_function.expire.function_name
}
