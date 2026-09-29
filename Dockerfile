# One image for every process:
#   API:     docker run <image>                          (default: node src/api.js)
#   worker:  docker run <image> node src/worker.js
#   migrate: docker run <image> node scripts/migrate.js
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so code changes do not reinstall node_modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY seeds ./seeds
# RDS CA bundle: TLS to RDS is verified (sslmode=verify-full), see src/aws/secrets.js.
COPY certs ./certs

USER node
EXPOSE 3000
CMD ["node", "src/api.js"]
