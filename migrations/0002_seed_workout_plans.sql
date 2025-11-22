-- נתוני תכניות אימון מוכנות (12 שבועות)
-- מבוסס על מחקר מדעי של קפיצה בחבל

-- ========================================
-- תכנית 1: מתחילים - 3 פעמים בשבוע
-- ========================================
INSERT INTO workout_plans (plan_name, description, level, sessions_per_week, duration_weeks) 
VALUES ('תכנית מתחילים - 3 אימונים בשבוע', 'תכנית בסיסית להתחלה הדרגתית עם קפיצה בחבל. מתאים למי שמתחיל מאפס.', 'beginner', 3, 12);

-- שבועות 1-4: בניית בסיס
-- שבוע 1: 5 סטים של 30 שניות עבודה, 60 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 1, 'Monday', 1, 30, 60, 5, 'easy', 'אימון ראשון - התמקדות בטכניקה נכונה'),
  (1, 1, 'Wednesday', 2, 30, 60, 5, 'easy', 'אימון שני - שמירה על קצב איטי'),
  (1, 1, 'Friday', 3, 30, 60, 5, 'easy', 'אימון שלישי - סיום שבוע ראשון');

-- שבוע 2: 6 סטים של 30 שניות עבודה, 45 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 2, 'Monday', 1, 30, 45, 6, 'easy', 'הוספת סט ראשון'),
  (1, 2, 'Wednesday', 2, 30, 45, 6, 'easy', 'הפחתת זמן מנוחה'),
  (1, 2, 'Friday', 3, 30, 45, 6, 'easy', 'שמירה על קצב קבוע');

-- שבוע 3: 6 סטים של 40 שניות עבודה, 40 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 3, 'Monday', 1, 40, 40, 6, 'easy', 'הארכת זמן עבודה'),
  (1, 3, 'Wednesday', 2, 40, 40, 6, 'easy', 'מנוחה שווה לעבודה'),
  (1, 3, 'Friday', 3, 40, 40, 6, 'easy', 'שיפור סיבולת');

-- שבוע 4: 8 סטים של 40 שניות עבודה, 30 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 4, 'Monday', 1, 40, 30, 8, 'easy', 'הוספת 2 סטים'),
  (1, 4, 'Wednesday', 2, 40, 30, 8, 'easy', 'הפחתת מנוחה'),
  (1, 4, 'Friday', 3, 40, 30, 8, 'easy', 'סיום חודש ראשון');

-- שבועות 5-8: רמת ביניים
-- שבוע 5: 8 סטים של 45 שניות עבודה, 30 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 5, 'Monday', 1, 45, 30, 8, 'medium', 'מעבר לעצימות בינונית'),
  (1, 5, 'Wednesday', 2, 45, 30, 8, 'medium', 'העלאת קצב קפיצה'),
  (1, 5, 'Friday', 3, 45, 30, 8, 'medium', 'שמירה על טכניקה');

-- שבוע 6: 10 סטים של 45 שניות עבודה, 30 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 6, 'Monday', 1, 45, 30, 10, 'medium', 'הוספת 2 סטים'),
  (1, 6, 'Wednesday', 2, 45, 30, 10, 'medium', 'עבודה על סיבולת'),
  (1, 6, 'Friday', 3, 45, 30, 10, 'medium', 'שמירה על עצימות');

-- שבוע 7: 10 סטים של 50 שניות עבודה, 25 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 7, 'Monday', 1, 50, 25, 10, 'medium', 'הארכת זמן עבודה'),
  (1, 7, 'Wednesday', 2, 50, 25, 10, 'medium', 'הפחתת מנוחה'),
  (1, 7, 'Friday', 3, 50, 25, 10, 'medium', 'שיפור כושר');

-- שבוע 8: 12 סטים של 50 שניות עבודה, 25 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 8, 'Monday', 1, 50, 25, 12, 'medium', 'הוספת 2 סטים'),
  (1, 8, 'Wednesday', 2, 50, 25, 12, 'medium', 'סיום חודש שני'),
  (1, 8, 'Friday', 3, 50, 25, 12, 'medium', 'התקדמות משמעותית');

-- שבועות 9-12: רמה מתקדמת
-- שבוע 9: 12 סטים של 60 שניות עבודה, 30 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 9, 'Monday', 1, 60, 30, 12, 'medium', 'דקה מלאה לסט'),
  (1, 9, 'Wednesday', 2, 60, 30, 12, 'medium', 'שמירה על קצב'),
  (1, 9, 'Friday', 3, 60, 30, 12, 'medium', 'בניית סיבולת');

-- שבוע 10: 15 סטים של 60 שניות עבודה, 30 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 10, 'Monday', 1, 60, 30, 15, 'medium', 'הוספת 3 סטים'),
  (1, 10, 'Wednesday', 2, 60, 30, 15, 'medium', 'עבודה אינטנסיבית'),
  (1, 10, 'Friday', 3, 60, 30, 15, 'medium', 'שיפור כושר קרדיו');

