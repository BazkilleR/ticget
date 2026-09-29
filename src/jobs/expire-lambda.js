// Lambda entry for the cleanup job, invoked by EventBridge Scheduler every 15 minutes.
// Secrets are loaded once per cold start; the DB pool and Redis connection are reused across invocations.
const { loadSecretsIntoEnv } = require('../aws/secrets');

let ready = null;

exports.handler = async () => {
  if (!ready) {
    ready = loadSecretsIntoEnv().catch((err) => {
      ready = null; // retry on the next invocation instead of caching the failure
      throw err;
    });
  }
  await ready;

  // Required only now: config.js validates the environment as soon as it is loaded.
  const { expireAll } = require('./expire');
  return expireAll();
};
