# src/aws/secrets.js builds DATABASE_URL from a JSON secret with username, password, host, port and dbname,
# the format CDK's generated RDS secret had. RDS-managed master passwords (manage_master_user_password) only
# store username and password, so the secret is written here instead.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "db" {
  name_prefix             = "${local.name}-db-"
  description             = "RDS credentials for the ticket backend"
  recovery_window_in_days = 0 # delete right away on destroy
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    engine   = "postgres"
    username = aws_db_instance.db.username
    password = random_password.db.result
    host     = aws_db_instance.db.address
    port     = aws_db_instance.db.port
    dbname   = local.db_name
  })
}

resource "aws_secretsmanager_secret" "jwt" {
  name_prefix             = "${local.name}-jwt-"
  description             = "JWT signing secret for the ticket backend"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}
