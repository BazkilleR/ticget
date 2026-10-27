variable "region" {
  description = "AWS region of the backend. Defaults to Asia Pacific (Thailand)."
  type        = string
  default     = "ap-southeast-7"
}

# Everything survives the loss of one AZ (RDS Multi-AZ, endpoints in both AZs, an API instance per AZ) but is otherwise
# sized for the lowest cost and torn down with `npm run aws:destroy` after each test session.
#
#   Internet -> API Gateway (HTTP API, throttled) -> VPC Link -> internal ALB -> API ASG (EC2)
#   API -> SQS FIFO (+DLQ) -> worker ASG (EC2, scales on queue depth)
#   API/worker/Lambda -> RDS PostgreSQL, ElastiCache Redis
#   EventBridge Scheduler (15 min) -> Lambda (expire.js)
locals {
  name     = "ticget-backend"
  app_port = 3000
  db_name  = "tickets"
}
