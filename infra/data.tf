# RDS PostgreSQL, ElastiCache Redis and the SQS FIFO queue + DLQ.

resource "aws_db_subnet_group" "db" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "db" {
  identifier_prefix        = "${local.name}-"
  engine                   = "postgres"
  engine_version           = "16"
  instance_class           = "db.t4g.micro"
  allocated_storage        = 20
  storage_type             = "gp3"
  storage_encrypted        = true
  db_name                  = local.db_name
  username                 = "app"
  password                 = random_password.db.result
  db_subnet_group_name     = aws_db_subnet_group.db.name
  vpc_security_group_ids   = [aws_security_group.sg["db"].id]
  multi_az                 = true # synchronous standby in the other AZ, automatic failover
  publicly_accessible      = false
  backup_retention_period  = 1
  delete_automated_backups = true
  deletion_protection      = false
  skip_final_snapshot      = true
  apply_immediately        = true
}

resource "aws_elasticache_subnet_group" "cache" {
  name        = local.name
  description = "Ticget backend cache subnets"
  subnet_ids  = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "cache" {
  cluster_id         = local.name
  engine             = "redis"
  engine_version     = "7.1"
  node_type          = "cache.t4g.micro"
  num_cache_nodes    = 1
  port               = 6379
  subnet_group_name  = aws_elasticache_subnet_group.cache.name
  security_group_ids = [aws_security_group.sg["cache"].id]
  apply_immediately  = true
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-booking-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 14 * 24 * 3600
}

resource "aws_sqs_queue" "booking" {
  name                        = "${local.name}-booking-queue.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  visibility_timeout_seconds  = 30
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}
