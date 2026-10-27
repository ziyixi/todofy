CREATE TABLE model_settings (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 email_model TEXT NOT NULL,
 report_model TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
