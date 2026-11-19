# The page and the companion server in one image. Build from the repo root:
#   docker build -f server/Dockerfile -t jamstate .
# or use compose.yaml (docker compose up).

# 1. Build the static page (it imports ../genres, ../schema and ../sounds).
FROM node:22-bookworm AS web
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY genres genres
COPY schema schema
COPY sounds sounds
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY web web
# The speech model for voice cues (about 40 MB); the page plays without it.
RUN cd web && npm run fetch-models && npm run build

# 2. The server: Python standard library only.
FROM python:3.12-slim
WORKDIR /app
COPY server server
RUN pip install --no-cache-dir ./server && useradd --create-home jamstate \
    && mkdir -p /data/sessions && chown -R jamstate /data
COPY --from=web /src/web/dist web
USER jamstate
ENV JAMSTATE_HOST=0.0.0.0 \
    JAMSTATE_PORT=8765 \
    JAMSTATE_SESSIONS=/data/sessions
VOLUME /data
EXPOSE 8765
CMD ["jamstate-server", "--static", "/app/web"]
