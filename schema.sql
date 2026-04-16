DROP TABLE IF EXISTS drafts;
CREATE TABLE IF NOT EXISTS drafts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL UNIQUE,
    publisher   TEXT,
    raw_title   TEXT,
    raw_content TEXT,
    ai_title    TEXT,
    ai_summary  TEXT,
    image_paths TEXT,          -- JSON string array
    selected_image TEXT,
    status      TEXT DEFAULT 'ready', -- 'ready' | 'published'
    created_at  TIMESTAMP DEFAULT (datetime('now', 'localtime'))
);
