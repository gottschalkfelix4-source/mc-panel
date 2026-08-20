# MC Panel — all-in-one image (Express API + Socket.IO + static frontend)
FROM eclipse-temurin:17-jre AS java17

# Node 24 is required for the built-in `node:sqlite` module (no native sqlite build).
# Trixie variant provides the Java versions required by supported Minecraft releases.
FROM node:24-trixie-slim

ENV NODE_ENV=production

# Stable symlinks keep the Java 17/21/25 launch paths architecture-neutral.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless openjdk-25-jre-headless \
    && arch="$(dpkg --print-architecture)" \
    && mkdir -p /opt/java \
    && ln -s "/usr/lib/jvm/java-21-openjdk-${arch}" /opt/java/21 \
    && ln -s "/usr/lib/jvm/java-25-openjdk-${arch}" /opt/java/25 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=java17 /opt/java/openjdk /opt/java/17

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
