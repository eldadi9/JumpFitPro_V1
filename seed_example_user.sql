-- יצירת משתמש לדוגמה עבור אלדד
-- פרטים: גיל 47, משקל 124, גובה 193, יעד 105

INSERT INTO users (name, age, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity)
VALUES ('אלדד', 47, 193, 124, 105, 4, 'beginner', 'medium');

-- רשומת משקל התחלתית
INSERT INTO weight_tracking (user_id, weight_kg, measurement_date, notes)
VALUES (1, 124, date('now'), 'משקל התחלתי - תחילת התכנית');

-- אימון דוגמה 1 (לפני שבוע)
INSERT INTO workout_logs (user_id, plan_id, session_id, workout_date, work_minutes, sets_completed, intensity, calories_burned, notes, completed)
VALUES (1, 1, 1, date('now', '-7 days'), 5, 5, 'easy', 130, 'אימון ראשון - הרגשתי טוב', 1);

-- אימון דוגמה 2 (לפני 5 ימים)
INSERT INTO workout_logs (user_id, plan_id, session_id, workout_date, work_minutes, sets_completed, intensity, calories_burned, notes, completed)
VALUES (1, 1, 2, date('now', '-5 days'), 5, 5, 'easy', 130, 'אימון שני - שיפור בטכניקה', 1);

-- אימון דוגמה 3 (לפני 3 ימים)
INSERT INTO workout_logs (user_id, plan_id, session_id, workout_date, work_minutes, sets_completed, intensity, calories_burned, notes, completed)
VALUES (1, 1, 3, date('now', '-3 days'), 6, 6, 'easy', 156, 'אימון שלישי - הוספתי סט', 1);

-- אימון דוגמה 4 (אתמול)
INSERT INTO workout_logs (user_id, plan_id, session_id, workout_date, work_minutes, sets_completed, intensity, calories_burned, notes, completed)
VALUES (1, 1, 4, date('now', '-1 days'), 6, 6, 'medium', 185, 'העליתי את העצימות', 1);

-- רשומת משקל אחרי שבוע
INSERT INTO weight_tracking (user_id, weight_kg, measurement_date, notes)
VALUES (1, 123.2, date('now'), 'אחרי שבוע ראשון - ירידה של 0.8 ק"ג');

-- הישג ראשון
INSERT INTO achievements (user_id, achievement_type, achievement_name, achievement_value, earned_date)
VALUES (1, 'total_workouts', 'אלוף ההתחלות', 4, date('now'));
