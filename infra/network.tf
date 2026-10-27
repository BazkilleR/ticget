# No NAT gateway: subnets are isolated. Instances reach AWS services through VPC endpoints: S3 (gateway,
# free: Amazon Linux packages + the ECR image layers), SQS, Secrets Manager, CloudWatch Logs and ECR
# (interface, billed per AZ: in one AZ to halve that cost, or both AZs with var.high_availability so instances
# in either AZ can still boot and reach SQS when the other one fails).

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true # required by the interface endpoints' private DNS
  tags                 = { Name = local.name }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["sqs", "secretsmanager", "logs", "ecr.api", "ecr.dkr"])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.high_availability ? aws_subnet.private[*].id : [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.sg["endpoints"].id]
  private_dns_enabled = true
  tags                = { Name = "${local.name}-${each.key}" }
}

# EC2 Instance Connect Endpoint (no hourly charge): SSH to the private instances for debugging, and an
# SSH tunnel to RDS/Redis for migrations, seeding and load-test setup (npm run aws:tunnel). One per VPC; it
# reaches instances in either AZ, so high availability leaves it alone (only debugging needs it).
resource "aws_ec2_instance_connect_endpoint" "eic" {
  subnet_id          = aws_subnet.private[0].id
  security_group_ids = [aws_security_group.sg["eic"].id]
  preserve_client_ip = false
}
