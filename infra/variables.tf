variable "region" {
  description = "AWS region of the backend. Defaults to Asia Pacific (Thailand)."
  type        = string
  default     = "ap-southeast-7"
}

variable "high_availability" {
  description = "Survive the loss of one AZ: RDS Multi-AZ, interface endpoints in both AZs, and at least one API and one worker instance per AZ. Off by default, as it roughly doubles the hourly cost."
  type        = bool
  default     = false
}

# Everything is sized for the lowest cost and torn down with `npm run aws:destroy` after each test session.
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
