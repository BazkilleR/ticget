variable "region" {
  description = "AWS region of the backend. Defaults to Asia Pacific (Thailand)."
  type        = string
  default     = "ap-southeast-7"
}

# Everything is sized for the lowest cost and torn down with `npm run aws:destroy` after each test session.
#
#   Internet -> API Gateway (HTTP API, throttled) -> VPC Link -> internal ALB -> API ASG (EC2)
#   API -> SQS FIFO (+DLQ) -> worker ASG (EC2, scales on queue depth)
#   API/worker/Lambda -> RDS PostgreSQL, ElastiCache Redis
#   EventBridge Scheduler (15 min) -> Lambda (expire.js)
locals {
  name      = "ticket-backend"
  app_port  = 3000
  db_name   = "tickets"
  image_tag = "ticket-backend:aws"
}
