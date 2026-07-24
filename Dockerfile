# Build the whole console (web + server) and run it as a single container.
# Mount the host Docker socket at runtime so it can manage its siblings.
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install
COPY . .
# Build server and web in parallel — they're independent and
# the ARM64 runner has multiple cores.
RUN npm --workspace web run build & \
    npm --workspace server run build & \
    npm --workspace relay run build & \
    wait

FROM node:20-slim
# git is used by the Ask Dockyard assistant's GitHub tools (clone/commit/push
# into a scratch checkout under /app/data).
# Chromium deps are for the Playwright-powered gateway preview feature.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
# Install Chromium BEFORE the COPY-from-build layers.  Chromium only
# depends on the base image + apt deps above — it shouldn't re-download
# on every code change.  (Previously it ran after COPY dist, making the
# most expensive layer essentially uncacheable.)
RUN npx playwright install chromium --with-deps 2>&1 | tail -3
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/web/package.json web/
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
EXPOSE 4300
CMD ["node", "server/dist/index.js"]
