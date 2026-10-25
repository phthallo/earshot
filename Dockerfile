# One image: the Go bridge serving the HTTP API, the relay TCP port and the
# built web client. Build from the repo root.
#
#   docker build -t earshot .
#   docker run -p 8080:8080 -p 9000:9000 --env-file .env -v earshot-data:/app/data earshot

# SpacetimeDB the browser connects to; baked into the client bundle.
ARG VITE_STDB_URI=wss://maincloud.spacetimedb.com
ARG VITE_STDB_DB=calhacks-24tt5

FROM node:22-alpine AS client
RUN corepack enable
WORKDIR /src
# The client imports zone and node geometry from ../data at build time.
COPY data/zones.json data/nodes.json data/landmarks.json data/
COPY client/package.json client/pnpm-lock.yaml client/pnpm-workspace.yaml client/
RUN cd client && pnpm install --frozen-lockfile
COPY client client
ARG VITE_STDB_URI
ARG VITE_STDB_DB
ENV VITE_STDB_URI=$VITE_STDB_URI VITE_STDB_DB=$VITE_STDB_DB
RUN cd client && pnpm build

FROM golang:1.25-alpine AS bridge
# gopacket's afpacket (the --node sniffer) needs cgo.
RUN apk add --no-cache build-base linux-headers
WORKDIR /src/bridge
COPY bridge/go.mod bridge/go.sum ./
RUN go mod download
COPY bridge .
RUN CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /out/bridge ./cmd/bridge

FROM alpine:3.21
RUN apk add --no-cache ca-certificates curl tzdata
WORKDIR /app
COPY --from=bridge /out/bridge /app/bridge
COPY --from=client /src/client/dist /app/public
# Seed copy of data/; the entrypoint fills /app/data (a volume) from it.
COPY data /app/data-seed
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
ENV HOME=/app/data/cache
EXPOSE 8080 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
# Extra bridge flags come from BRIDGE_ARGS (default: simulated crowd on).
CMD []