-- שבוע 11: 15 סטים של 60 שניות עבודה, 20 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 11, 'Monday', 1, 60, 20, 15, 'hard', 'הפחתת מנוחה'),
  (1, 11, 'Wednesday', 2, 60, 20, 15, 'hard', 'עצימות גבוהה'),
  (1, 11, 'Friday', 3, 60, 20, 15, 'hard', 'אתגר סיבולת');

-- שבוע 12: 20 סטים של 60 שניות עבודה, 20 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (1, 12, 'Monday', 1, 60, 20, 20, 'hard', 'שבוע סיום'),
  (1, 12, 'Wednesday', 2, 60, 20, 20, 'hard', 'הישג מרשים'),
  (1, 12, 'Friday', 3, 60, 20, 20, 'hard', 'השלמת תכנית 12 שבועות');

-- ========================================
-- תכנית 2: מתחילים - 4 פעמים בשבוע
-- ========================================
INSERT INTO workout_plans (plan_name, description, level, sessions_per_week, duration_weeks) 
VALUES ('תכנית מתחילים - 4 אימונים בשבוע', 'תכנית מואצת להתקדמות מהירה יותר. 4 אימונים בשבוע.', 'beginner', 4, 12);

-- שבוע 1: 5 סטים של 30 שניות עבודה, 60 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (2, 1, 'Monday', 1, 30, 60, 5, 'easy', 'אימון ראשון'),
  (2, 1, 'Tuesday', 2, 30, 60, 5, 'easy', 'אימון שני'),
  (2, 1, 'Thursday', 3, 30, 60, 5, 'easy', 'אימון שלישי'),
  (2, 1, 'Saturday', 4, 30, 60, 5, 'easy', 'אימון רביעי');

-- שבוע 2: 6 סטים של 35 שניות עבודה, 50 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (2, 2, 'Monday', 1, 35, 50, 6, 'easy', 'התקדמות הדרגתית'),
  (2, 2, 'Tuesday', 2, 35, 50, 6, 'easy', 'הוספת סט'),
  (2, 2, 'Thursday', 3, 35, 50, 6, 'easy', 'שיפור טכניקה'),
  (2, 2, 'Saturday', 4, 35, 50, 6, 'easy', 'סיום שבוע 2');

-- המשך שבועות 3-12 באופן דומה...
-- (כאן ניתן להוסיף עוד 10 שבועות עבור תכנית 4 ימים)

-- ========================================
-- תכנית 3: ביניים - 4 פעמים בשבוע
-- ========================================
INSERT INTO workout_plans (plan_name, description, level, sessions_per_week, duration_weeks) 
VALUES ('תכנית ביניים - 4 אימונים בשבוע', 'תכנית לרמת ביניים עם עצימות בינונית-גבוהה.', 'intermediate', 4, 12);

-- שבוע 1: 10 סטים של 60 שניות עבודה, 30 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (3, 1, 'Monday', 1, 60, 30, 10, 'medium', 'רמת ביניים - התחלה'),
  (3, 1, 'Tuesday', 2, 60, 30, 10, 'medium', 'שמירה על קצב'),
  (3, 1, 'Thursday', 3, 60, 30, 10, 'medium', 'עבודה על סיבולת'),
  (3, 1, 'Saturday', 4, 60, 30, 10, 'medium', 'סיום שבוע ראשון');

-- ========================================
-- תכנית 4: מתקדם - 5 פעמים בשבוע
-- ========================================
INSERT INTO workout_plans (plan_name, description, level, sessions_per_week, duration_weeks) 
VALUES ('תכנית מתקדמים - 5 אימונים בשבוע', 'תכנית אינטנסיבית למתקדמים. דורשת כושר בסיסי טוב.', 'advanced', 5, 12);

-- שבוע 1: 15 סטים של 60 שניות עבודה, 20 שניות מנוחה
INSERT INTO plan_sessions (plan_id, week_number, day_of_week, session_number, work_seconds, rest_seconds, sets_count, intensity, notes)
VALUES 
  (4, 1, 'Monday', 1, 60, 20, 15, 'hard', 'רמת מתקדמים - עצימות גבוהה'),
  (4, 1, 'Tuesday', 2, 60, 20, 15, 'hard', 'שמירה על קצב גבוה'),
  (4, 1, 'Wednesday', 3, 60, 20, 15, 'hard', 'בניית סיבולת'),
  (4, 1, 'Friday', 4, 60, 20, 15, 'hard', 'אתגר אירובי'),
  (4, 1, 'Sunday', 5, 60, 20, 15, 'hard', 'סיום שבוע ראשון');
