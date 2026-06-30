-- ============================================================
-- Voice AI Companion — TiDB Schema (v2)
-- Run this in TiDB Cloud Console → SQL Editor
-- ============================================================

-- ── User profiles & preferences ──────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128),
  language VARCHAR(8) DEFAULT 'id-ID',
  preferred_tone VARCHAR(32) DEFAULT 'warm',  -- warm | casual | formal
  timezone VARCHAR(32) DEFAULT 'Asia/Jakarta',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id)
);

-- ── Voice sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_sessions (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128) NOT NULL UNIQUE,
  channel VARCHAR(128),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL,
  duration_secs INT DEFAULT 0,
  turn_count INT DEFAULT 0,
  metadata JSON,
  INDEX idx_user_id (user_id),
  INDEX idx_session_id (session_id),
  INDEX idx_started (started_at)
);

-- ── Conversation turns (full history per session) ────────────────
CREATE TABLE IF NOT EXISTS conversation_turns (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  turn_number INT NOT NULL,
  role VARCHAR(16) NOT NULL,        -- 'user' | 'assistant'
  user_text TEXT,
  assistant_text TEXT,
  stt_confidence FLOAT,
  tts_duration_ms INT,
  latency_ms INT,                   -- time from user speech end to first TTS byte
  context_used JSON,                -- memories injected for this turn
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_session (user_id, session_id),
  INDEX idx_created (created_at)
);

-- ── Memory (facts, preferences, context) ─────────────────────────
CREATE TABLE IF NOT EXISTS user_memory (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  memory_key VARCHAR(128),
  category VARCHAR(32) DEFAULT 'general',  -- general | preference | personal | contextual
  content TEXT NOT NULL,
  importance INT DEFAULT 3,                -- 1=ephemeral, 3=core, 5=critical
  source VARCHAR(32) DEFAULT 'conversation',
  channel VARCHAR(16) DEFAULT 'voice',
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FULLTEXT (content),
  INDEX idx_user_category (user_id, category),
  INDEX idx_user_id (user_id)
);

-- ── Session summaries (condensed history for long sessions) ───────
CREATE TABLE IF NOT EXISTS session_summaries (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  summary_text TEXT NOT NULL,
  key_topics JSON,               -- ["booking", "complaint", "product inquiry"]
  sentiment VARCHAR(16) DEFAULT 'neutral',  -- positive | neutral | negative
  follow_up_needed BOOLEAN DEFAULT FALSE,
  follow_up_note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_session_id (session_id)
);

-- ── Memory audit log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_logs (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,   -- upsert | delete | expire | update
  memory_key VARCHAR(128),
  old_value TEXT,
  new_value TEXT,
  source VARCHAR(32) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id)
);

-- ── Raw transcript log (full fidelity) ───────────────────────────
CREATE TABLE IF NOT EXISTS transcripts (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  role VARCHAR(8) NOT NULL,
  raw_text TEXT NOT NULL,
  segments JSON,               -- word-level timing from STT
  language VARCHAR(8),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_session (user_id, session_id)
);

-- ============================================================
-- Schema v2 migration note:
-- If upgrading from v1 (user_memory only), the new tables
-- are additive — existing data is safe.
-- Run only the new CREATE TABLE statements above if already on v1.
-- ============================================================
