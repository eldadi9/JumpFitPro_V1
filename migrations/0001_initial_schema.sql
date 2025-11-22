-- מסד נתונים לאפליקציית ניהול תכנית קפיצה בחבל
-- תאריך יצירה: 2025-11-22

-- טבלת משתמשים
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  height_cm INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  target_weight_kg REAL NOT NULL,
  gender TEXT DEFAULT 'male',
  workouts_per_week INTEGER DEFAULT 3,
  current_level TEXT DEFAULT 'beginner', -- beginner, intermediate, advanced
  preferred_intensity TEXT DEFAULT 'medium', -- easy, medium, hard
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- טבלת תכניות אימון
CREATE TABLE IF NOT EXISTS workout_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_name TEXT NOT NULL,
  description TEXT,
  level TEXT NOT NULL, -- beginner, intermediate, advanced
  sessions_per_week INTEGER NOT NULL,
  duration_weeks INTEGER DEFAULT 12,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- טבלת אימונים שבועיים (קובץ תכנית)
CREATE TABLE IF NOT EXISTS plan_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  week_number INTEGER NOT NULL,
  day_of_week TEXT, -- Monday, Tuesday, etc.
  session_number INTEGER NOT NULL,
  work_seconds INTEGER NOT NULL,
  rest_seconds INTEGER NOT NULL,
  sets_count INTEGER NOT NULL,
  intensity TEXT NOT NULL, -- easy, medium, hard
  notes TEXT,
  FOREIGN KEY (plan_id) REFERENCES workout_plans(id) ON DELETE CASCADE
);

-- טבלת רשומות אימון (יומן אימונים)
CREATE TABLE IF NOT EXISTS workout_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER,
  session_id INTEGER,
  workout_date DATE NOT NULL,
  work_minutes REAL NOT NULL,
  sets_completed INTEGER DEFAULT 0,
  intensity TEXT NOT NULL, -- easy, medium, hard
  calories_burned REAL NOT NULL,
  notes TEXT,
  completed BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES workout_plans(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES plan_sessions(id) ON DELETE SET NULL
);

-- טבלת מעקב משקל
CREATE TABLE IF NOT EXISTS weight_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  measurement_date DATE NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- טבלת הישגים
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  achievement_type TEXT NOT NULL, -- total_calories, consecutive_days, total_workouts, etc.
  achievement_name TEXT NOT NULL,
  achievement_value INTEGER NOT NULL,
  earned_date DATE NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- אינדקסים לביצועים טובים יותר
CREATE INDEX IF NOT EXISTS idx_workout_logs_user_date ON workout_logs(user_id, workout_date);
CREATE INDEX IF NOT EXISTS idx_workout_logs_user_plan ON workout_logs(user_id, plan_id);
CREATE INDEX IF NOT EXISTS idx_weight_tracking_user_date ON weight_tracking(user_id, measurement_date);
CREATE INDEX IF NOT EXISTS idx_plan_sessions_plan_week ON plan_sessions(plan_id, week_number);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
