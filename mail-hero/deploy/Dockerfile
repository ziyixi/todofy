ARG NODE_IMAGE=node:24.20.0-alpine3.24
ARG GO_IMAGE=golang:1.27.1-alpine3.24
FROM ${NODE_IMAGE} AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM ${GO_IMAGE} AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
COPY --from=web-build /src/uiassets/dist ./uiassets/dist
RUN CGO_ENABLED=0 GOFLAGS=-mod=readonly go build -trimpath -ldflags='-s -w' -o /out/mail-hero ./cmd/mail-hero

FROM alpine:3.24 AS runtime
RUN apk add --no-cache ca-certificates && addgroup -S -g 10001 mailhero && adduser -S -D -H -u 10001 -G mailhero mailhero
COPY --from=go-build /out/mail-hero /usr/local/bin/mail-hero
USER 10001:10001
WORKDIR /app
EXPOSE 8080 2525
ENTRYPOINT ["/usr/local/bin/mail-hero"]
CMD ["serve"]
