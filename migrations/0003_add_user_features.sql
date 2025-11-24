-- הוספת תכונות ניהול משתמשים משודרגות
-- תאריך: 2025-11-22

-- הוספת שדה סימון מועדף
ALTER TABLE users ADD COLUMN is_favorite BOOLEAN DEFAULT 0;

-- הוספת שדה מחיקה רכה (soft delete)
ALTER TABLE users ADD COLUMN is_deleted BOOLEAN DEFAULT 0;

-- יצירת אינדקס לחיפוש מהיר של משתמשים פעילים
CREATE INDEX IF NOT EXISTS idx_users_active_favorite ON users(is_deleted, is_favorite, created_at);
