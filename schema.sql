-- ============================================================
-- Voice AI Companion — TiDB Schema
-- Run this in TiDB Cloud Console → AI Features → enable Mem9
-- ============================================================

-- Main memory with Mem9 vectors
CREATE TABLE IF NOT EXISTS user_memory (
  id BIGINT AUTO_RANDOM PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  memory_key VARCHAR(128),
  content TEXT NOT NULL,
  embedding MEM9(768),
  channel VARCHAR(16) DEFAULT 'both',
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FULLTEXT (content),
  VECTOR INDEX (embedding)
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
