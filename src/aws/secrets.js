// On AWS nothing secret is baked into the image, the EC2 user data or the Lambda configuration. Instead
// these env vars name secrets in Secrets Manager, and this fills in the real values:
//   DB_SECRET_ARN  -> DATABASE_URL  (the RDS-generated secret: username, password, host, port, dbname)
//   JWT_SECRET_ARN -> JWT_SECRET
// DB_CA_FILE points at the RDS CA bundle, so TLS to RDS is fully verified (sslmode=verify-full).
// Must run before anything requires src/config.js, which validates the environment when loaded.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

async function loadSecretsIntoEnv(env = process.env) {
  const client = new SecretsManagerClient({});
  const get = async (id) => (await client.send(new GetSecretValueCommand({ SecretId: id }))).SecretString;

  try {
    if (env.DB_SECRET_ARN) {
      const db = JSON.parse(await get(env.DB_SECRET_ARN));
      const dbname = db.dbname || env.DB_NAME || 'tickets';
      let url =
        `postgres://${encodeURIComponent(db.username)}:${encodeURIComponent(db.password)}` +
        `@${db.host}:${db.port}/${dbname}`;
      if (env.DB_CA_FILE) url += `?sslmode=verify-full&sslrootcert=${env.DB_CA_FILE}`;
      env.DATABASE_URL = url;
    }
    if (env.JWT_SECRET_ARN) {
      env.JWT_SECRET = await get(env.JWT_SECRET_ARN);
    }
  } finally {
    client.destroy();
  }
}

module.exports = { loadSecretsIntoEnv };
