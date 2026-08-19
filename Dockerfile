# MC Panel — all-in-one image (Express API + Socket.IO + static frontend)
# Node 24 is required for the built-in `node:sqlite` module (no native sqlite build).
# Trixie variant: ships OpenJDK 21 (Bookworm only has 17, too old for MC 1.20.5+).
FROM node:24-trixie-slim

ENV NODE_ENV=production

# Java 21 runtime for real Minecraft servers (1.20.5+; older versions run fine too)
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first for better layer caching.
# bcrypt ships prebuilt binaries for linux-x64/glibc, no toolchain needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source
COPY index.js ./
COPY src ./src
COPY public ./public

# Runtime dirs (DB + downloaded modpacks) — overridden by volume mounts
RUN mkdir -p /app/data /app/servers /app/backups && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
