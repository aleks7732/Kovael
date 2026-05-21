# syntax=docker/dockerfile:1.7

# ---- builder ----
# Compiles TypeScript and prunes devDependencies. node:22-bookworm-slim
# is the smallest official Node 22 LTS image that still has the headers
# native modules need (none today, but cheap insurance against future
# better-sqlite3 / bcrypt-style adds).
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy lockfile first so the npm-ci layer is cached across source-only
# changes. Cache mount keeps the npm cache hot across builds without
# baking it into the image.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies from node_modules before it travels to the
# runtime stage. `npm prune` rewrites the same node_modules tree in
# place, so the COPY in the runtime stage picks up the pruned form.
RUN npm prune --omit=dev


# ---- runtime ----
# Distroless ships only the Node 22 binary, ICU data, ca-certificates,
# and the `nonroot` user. No shell, no apt, no busybox — anything we
# need at runtime has to come from the builder or be COPY'd explicitly.
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=builder --chown=nonroot:nonroot /app/dist ./dist
COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --chown=nonroot:nonroot personas ./personas
COPY --chown=nonroot:nonroot WORKFLOW.md ./

USER nonroot

EXPOSE 8080

# Distroless image's ENTRYPOINT is /nodejs/bin/node; CMD supplies the script.
CMD ["dist/boot-mesh.js"]

# HEALTHCHECK runs independently of ENTRYPOINT — invoke the node binary
# directly so the check doesn't depend on a shell that doesn't exist.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/api/v1/state').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
