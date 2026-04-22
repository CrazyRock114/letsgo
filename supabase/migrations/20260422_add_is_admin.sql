-- Add is_admin column to letsgo_users table
-- Run this in Supabase SQL Editor

ALTER TABLE letsgo_users
ADD COLUMN IF NOT EXISTS is_admin INTEGER DEFAULT 0 NOT NULL;

-- Set existing admin user (optional: replace 'your_admin_nickname' with actual admin nickname)
-- UPDATE letsgo_users SET is_admin = 1 WHERE nickname = 'your_admin_nickname';
