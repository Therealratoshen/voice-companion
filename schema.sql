-- ============================================================
-- Voice AI Companion — TiDB Schema (FULLTEXT, no Mem9)
-- Run this in TiDB Cloud Console → SQL Editor
-- ============================================================

-- Main memory (FULLTEXT search, no vector index)
CREATE TABLE IF NOT EXISTS user_memory (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  memory_key VARCHAR(128),
  content TEXT NOT NULL,
  channel VARCHAR(16) DEFAULT 'both',
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FULLTEXT (content),
  INDEX idx_user_id (user_id)
);

-- Raw conversation log
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  role VARCHAR(8) NOT NULL,
  content TEXT NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_channel (user_id, channel),
  INDEX idx_created (created_at)
);

-- Memory audit log
CREATE TABLE IF NOT EXISTS memory_logs (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,
  memory_key VARCHAR(128),
  new_value TEXT,
  source VARCHAR(32) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
