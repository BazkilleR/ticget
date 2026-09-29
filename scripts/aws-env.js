// Prints the secret env vars as KEY=value lines for `docker run --env-file`. The EC2 user data runs this
// once at boot inside the app image, so the containers get DATABASE_URL and JWT_SECRET without the secrets
// ever appearing in the user data or the image.
const { loadSecretsIntoEnv } = require('../src/aws/secrets');

async function main() {
  const env = { ...process.env };
  await loadSecretsIntoEnv(env);
  for (const key of ['DATABASE_URL', 'JWT_SECRET']) {
    if (env[key]) process.stdout.write(`${key}=${env[key]}\n`);
  }
}

main().catch((err) => {
  console.error(`aws-env: ${err.message}`);
  process.exit(1);
});
