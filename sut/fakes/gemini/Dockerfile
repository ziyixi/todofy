FROM golang:1.25.1-alpine3.22 AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /fake-gemini ./sut/fakes/gemini

FROM alpine:latest

RUN apk --no-cache add ca-certificates

COPY --from=builder /fake-gemini /fake-gemini

EXPOSE 8080

ENTRYPOINT ["/fake-gemini"]
