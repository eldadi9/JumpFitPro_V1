-- הוספת עמודה לתמונות פרופיל
-- תמיכה ב: 
-- 1. העלאה מהגלריה (data:image URL)
-- 2. צילום ישיר במצלמה (data:image URL)
-- 3. URL לתמונה שהועלתה לשרת

ALTER TABLE users ADD COLUMN profile_image TEXT;

-- עדכון המשתמשים הקיימים עם תמונת ברירת מחדל (avatar placeholder)
UPDATE users SET profile_image = NULL WHERE profile_image IS NULL;
