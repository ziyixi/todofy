CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY,
 app TEXT NOT NULL,
 model TEXT NOT NULL,
 state TEXT NOT NULL,
 started_ms INTEGER NOT NULL,
 completed_ms INTEGER,
 body_key TEXT NOT NULL,
 content_expire_ms INTEGER NOT NULL,
 input_hash TEXT NOT NULL,
 generation_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_started ON requests(started_ms DESC,id DESC);
CREATE INDEX IF NOT EXISTS requests_app_started ON requests(app,started_ms DESC,id DESC);
CREATE INDEX IF NOT EXISTS requests_state_started ON requests(state,started_ms DESC,id DESC);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY,
 app TEXT NOT NULL,
 model TEXT NOT NULL,
 provider TEXT NOT NULL,
 state TEXT NOT NULL,
 config_key TEXT NOT NULL,
 history_key TEXT NOT NULL,
 expire_ms INTEGER NOT NULL,
 created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_expire ON conversations(expire_ms);
