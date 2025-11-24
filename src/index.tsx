import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { calculateCalories, calculateCalorieSummary, calculateBMI, calculateWeightProgress, INTENSITY_LEVELS } from './utils/calories'

type Bindings = {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS
app.use('/api/*', cors())

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// ========================================
// API Routes - משתמשים
// ========================================

/**
 * יצירת משתמש חדש
 */
app.post('/api/users', async (c) => {
  try {
    const body = await c.req.json()
    const { name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity } = body

    // Validation
    if (!name || !age || !height_cm || !weight_kg || !target_weight_kg) {
      return c.json({ error: 'חסרים שדות חובה' }, 400)
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO users (name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      name,
      age,
      gender || 'male',
      height_cm,
      weight_kg,
      target_weight_kg,
      workouts_per_week || 3,
      current_level || 'beginner',
      preferred_intensity || 'medium'
    ).run()

    // יצירת רשומת משקל התחלתית
    if (result.meta.last_row_id) {
      await c.env.DB.prepare(`
        INSERT INTO weight_tracking (user_id, weight_kg, measurement_date, notes)
        VALUES (?, ?, date('now'), ?)
      `).bind(result.meta.last_row_id, weight_kg, 'משקל התחלתי').run()
    }

    return c.json({ 
      success: true, 
      user_id: result.meta.last_row_id,
      message: 'משתמש נוצר בהצלחה'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה ביצירת משתמש', details: String(error) }, 500)
  }
})

/**
 * קבלת כל המשתמשים (רק משתמשים פעילים - לא מחוקים)
 */
app.get('/api/users', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM users WHERE is_deleted = 0 ORDER BY created_at DESC
    `).all()
    
    return c.json({ users: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת משתמשים', details: String(error) }, 500)
  }
})

/**
 * קבלת משתמש לפי ID (רק אם לא מחוק)
 */
app.get('/api/users/:id', async (c) => {
  try {
    const userId = c.req.param('id')
    const user = await c.env.DB.prepare(`
      SELECT * FROM users WHERE id = ? AND is_deleted = 0
    `).bind(userId).first()

    if (!user) {
      return c.json({ error: 'משתמש לא נמצא' }, 404)
    }

    // חישוב BMI והתקדמות
    const bmi = calculateBMI(user.weight_kg as number, user.height_cm as number)
    const progress = calculateWeightProgress(user.weight_kg as number, user.target_weight_kg as number)

    return c.json({ 
      user,
      bmi,
      progress
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת משתמש', details: String(error) }, 500)
  }
})

/**
 * עדכון משתמש
 */
app.put('/api/users/:id', async (c) => {
  try {
    const userId = c.req.param('id')
    const body = await c.req.json()
    const { name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity } = body

    // אם המשקל השתנה, נוסיף רשומה לטבלת מעקב משקל
    if (weight_kg) {
      const currentUser = await c.env.DB.prepare(`SELECT weight_kg FROM users WHERE id = ?`).bind(userId).first()
      
      if (currentUser && currentUser.weight_kg !== weight_kg) {
        await c.env.DB.prepare(`
          INSERT INTO weight_tracking (user_id, weight_kg, measurement_date, notes)
          VALUES (?, ?, date('now'), ?)
        `).bind(userId, weight_kg, 'עדכון משקל').run()
      }
    }

    await c.env.DB.prepare(`
      UPDATE users 
      SET name = COALESCE(?, name),
          age = COALESCE(?, age),
          gender = COALESCE(?, gender),
          height_cm = COALESCE(?, height_cm),
          weight_kg = COALESCE(?, weight_kg),
          target_weight_kg = COALESCE(?, target_weight_kg),
          workouts_per_week = COALESCE(?, workouts_per_week),
          current_level = COALESCE(?, current_level),
          preferred_intensity = COALESCE(?, preferred_intensity),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity, userId).run()

    return c.json({ success: true, message: 'משתמש עודכן בהצלחה' })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון משתמש', details: String(error) }, 500)
  }
})

/**
 * מחיקת משתמש (Soft Delete)
 * לא מוחק פיזית, רק מסמן כמחוק
 */
app.delete('/api/users/:id', async (c) => {
  try {
    const userId = c.req.param('id')
    
    await c.env.DB.prepare(`
      UPDATE users SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(userId).run()
    
    return c.json({ success: true, message: 'משתמש נמחק בהצלחה (Soft Delete)' })
  } catch (error) {
    return c.json({ error: 'שגיאה במחיקת משתמש', details: String(error) }, 500)
  }
})

/**
 * מחיקת משתמש מלאה (Hard Delete)
 * מוחק לצמיתות את המשתמש וכל הנתונים הקשורים
 * CASCADE delete will automatically remove:
 * - workout_logs
 * - weight_tracking
 * - achievements
 */
app.delete('/api/users/:id/permanent', async (c) => {
  try {
    const userId = c.req.param('id')
    
    // מחיקת המשתמש - CASCADE ידאג למחיקת כל הטבלאות המקושרות
    await c.env.DB.prepare(`
      DELETE FROM users WHERE id = ?
    `).bind(userId).run()
    
    return c.json({ 
      success: true, 
      message: 'משתמש נמחק לצמיתות כולל כל הנתונים'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה במחיקה מלאה', details: String(error) }, 500)
  }
})

/**
 * סימון משתמש כמועדף / ביטול
 */
app.patch('/api/users/:id/favorite', async (c) => {
  try {
    const userId = c.req.param('id')
    const body = await c.req.json()
    const isFavorite = body.is_favorite ? 1 : 0
    
    await c.env.DB.prepare(`
      UPDATE users SET is_favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(isFavorite, userId).run()
    
    return c.json({ success: true, is_favorite: isFavorite })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון מועדפים', details: String(error) }, 500)
  }
})

/**
 * עדכון תמונת פרופיל
 * תומך ב-Base64 Data URLs (מהמצלמה או מהגלריה)
 */
app.patch('/api/users/:id/profile-image', async (c) => {
  try {
    const userId = c.req.param('id')
    const body = await c.req.json()
    const { profile_image } = body
    
    // אימות שמדובר ב-data URL תקין
    if (profile_image && !profile_image.startsWith('data:image/')) {
      return c.json({ error: 'פורמט תמונה לא תקין - חייב להיות data:image/' }, 400)
    }
    
    await c.env.DB.prepare(`
      UPDATE users SET profile_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(profile_image, userId).run()
    
    return c.json({ success: true, message: 'תמונת פרופיל עודכנה בהצלחה' })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון תמונת פרופיל', details: String(error) }, 500)
  }
})

/**
 * קבלת משתמשים עם סטטיסטיקות (כולל מספר אימונים בשבוע האחרון)
 * ממוין לפי: מועדפים ראשונים, לא מחוקים בלבד
 */
app.get('/api/users-with-stats', async (c) => {
  try {
    const { results: users } = await c.env.DB.prepare(`
      SELECT * FROM users WHERE is_deleted = 0 ORDER BY is_favorite DESC, created_at DESC
    `).all()
    
    // הוספת סטטיסטיקות לכל משתמש
    const usersWithStats = await Promise.all(users.map(async (user: any) => {
      // מספר אימונים בשבוע האחרון
      const weeklyWorkouts = await c.env.DB.prepare(`
        SELECT COUNT(*) as count
        FROM workout_logs 
        WHERE user_id = ? AND workout_date >= date('now', '-7 days')
      `).bind(user.id).first()
      
      return {
        ...user,
        weekly_workouts: weeklyWorkouts?.count || 0
      }
    }))
    
    return c.json({ users: usersWithStats })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת משתמשים', details: String(error) }, 500)
  }
})

// ========================================
// API Routes - תכניות אימון
// ========================================

/**
 * קבלת כל תכניות האימון
 */
app.get('/api/plans', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM workout_plans ORDER BY level, sessions_per_week
    `).all()
    
    return c.json({ plans: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת תכניות', details: String(error) }, 500)
  }
})

/**
 * קבלת תכנית אימון לפי ID
 */
app.get('/api/plans/:id', async (c) => {
  try {
    const planId = c.req.param('id')
    const plan = await c.env.DB.prepare(`
      SELECT * FROM workout_plans WHERE id = ?
    `).bind(planId).first()

    if (!plan) {
      return c.json({ error: 'תכנית לא נמצאה' }, 404)
    }

    // קבלת כל האימונים של התכנית
    const { results: sessions } = await c.env.DB.prepare(`
      SELECT * FROM plan_sessions 
      WHERE plan_id = ? 
      ORDER BY week_number, session_number
    `).bind(planId).all()

    return c.json({ plan, sessions })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת תכנית', details: String(error) }, 500)
  }
})

/**
 * קבלת אימונים לשבוע ספציפי
 */
app.get('/api/plans/:id/week/:week', async (c) => {
  try {
    const planId = c.req.param('id')
    const weekNumber = c.req.param('week')
    
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM plan_sessions 
      WHERE plan_id = ? AND week_number = ?
      ORDER BY session_number
    `).bind(planId, weekNumber).all()

    return c.json({ sessions: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת אימונים', details: String(error) }, 500)
  }
})

/**
 * שליחת תכנית אימון בWhatsApp / SMS
 * פונקציה להכנה לאינטגרציה עתידית עם Twilio / WhatsApp API
 * נכון לעכשיו מחזירה קישור לשיתוף ב-WhatsApp Web
 */
app.post('/api/plans/:id/share', async (c) => {
  try {
    const planId = c.req.param('id')
    const body = await c.req.json()
    const { phone_number, method } = body // method: 'whatsapp' | 'sms'
    
    // קבלת התכנית מהמסד נתונים
    const plan = await c.env.DB.prepare(`
      SELECT * FROM workout_plans WHERE id = ?
    `).bind(planId).first()
    
    if (!plan) {
      return c.json({ error: 'תכנית לא נמצאה' }, 404)
    }
    
    // יצירת טקסט התכנית
    const planText = `🏃 תכנית ${plan.plan_name}\n\n` +
      `📊 רמה: ${plan.level === 'beginner' ? 'מתחילים' : plan.level === 'intermediate' ? 'בינוני' : 'מתקדם'}\n` +
      `💪 ${plan.sessions_per_week} אימונים בשבוע\n` +
      `⏱️ משך התכנית: ${plan.duration_weeks} שבועות\n\n` +
      `${plan.description}\n\n` +
      `הצטרף ל-JumpFitPro לניהול מלא!`
    
    if (method === 'whatsapp') {
      // יצירת קישור WhatsApp Web עם הטקסט המוכן
      const whatsappUrl = `https://wa.me/${phone_number}?text=${encodeURIComponent(planText)}`
      return c.json({ 
        success: true, 
        share_url: whatsappUrl,
        message: 'קישור WhatsApp נוצר בהצלחה'
      })
    } else if (method === 'sms') {
      // לעתיד: אינטגרציה עם Twilio לשליחת SMS
      return c.json({ 
        success: false,
        message: 'שליחת SMS תהיה זמינה בקרוב - נדרש חיבור ל-Twilio API'
      })
    }
    
    return c.json({ error: 'שיטת שליחה לא נתמכת' }, 400)
  } catch (error) {
    return c.json({ error: 'שגיאה בשליחת תכנית', details: String(error) }, 500)
  }
})

/**
 * שליחת תכנית אימון במייל
 * פונקציה להכנה לאינטגרציה עתידית עם SendGrid / Resend / Mailgun
 */
app.post('/api/plans/:id/email', async (c) => {
  try {
    const planId = c.req.param('id')
    const body = await c.req.json()
    const { email, user_name } = body
    
    // קבלת התכנית מהמסד נתונים
    const plan = await c.env.DB.prepare(`
      SELECT * FROM workout_plans WHERE id = ?
    `).bind(planId).first()
    
    if (!plan) {
      return c.json({ error: 'תכנית לא נמצאה' }, 404)
    }
    
    // קבלת כל האימונים של התכנית
    const { results: sessions } = await c.env.DB.prepare(`
      SELECT * FROM plan_sessions 
      WHERE plan_id = ? 
      ORDER BY week_number, session_number
    `).bind(planId).all()
    
    // לעתיד: שליחת מייל דרך SendGrid / Resend / Mailgun
    // const emailHtml = generatePlanEmailTemplate(plan, sessions, user_name)
    // await sendEmail(email, 'תכנית האימונים שלך מ-JumpFitPro', emailHtml)
    
    return c.json({ 
      success: false,
      message: 'שליחת מייל תהיה זמינה בקרוב - נדרש חיבור ל-SendGrid/Resend API',
      plan_info: {
        name: plan.plan_name,
        sessions: sessions.length,
        recipient: email
      }
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בשליחת מייל', details: String(error) }, 500)
  }
})

// ========================================
// API Routes - רישום אימונים
// ========================================

/**
 * שמירת אימון חדש
 */
app.post('/api/workouts', async (c) => {
  try {
    const body = await c.req.json()
    const { user_id, plan_id, session_id, workout_date, work_minutes, sets_completed, intensity, notes } = body

    if (!user_id || !workout_date || !work_minutes || !intensity) {
      return c.json({ error: 'חסרים שדות חובה' }, 400)
    }

    // קבלת משקל המשתמש לחישוב קלוריות
    const user = await c.env.DB.prepare(`SELECT weight_kg FROM users WHERE id = ?`).bind(user_id).first()
    
    if (!user) {
      return c.json({ error: 'משתמש לא נמצא' }, 404)
    }

    // חישוב קלוריות
    const calorieResult = calculateCalories({
      weight_kg: user.weight_kg as number,
      work_minutes: work_minutes,
      intensity: intensity
    })

    // שמירת האימון
    const result = await c.env.DB.prepare(`
      INSERT INTO workout_logs (user_id, plan_id, session_id, workout_date, work_minutes, sets_completed, intensity, calories_burned, notes, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      user_id,
      plan_id || null,
      session_id || null,
      workout_date,
      work_minutes,
      sets_completed || 0,
      intensity,
      calorieResult.total_calories,
      notes || ''
    ).run()

    return c.json({ 
      success: true, 
      workout_id: result.meta.last_row_id,
      calories_burned: calorieResult.total_calories,
      message: 'אימון נשמר בהצלחה'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בשמירת אימון', details: String(error) }, 500)
  }
})

/**
 * עדכון אימון קיים
 */
app.put('/api/workouts/:id', async (c) => {
  try {
    const workoutId = c.req.param('id')
    const body = await c.req.json()
    const { workout_date, work_minutes, sets_completed, intensity, notes } = body

    // קבלת משתמש לחישוב קלוריות מחדש
    const workout = await c.env.DB.prepare(`SELECT user_id FROM workout_logs WHERE id = ?`).bind(workoutId).first()
    
    if (!workout) {
      return c.json({ error: 'אימון לא נמצא' }, 404)
    }

    const user = await c.env.DB.prepare(`SELECT weight_kg FROM users WHERE id = ?`).bind(workout.user_id).first()
    
    // חישוב קלוריות מחדש
    const calorieResult = calculateCalories({
      weight_kg: user.weight_kg as number,
      work_minutes: parseFloat(work_minutes),
      intensity: intensity
    })

    // עדכון האימון
    await c.env.DB.prepare(`
      UPDATE workout_logs 
      SET workout_date = COALESCE(?, workout_date),
          work_minutes = COALESCE(?, work_minutes),
          sets_completed = COALESCE(?, sets_completed),
          intensity = COALESCE(?, intensity),
          calories_burned = ?,
          notes = COALESCE(?, notes)
      WHERE id = ?
    `).bind(
      workout_date,
      work_minutes,
      sets_completed,
      intensity,
      calorieResult.total_calories,
      notes,
      workoutId
    ).run()

    return c.json({ 
      success: true, 
      calories_burned: calorieResult.total_calories,
      message: 'אימון עודכן בהצלחה'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון אימון', details: String(error) }, 500)
  }
})

/**
 * מחיקת אימון
 */
app.delete('/api/workouts/:id', async (c) => {
  try {
    const workoutId = c.req.param('id')
    
    // בדיקה אם האימון קיים
    const workout = await c.env.DB.prepare(`SELECT id FROM workout_logs WHERE id = ?`).bind(workoutId).first()
    
    if (!workout) {
      return c.json({ error: 'אימון לא נמצא' }, 404)
    }
    
    // מחיקת האימון
    await c.env.DB.prepare(`DELETE FROM workout_logs WHERE id = ?`).bind(workoutId).run()
    
    return c.json({ 
      success: true, 
      message: 'אימון נמחק בהצלחה'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה במחיקת אימון', details: String(error) }, 500)
  }
})

/**
 * שכפול אימון
 */
app.post('/api/workouts/:id/duplicate', async (c) => {
  try {
    const workoutId = c.req.param('id')
    
    // קבלת פרטי האימון המקורי
    const workout = await c.env.DB.prepare(`
      SELECT * FROM workout_logs WHERE id = ?
    `).bind(workoutId).first()
    
    if (!workout) {
      return c.json({ error: 'אימון לא נמצא' }, 404)
    }
    
    // יצירת אימון חדש עם אותם נתונים אבל תאריך היום
    const result = await c.env.DB.prepare(`
      INSERT INTO workout_logs (
        user_id, plan_id, session_id, workout_date, 
        work_minutes, sets_completed, intensity, 
        calories_burned, notes, completed
      ) VALUES (?, ?, ?, date('now'), ?, ?, ?, ?, ?, ?)
    `).bind(
      workout.user_id,
      workout.plan_id,
      workout.session_id,
      workout.work_minutes,
      workout.sets_completed,
      workout.intensity,
      workout.calories_burned,
      workout.notes ? `שכפול: ${workout.notes}` : 'שכפול אימון',
      1
    ).run()
    
    return c.json({ 
      success: true, 
      new_workout_id: result.meta.last_row_id,
      message: 'אימון שוכפל בהצלחה להיום'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בשכפול אימון', details: String(error) }, 500)
  }
})

/**
 * קבלת כל האימונים של משתמש
 */
app.get('/api/workouts/user/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM workout_logs 
      WHERE user_id = ? 
      ORDER BY workout_date DESC
    `).bind(userId).all()

    return c.json({ workouts: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת אימונים', details: String(error) }, 500)
  }
})

/**
 * סטטיסטיקות אימונים למשתמש
 */
app.get('/api/workouts/user/:userId/stats', async (c) => {
  try {
    const userId = c.req.param('userId')
    
    // קלוריות יומיות (היום)
    const todayCalories = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(calories_burned), 0) as total
      FROM workout_logs 
      WHERE user_id = ? AND workout_date = date('now')
    `).bind(userId).first()

    // קלוריות שבועיות (7 ימים אחרונים)
    const weeklyCalories = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(calories_burned), 0) as total
      FROM workout_logs 
      WHERE user_id = ? AND workout_date >= date('now', '-7 days')
    `).bind(userId).first()

    // קלוריות חודשיות (30 ימים אחרונים)
    const monthlyCalories = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(calories_burned), 0) as total
      FROM workout_logs 
      WHERE user_id = ? AND workout_date >= date('now', '-30 days')
    `).bind(userId).first()

    // סך הכל אימונים
    const totalWorkouts = await c.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM workout_logs 
      WHERE user_id = ?
    `).bind(userId).first()

    // ממוצע קלוריות לאימון
    const avgCalories = await c.env.DB.prepare(`
      SELECT AVG(calories_burned) as avg
      FROM workout_logs 
      WHERE user_id = ?
    `).bind(userId).first()

    return c.json({
      today_calories: todayCalories?.total || 0,
      weekly_calories: weeklyCalories?.total || 0,
      monthly_calories: monthlyCalories?.total || 0,
      total_workouts: totalWorkouts?.count || 0,
      avg_calories_per_workout: Math.round(avgCalories?.avg || 0)
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת סטטיסטיקות', details: String(error) }, 500)
  }
})

// ========================================
// API Routes - מעקב משקל
// ========================================

/**
 * קבלת היסטוריית משקל למשתמש
 */
app.get('/api/weight/user/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM weight_tracking 
      WHERE user_id = ? 
      ORDER BY measurement_date DESC
    `).bind(userId).all()

    return c.json({ weight_history: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת היסטוריית משקל', details: String(error) }, 500)
  }
})

/**
 * קבלת נתוני משקל לגרף (30 ימים אחרונים)
 * מחזיר נקודות נתונים לגרף ליניארי
 */
app.get('/api/weight/user/:userId/chart', async (c) => {
  try {
    const userId = c.req.param('userId')
    const { results } = await c.env.DB.prepare(`
      SELECT measurement_date as date, weight_kg as weight
      FROM weight_tracking 
      WHERE user_id = ? AND measurement_date >= date('now', '-30 days')
      ORDER BY measurement_date ASC
    `).bind(userId).all()
    
    return c.json({ data: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת נתוני גרף משקל', details: String(error) }, 500)
  }
})

/**
 * קבלת קלוריות שבועיות לפי ימים (לגרף עמודות)
 * מחזיר 7 ימים אחרונים עם סכום קלוריות ליום
 */
app.get('/api/workouts/user/:userId/weekly-chart', async (c) => {
  try {
    const userId = c.req.param('userId')
    const { results } = await c.env.DB.prepare(`
      SELECT 
        workout_date as date,
        SUM(calories_burned) as calories
      FROM workout_logs 
      WHERE user_id = ? AND workout_date >= date('now', '-7 days')
      GROUP BY workout_date
      ORDER BY workout_date ASC
    `).bind(userId).all()
    
    return c.json({ data: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת נתוני גרף קלוריות', details: String(error) }, 500)
  }
})

/**
 * קבלת מספר אימונים שנעשו השבוע (לעומת היעד)
 */
app.get('/api/workouts/user/:userId/week-progress', async (c) => {
  try {
    const userId = c.req.param('userId')
    
    // קבלת מספר אימונים השבוע
    const weekWorkouts = await c.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM workout_logs 
      WHERE user_id = ? AND workout_date >= date('now', 'weekday 0', '-7 days')
    `).bind(userId).first()
    
    // קבלת יעד שבועי
    const user = await c.env.DB.prepare(`
      SELECT workouts_per_week FROM users WHERE id = ?
    `).bind(userId).first()
    
    return c.json({
      completed: weekWorkouts?.count || 0,
      target: user?.workouts_per_week || 3,
      remaining: Math.max(0, (user?.workouts_per_week || 3) - (weekWorkouts?.count || 0))
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת התקדמות שבועית', details: String(error) }, 500)
  }
})

// ========================================
// API Routes - חישוב קלוריות
// ========================================

/**
 * חישוב קלוריות
 */
app.post('/api/calculate/calories', async (c) => {
  try {
    const body = await c.req.json()
    const { weight_kg, work_minutes, intensity } = body

    if (!weight_kg || !work_minutes || !intensity) {
      return c.json({ error: 'חסרים פרמטרים לחישוב' }, 400)
    }

    const result = calculateCalories({ weight_kg, work_minutes, intensity })
    
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'שגיאה בחישוב קלוריות', details: String(error) }, 500)
  }
})

/**
 * קבלת רמות עצימות
 */
app.get('/api/intensity-levels', async (c) => {
  return c.json({ intensity_levels: INTENSITY_LEVELS })
})

// ========================================
// Frontend Routes
// ========================================

/**
 * דף הבית - כניסה למערכת
 */
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>JumpFitPro - ניהול ירידה במשקל</title>
        <meta name="theme-color" content="#667eea">
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="apple-mobile-web-app-title" content="JumpFitPro">
        <link rel="manifest" href="/manifest.json">
        <link rel="apple-touch-icon" href="/static/logo.svg">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <!-- Header -->
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-center">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-16" />
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <main class="max-w-7xl mx-auto px-4 py-12">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
                <!-- Welcome Card -->
                <div class="bg-white rounded-xl shadow-lg p-8">
                    <div class="text-center mb-6">
                        <i class="fas fa-user-plus text-6xl text-indigo-600 mb-4"></i>
                        <h2 class="text-2xl font-bold text-gray-800 mb-2">משתמש חדש</h2>
                        <p class="text-gray-600">התחל את המסע שלך לירידה במשקל</p>
                    </div>
                    <button onclick="showNewUserForm()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-lg transition duration-300">
                        <i class="fas fa-arrow-left ml-2"></i>
                        צור פרופיל חדש
                    </button>
                </div>

                <!-- Login Card -->
                <div class="bg-white rounded-xl shadow-lg p-8">
                    <div class="text-center mb-6">
                        <i class="fas fa-sign-in-alt text-6xl text-green-600 mb-4"></i>
                        <h2 class="text-2xl font-bold text-gray-800 mb-2">התחברות</h2>
                        <p class="text-gray-600">המשך את האימונים שלך</p>
                    </div>
                    <button onclick="showUserList()" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-lg transition duration-300">
                        <i class="fas fa-arrow-left ml-2"></i>
                        בחר משתמש קיים
                    </button>
                </div>
            </div>

            <!-- Features -->
            <div class="bg-white rounded-xl shadow-lg p-8">
                <h3 class="text-2xl font-bold text-gray-800 mb-6 text-center">מה כלול באפליקציה?</h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div class="text-center">
                        <i class="fas fa-calendar-alt text-4xl text-blue-600 mb-3"></i>
                        <h4 class="font-bold text-gray-800 mb-2">תכנית 12 שבועות</h4>
                        <p class="text-gray-600 text-sm">תכנית אימונים מלאה ומתקדמת הדרגתית</p>
                    </div>
                    <div class="text-center">
                        <i class="fas fa-fire text-4xl text-orange-600 mb-3"></i>
                        <h4 class="font-bold text-gray-800 mb-2">חישוב קלוריות מדויק</h4>
                        <p class="text-gray-600 text-sm">מבוסס על מחקר מדעי ונוסחת MET</p>
                    </div>
                    <div class="text-center">
                        <i class="fas fa-chart-line text-4xl text-green-600 mb-3"></i>
                        <h4 class="font-bold text-gray-800 mb-2">מעקב התקדמות</h4>
                        <p class="text-gray-600 text-sm">גרפים ומדדים להתקדמות שלך</p>
                    </div>
                </div>
            </div>

            <!-- Hidden User List -->
            <div id="userListContainer" class="hidden mt-8 bg-white rounded-xl shadow-lg p-8">
                <h3 class="text-2xl font-bold text-gray-800 mb-6">בחר משתמש</h3>
                <div id="userList" class="space-y-4"></div>
                <button onclick="hideUserList()" class="mt-6 bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg">
                    חזרה
                </button>
            </div>

            <!-- Hidden New User Form -->
            <div id="newUserFormContainer" class="hidden mt-8 bg-white rounded-xl shadow-lg p-8">
                <h3 class="text-2xl font-bold text-gray-800 mb-6">יצירת פרופיל חדש</h3>
                <form id="newUserForm" class="space-y-4">
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">שם מלא</label>
                        <input type="text" name="name" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">מין</label>
                        <select name="gender" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                            <option value="male">זכר</option>
                            <option value="female">נקבה</option>
                        </select>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">גיל</label>
                            <input type="number" name="age" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">גובה (ס"מ)</label>
                            <input type="number" name="height_cm" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">משקל נוכחי (ק"ג)</label>
                            <input type="number" step="0.1" name="weight_kg" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">משקל יעד (ק"ג)</label>
                            <input type="number" step="0.1" name="target_weight_kg" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">כמות אימונים בשבוע</label>
                        <select name="workouts_per_week" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                            <option value="3">3 אימונים בשבוע</option>
                            <option value="4">4 אימונים בשבוע</option>
                            <option value="5">5 אימונים בשבוע</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">רמת כושר התחלתית</label>
                        <select name="current_level" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                            <option value="beginner">מתחילים</option>
                            <option value="intermediate">בינוני</option>
                            <option value="advanced">מתקדם</option>
                        </select>
                    </div>
                    <div class="flex gap-4">
                        <button type="submit" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition duration-300">
                            <i class="fas fa-check ml-2"></i>
                            צור חשבון והתחל
                        </button>
                        <button type="button" onclick="hideNewUserForm()" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg">
                            ביטול
                        </button>
                    </div>
                </form>
            </div>
        </main>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
          // Show/Hide forms
          function showNewUserForm() {
            document.getElementById('newUserFormContainer').classList.remove('hidden')
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
          }

          function hideNewUserForm() {
            document.getElementById('newUserFormContainer').classList.add('hidden')
          }

          async function showUserList() {
            try {
              const response = await axios.get('/api/users-with-stats')
              const users = response.data.users
              
              const userListHtml = users.map(user => \`
                <div class="border border-gray-300 rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition relative" onclick="selectUser(\${user.id})">
                  \${user.is_favorite ? '<div class="absolute top-2 left-2"><i class="fas fa-star text-yellow-500"></i></div>' : ''}
                  <div class="flex items-center justify-between">
                    <div>
                      <h4 class="font-bold text-lg text-gray-800">\${user.name}</h4>
                      <p class="text-gray-600">גיל: \${user.age} | משקל נוכחי: \${user.weight_kg} ק"ג | יעד: \${user.target_weight_kg} ק"ג</p>
                      <p class="text-sm text-indigo-600 mt-1">
                        <i class="fas fa-dumbbell ml-1"></i>
                        \${user.weekly_workouts} אימונים בשבוע האחרון
                      </p>
                    </div>
                    <i class="fas fa-arrow-left text-indigo-600 text-2xl"></i>
                  </div>
                </div>
              \`).join('')
              
              document.getElementById('userList').innerHTML = userListHtml || '<p class="text-gray-500 text-center">אין משתמשים עדיין</p>'
              document.getElementById('userListContainer').classList.remove('hidden')
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
            } catch (error) {
              alert('שגיאה בטעינת משתמשים')
            }
          }

          function hideUserList() {
            document.getElementById('userListContainer').classList.add('hidden')
          }

          function selectUser(userId) {
            window.location.href = '/dashboard?user=' + userId
          }

          // Handle new user form submission
          document.getElementById('newUserForm').addEventListener('submit', async (e) => {
            e.preventDefault()
            const formData = new FormData(e.target)
            const data = Object.fromEntries(formData)
            
            try {
              const response = await axios.post('/api/users', data)
              if (response.data.success) {
                alert('חשבון נוצר בהצלחה!')
                window.location.href = '/dashboard?user=' + response.data.user_id
              }
            } catch (error) {
              alert('שגיאה ביצירת חשבון: ' + (error.response?.data?.error || error.message))
            }
          })

          // Register Service Worker for PWA
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
              navigator.serviceWorker.register('/sw.js')
                .then((registration) => console.log('SW registered:', registration))
                .catch((error) => console.log('SW registration failed:', error));
            });
          }
        </script>
    </body>
    </html>
  `)
})

/**
 * דשבורד משתמש
 */
app.get('/dashboard', (c) => {
  const userId = c.req.query('user')
  
  if (!userId) {
    return c.redirect('/')
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>דשבורד - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <!-- Header -->
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                        <div>
                            <p id="userName" class="text-lg font-bold text-gray-700"></p>
                        </div>
                    </div>
                    <a href="/" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
                        <i class="fas fa-home ml-2"></i>
                        חזרה
                    </a>
                </div>
            </div>
        </header>

        <!-- Main Dashboard -->
        <main class="max-w-7xl mx-auto px-4 py-8">
            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-fire text-3xl text-orange-500"></i>
                        <span class="text-gray-500 text-sm">היום</span>
                    </div>
                    <h3 class="text-3xl font-bold text-gray-800" id="todayCalories">0</h3>
                    <p class="text-gray-600 text-sm">קלוריות</p>
                </div>

                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-calendar-week text-3xl text-blue-500"></i>
                        <span class="text-gray-500 text-sm">שבועי</span>
                    </div>
                    <h3 class="text-3xl font-bold text-gray-800" id="weeklyCalories">0</h3>
                    <p class="text-gray-600 text-sm">קלוריות</p>
                </div>

                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-calendar-alt text-3xl text-green-500"></i>
                        <span class="text-gray-500 text-sm">חודשי</span>
                    </div>
                    <h3 class="text-3xl font-bold text-gray-800" id="monthlyCalories">0</h3>
                    <p class="text-gray-600 text-sm">קלוריות</p>
                </div>

                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-dumbbell text-3xl text-purple-500"></i>
                        <span class="text-gray-500 text-sm">סה"כ</span>
                    </div>
                    <h3 class="text-3xl font-bold text-gray-800" id="totalWorkouts">0</h3>
                    <p class="text-gray-600 text-sm">אימונים</p>
                </div>
            </div>

            <!-- Progress Section -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                <!-- Weight Progress -->
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">התקדמות משקל</h3>
                    <div id="weightProgress" class="space-y-4">
                        <div>
                            <div class="flex justify-between mb-2">
                                <span class="text-gray-700 font-semibold">משקל נוכחי</span>
                                <span id="currentWeight" class="text-gray-800 font-bold"></span>
                            </div>
                            <div class="flex justify-between mb-2">
                                <span class="text-gray-700 font-semibold">משקל יעד</span>
                                <span id="targetWeight" class="text-gray-800 font-bold"></span>
                            </div>
                            <div class="flex justify-between mb-4">
                                <span class="text-gray-700 font-semibold">נותר להגיע</span>
                                <span id="remainingWeight" class="text-indigo-600 font-bold text-xl"></span>
                            </div>
                            <div class="w-full bg-gray-200 rounded-full h-4">
                                <div id="progressBar" class="bg-indigo-600 h-4 rounded-full transition-all duration-500" style="width: 0%"></div>
                            </div>
                            <p id="progressPercentage" class="text-center mt-2 text-gray-600 font-semibold"></p>
                        </div>
                    </div>
                </div>

                <!-- BMI Card -->
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">מדד BMI</h3>
                    <div class="text-center">
                        <div class="text-6xl font-bold text-indigo-600 mb-2" id="bmiValue">0</div>
                        <p class="text-gray-600 font-semibold" id="bmiStatus"></p>
                    </div>
                </div>
            </div>

            <!-- Weekly Progress Meter -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
                <h3 class="text-xl font-bold text-gray-800 mb-4">התקדמות שבועית</h3>
                <div class="flex items-center justify-between mb-3">
                    <span class="text-gray-700 font-semibold">אימונים השבוע</span>
                    <span class="text-2xl font-bold text-indigo-600"><span id="weekCompleted">0</span> / <span id="weekTarget">3</span></span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-4 mb-2">
                    <div id="weekProgressBar" class="bg-green-600 h-4 rounded-full transition-all duration-500" style="width: 0%"></div>
                </div>
                <p id="weekRemaining" class="text-sm text-gray-600 text-center">נותרו עוד 3 אימונים השבוע</p>
            </div>

            <!-- Charts Section -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                <!-- Weight Chart -->
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-weight text-indigo-600 ml-2"></i>
                        גרף משקל (30 ימים)
                    </h3>
                    <canvas id="weightChart"></canvas>
                </div>

                <!-- Weekly Calories Chart -->
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-chart-bar text-orange-600 ml-2"></i>
                        קלוריות שבועיות
                    </h3>
                    <canvas id="caloriesChart"></canvas>
                </div>
            </div>

            <!-- Quick Actions -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
                <h3 class="text-xl font-bold text-gray-800 mb-4">פעולות מהירות</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
                    <button onclick="window.location.href='/live-workout?user=${userId}'" class="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-fire ml-2"></i>
                        אימון חי
                    </button>
                    <button onclick="showWorkoutForm()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-plus ml-2"></i>
                        הוסף אימון
                    </button>
                    <button onclick="window.location.href='/plans?user=${userId}'" class="bg-green-600 hover:bg-green-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-list ml-2"></i>
                        תכניות
                    </button>
                    <button onclick="window.location.href='/settings?user=${userId}'" class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-cog ml-2"></i>
                        הגדרות
                    </button>
                </div>
            </div>

            <!-- Workout Form (Hidden) -->
            <div id="workoutFormContainer" class="hidden bg-white rounded-xl shadow-lg p-6 mb-8">
                <h3 class="text-xl font-bold text-gray-800 mb-4">רישום אימון חדש</h3>
                <form id="workoutForm" class="space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">תאריך אימון</label>
                            <input type="date" name="workout_date" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">זמן עבודה (דקות)</label>
                            <input type="number" step="0.1" name="work_minutes" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">מספר סטים</label>
                            <input type="number" name="sets_completed" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">עצימות</label>
                            <select name="intensity" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                                <option value="easy">קל</option>
                                <option value="medium">בינוני</option>
                                <option value="hard">קשה</option>
                            </select>
                        </div>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">הערות (אופציונלי)</label>
                        <textarea name="notes" rows="3" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"></textarea>
                    </div>
                    <div class="flex gap-4">
                        <button type="submit" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg">
                            <i class="fas fa-save ml-2"></i>
                            שמור אימון
                        </button>
                        <button type="button" onclick="hideWorkoutForm()" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg">
                            ביטול
                        </button>
                    </div>
                </form>
            </div>

            <!-- Recent Workouts -->
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h3 class="text-xl font-bold text-gray-800 mb-4">אימונים אחרונים</h3>
                <div id="recentWorkouts" class="space-y-3"></div>
            </div>
        </main>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
          const userId = ${userId};

          // Load dashboard data
          async function loadDashboard() {
            try {
              // Load user data
              const userResponse = await axios.get(\`/api/users/\${userId}\`)
              const userData = userResponse.data
              
              document.getElementById('userName').textContent = userData.user.name
              document.getElementById('currentWeight').textContent = userData.user.weight_kg + ' ק"ג'
              document.getElementById('targetWeight').textContent = userData.user.target_weight_kg + ' ק"ג'
              document.getElementById('remainingWeight').textContent = userData.progress.remaining_kg + ' ק"ג'
              document.getElementById('progressBar').style.width = userData.progress.progress_percentage + '%'
              document.getElementById('progressPercentage').textContent = userData.progress.progress_percentage + '% הושלם'
              document.getElementById('bmiValue').textContent = userData.bmi.bmi
              document.getElementById('bmiStatus').textContent = userData.bmi.status

              // Load stats
              const statsResponse = await axios.get(\`/api/workouts/user/\${userId}/stats\`)
              const stats = statsResponse.data
              
              document.getElementById('todayCalories').textContent = parseFloat(stats.today_calories).toFixed(2)
              document.getElementById('weeklyCalories').textContent = parseFloat(stats.weekly_calories).toFixed(2)
              document.getElementById('monthlyCalories').textContent = parseFloat(stats.monthly_calories).toFixed(2)
              document.getElementById('totalWorkouts').textContent = stats.total_workouts

              // Load recent workouts
              const workoutsResponse = await axios.get(\`/api/workouts/user/\${userId}\`)
              const workouts = workoutsResponse.data.workouts.slice(0, 5)
              
              const workoutsHtml = workouts.map(workout => \`
                <div class="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition cursor-pointer" onclick="window.location.href='/workout/\${workout.id}?user=\${userId}'">
                  <div class="flex items-center justify-between">
                    <div>
                      <span class="font-bold text-gray-800">\${workout.workout_date}</span>
                      <span class="text-gray-600 mr-4">\${workout.work_minutes.toFixed(2)} דקות</span>
                      <span class="text-gray-600">| עצימות: \${workout.intensity === 'easy' ? 'קל' : workout.intensity === 'medium' ? 'בינוני' : 'קשה'}</span>
                    </div>
                    <div class="flex items-center gap-3">
                      <div class="text-orange-500 font-bold">\${parseFloat(workout.calories_burned).toFixed(2)} קלוריות</div>
                      <i class="fas fa-chevron-left text-gray-400"></i>
                    </div>
                  </div>
                </div>
              \`).join('')
              
              document.getElementById('recentWorkouts').innerHTML = workoutsHtml || '<p class="text-gray-500 text-center">אין אימונים עדיין</p>'
              
              // Load weekly progress meter
              loadWeeklyProgress()
              
              // Load charts
              loadWeightChart()
              loadCaloriesChart()
            } catch (error) {
              console.error('Error loading dashboard:', error)
              alert('שגיאה בטעינת נתונים')
            }
          }

          async function loadWeeklyProgress() {
            try {
              const response = await axios.get(\`/api/workouts/user/\${userId}/week-progress\`)
              const data = response.data
              
              document.getElementById('weekCompleted').textContent = data.completed
              document.getElementById('weekTarget').textContent = data.target
              document.getElementById('weekRemaining').textContent = 
                data.remaining > 0 ? \`נותרו עוד \${data.remaining} אימונים השבוע\` : '🎉 השלמת את היעד השבועי!'
              
              const percentage = Math.min(100, (data.completed / data.target) * 100)
              document.getElementById('weekProgressBar').style.width = percentage + '%'
            } catch (error) {
              console.error('Error loading weekly progress:', error)
            }
          }

          async function loadWeightChart() {
            try {
              const response = await axios.get(\`/api/weight/user/\${userId}/chart\`)
              const data = response.data.data
              
              if (data.length === 0) {
                document.getElementById('weightChart').parentElement.innerHTML = 
                  '<p class="text-gray-500 text-center py-8">אין נתוני משקל זמינים</p>'
                return
              }
              
              const ctx = document.getElementById('weightChart').getContext('2d')
              new Chart(ctx, {
                type: 'line',
                data: {
                  labels: data.map(d => d.date),
                  datasets: [{
                    label: 'משקל (ק"ג)',
                    data: data.map(d => d.weight),
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    tension: 0.4,
                    fill: true
                  }]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: true,
                  plugins: {
                    legend: { display: false }
                  },
                  scales: {
                    y: {
                      beginAtZero: false,
                      ticks: {
                        callback: (value) => value + ' ק"ג'
                      }
                    }
                  }
                }
              })
            } catch (error) {
              console.error('Error loading weight chart:', error)
            }
          }

          async function loadCaloriesChart() {
            try {
              const response = await axios.get(\`/api/workouts/user/\${userId}/weekly-chart\`)
              const data = response.data.data
              
              // Create array of last 7 days
              const days = []
              const caloriesMap = {}
              data.forEach(d => { caloriesMap[d.date] = d.calories })
              
              for (let i = 6; i >= 0; i--) {
                const date = new Date()
                date.setDate(date.getDate() - i)
                const dateStr = date.toISOString().split('T')[0]
                days.push({
                  date: dateStr,
                  dayName: ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'][date.getDay()],
                  calories: caloriesMap[dateStr] || 0
                })
              }
              
              const ctx = document.getElementById('caloriesChart').getContext('2d')
              new Chart(ctx, {
                type: 'bar',
                data: {
                  labels: days.map(d => d.dayName),
                  datasets: [{
                    label: 'קלוריות',
                    data: days.map(d => d.calories),
                    backgroundColor: 'rgba(251, 146, 60, 0.8)',
                    borderColor: '#f59e0b',
                    borderWidth: 1
                  }]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: true,
                  plugins: {
                    legend: { display: false }
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                      ticks: {
                        callback: (value) => value + ' קלוריות'
                      }
                    }
                  }
                }
              })
            } catch (error) {
              console.error('Error loading calories chart:', error)
            }
          }

          function showWorkoutForm() {
            document.getElementById('workoutFormContainer').classList.remove('hidden')
            document.querySelector('input[name="workout_date"]').valueAsDate = new Date()
            window.scrollTo({ top: document.getElementById('workoutFormContainer').offsetTop - 100, behavior: 'smooth' })
          }

          function hideWorkoutForm() {
            document.getElementById('workoutFormContainer').classList.add('hidden')
            document.getElementById('workoutForm').reset()
          }

          // Handle workout form submission
          document.getElementById('workoutForm').addEventListener('submit', async (e) => {
            e.preventDefault()
            const formData = new FormData(e.target)
            const data = Object.fromEntries(formData)
            data.user_id = userId
            
            try {
              const response = await axios.post('/api/workouts', data)
              if (response.data.success) {
                alert(\`אימון נשמר! שרפת \${response.data.calories_burned} קלוריות\`)
                hideWorkoutForm()
                loadDashboard()
              }
            } catch (error) {
              alert('שגיאה בשמירת אימון: ' + (error.response?.data?.error || error.message))
            }
          })

          // Load dashboard on page load
          loadDashboard()
        </script>
    </body>
    </html>
  `)
})

/**
 * מסך תכניות אימון
 */
app.get('/plans', (c) => {
  const userId = c.req.query('user')
  
  if (!userId) {
    return c.redirect('/')
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>תכניות אימון - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    <a href="/dashboard?user=${userId}" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
                        <i class="fas fa-arrow-right ml-2"></i>
                        חזרה לדשבורד
                    </a>
                </div>
            </div>
        </header>

        <main class="max-w-7xl mx-auto px-4 py-8">
            <div id="plansContainer" class="grid grid-cols-1 md:grid-cols-2 gap-6"></div>
            
            <!-- Plan Details Modal -->
            <div id="planDetailsModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                <div class="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                    <div class="p-6">
                        <div class="flex items-center justify-between mb-6">
                            <h2 id="planDetailsTitle" class="text-2xl font-bold text-gray-800"></h2>
                            <button onclick="closePlanDetails()" class="text-gray-500 hover:text-gray-700">
                                <i class="fas fa-times text-2xl"></i>
                            </button>
                        </div>
                        <div id="planDetailsContent"></div>
                    </div>
                </div>
            </div>
        </main>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};

            async function loadPlans() {
                try {
                    const response = await axios.get('/api/plans')
                    const plans = response.data.plans
                    
                    const plansHtml = plans.map(plan => \`
                        <div class="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition duration-300">
                            <div class="flex items-start justify-between mb-4">
                                <div>
                                    <h3 class="text-xl font-bold text-gray-800 mb-2">\${plan.plan_name}</h3>
                                    <p class="text-gray-600 text-sm">\${plan.description}</p>
                                </div>
                                <span class="bg-indigo-100 text-indigo-800 text-xs font-semibold px-3 py-1 rounded-full">
                                    \${plan.level === 'beginner' ? 'מתחילים' : plan.level === 'intermediate' ? 'בינוני' : 'מתקדם'}
                                </span>
                            </div>
                            <div class="space-y-2 mb-4">
                                <div class="flex items-center text-gray-700">
                                    <i class="fas fa-calendar-week text-indigo-600 ml-2"></i>
                                    <span>\${plan.sessions_per_week} אימונים בשבוע</span>
                                </div>
                                <div class="flex items-center text-gray-700">
                                    <i class="fas fa-clock text-indigo-600 ml-2"></i>
                                    <span>\${plan.duration_weeks} שבועות</span>
                                </div>
                            </div>
                            <div class="flex gap-3">
                                <button onclick="viewPlanDetails(\${plan.id})" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition duration-300">
                                    <i class="fas fa-eye ml-2"></i>
                                    צפה בפרטים
                                </button>
                            </div>
                        </div>
                    \`).join('')
                    
                    document.getElementById('plansContainer').innerHTML = plansHtml
                } catch (error) {
                    alert('שגיאה בטעינת תכניות: ' + error.message)
                }
            }

            async function viewPlanDetails(planId) {
                try {
                    const response = await axios.get(\`/api/plans/\${planId}\`)
                    const plan = response.data.plan
                    const sessions = response.data.sessions
                    
                    // Group sessions by week
                    const sessionsByWeek = {}
                    sessions.forEach(session => {
                        if (!sessionsByWeek[session.week_number]) {
                            sessionsByWeek[session.week_number] = []
                        }
                        sessionsByWeek[session.week_number].push(session)
                    })
                    
                    let contentHtml = \`
                        <div class="mb-6">
                            <h3 class="text-lg font-bold text-gray-800 mb-2">תיאור התכנית</h3>
                            <p class="text-gray-600">\${plan.description}</p>
                        </div>
                        <div class="space-y-6">
                    \`
                    
                    Object.keys(sessionsByWeek).sort((a, b) => a - b).forEach(weekNum => {
                        const weekSessions = sessionsByWeek[weekNum]
                        contentHtml += \`
                            <div class="border border-gray-200 rounded-lg p-4">
                                <h4 class="font-bold text-gray-800 mb-3">שבוע \${weekNum}</h4>
                                <div class="space-y-2">
                        \`
                        
                        weekSessions.forEach(session => {
                            const totalMinutes = (session.work_seconds * session.sets_count + session.rest_seconds * (session.sets_count - 1)) / 60
                            contentHtml += \`
                                <div class="bg-gray-50 rounded p-3">
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="font-semibold text-gray-700">\${session.day_of_week} - אימון \${session.session_number}</span>
                                        <span class="text-sm text-gray-600">~\${Math.round(totalMinutes)} דקות</span>
                                    </div>
                                    <div class="text-sm text-gray-600 mb-3">
                                        <p>\${session.sets_count} סטים × \${session.work_seconds} שניות עבודה / \${session.rest_seconds} שניות מנוחה</p>
                                        <p class="mt-1">עצימות: \${session.intensity === 'easy' ? 'קל 💚' : session.intensity === 'medium' ? 'בינוני 💛' : 'קשה 🔥'}</p>
                                        \${session.notes ? \`<p class="mt-1 text-indigo-600">\${session.notes}</p>\` : ''}
                                    </div>
                                    <button onclick="startWorkoutTimer(\${session.id}, \${planId})" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 rounded-lg transition duration-300 flex items-center justify-center gap-2">
                                        <i class="fas fa-stopwatch"></i>
                                        התחל אימון עם טיימר
                                    </button>
                                </div>
                            \`
                        })
                        
                        contentHtml += \`
                                </div>
                            </div>
                        \`
                    })
                    
                    contentHtml += \`</div>\`
                    
                    document.getElementById('planDetailsTitle').textContent = plan.plan_name
                    document.getElementById('planDetailsContent').innerHTML = contentHtml
                    document.getElementById('planDetailsModal').classList.remove('hidden')
                } catch (error) {
                    alert('שגיאה בטעינת פרטי תכנית: ' + error.message)
                }
            }

            function closePlanDetails() {
                document.getElementById('planDetailsModal').classList.add('hidden')
            }

            function startWorkoutTimer(sessionId, planId) {
                window.location.href = \`/workout-timer?user=\${userId}&session=\${sessionId}&plan=\${planId}\`;
            }

            loadPlans()
        </script>
    </body>
    </html>
  `)
})

/**
 * מסך הגדרות משתמש
 */
app.get('/settings', (c) => {
  const userId = c.req.query('user')
  
  if (!userId) {
    return c.redirect('/')
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>הגדרות - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    <a href="/dashboard?user=${userId}" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
                        <i class="fas fa-arrow-right ml-2"></i>
                        חזרה לדשבורד
                    </a>
                </div>
            </div>
        </header>

        <main class="max-w-4xl mx-auto px-4 py-8">
            <!-- User Profile Card -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                <h2 class="text-xl font-bold text-gray-800 mb-4">פרופיל משתמש</h2>
                <form id="updateUserForm" class="space-y-4">
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">שם מלא</label>
                        <input type="text" name="name" id="name" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">גיל</label>
                            <input type="number" name="age" id="age" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">גובה (ס"מ)</label>
                            <input type="number" name="height_cm" id="height_cm" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">משקל נוכחי (ק"ג)</label>
                            <input type="number" step="0.1" name="weight_kg" id="weight_kg" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">משקל יעד (ק"ג)</label>
                            <input type="number" step="0.1" name="target_weight_kg" id="target_weight_kg" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">כמות אימונים בשבוע</label>
                        <select name="workouts_per_week" id="workouts_per_week" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                            <option value="3">3 אימונים בשבוע</option>
                            <option value="4">4 אימונים בשבוע</option>
                            <option value="5">5 אימונים בשבוע</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">רמת כושר</label>
                        <select name="current_level" id="current_level" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                            <option value="beginner">מתחילים</option>
                            <option value="intermediate">בינוני</option>
                            <option value="advanced">מתקדם</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">עצימות מועדפת</label>
                        <select name="preferred_intensity" id="preferred_intensity" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500">
                            <option value="easy">קל</option>
                            <option value="medium">בינוני</option>
                            <option value="hard">קשה</option>
                        </select>
                    </div>
                    <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition duration-300">
                        <i class="fas fa-save ml-2"></i>
                        שמור שינויים
                    </button>
                </form>
            </div>

            <!-- Weight Update Card -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                <h2 class="text-xl font-bold text-gray-800 mb-4">עדכון משקל</h2>
                <form id="updateWeightForm" class="space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">משקל חדש (ק"ג)</label>
                            <input type="number" step="0.1" name="new_weight" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">תאריך מדידה</label>
                            <input type="date" name="measurement_date" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500">
                        </div>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">הערות (אופציונלי)</label>
                        <textarea name="notes" rows="2" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"></textarea>
                    </div>
                    <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition duration-300">
                        <i class="fas fa-weight ml-2"></i>
                        עדכן משקל
                    </button>
                </form>
            </div>

            <!-- Weight History -->
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h2 class="text-xl font-bold text-gray-800 mb-4">היסטוריית משקל</h2>
                <div id="weightHistory" class="space-y-2"></div>
            </div>
        </main>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};

            async function loadUserData() {
                try {
                    const response = await axios.get(\`/api/users/\${userId}\`)
                    const user = response.data.user
                    
                    document.getElementById('name').value = user.name
                    document.getElementById('age').value = user.age
                    document.getElementById('height_cm').value = user.height_cm
                    document.getElementById('weight_kg').value = user.weight_kg
                    document.getElementById('target_weight_kg').value = user.target_weight_kg
                    document.getElementById('workouts_per_week').value = user.workouts_per_week
                    document.getElementById('current_level').value = user.current_level
                    document.getElementById('preferred_intensity').value = user.preferred_intensity
                } catch (error) {
                    alert('שגיאה בטעינת נתונים')
                }
            }

            async function loadWeightHistory() {
                try {
                    const response = await axios.get(\`/api/weight/user/\${userId}\`)
                    const history = response.data.weight_history
                    
                    const historyHtml = history.map(record => \`
                        <div class="border border-gray-200 rounded-lg p-3">
                            <div class="flex items-center justify-between">
                                <div>
                                    <span class="font-bold text-gray-800">\${record.weight_kg} ק"ג</span>
                                    <span class="text-gray-600 mr-4">\${record.measurement_date}</span>
                                </div>
                                \${record.notes ? \`<span class="text-sm text-gray-500">\${record.notes}</span>\` : ''}
                            </div>
                        </div>
                    \`).join('')
                    
                    document.getElementById('weightHistory').innerHTML = historyHtml || '<p class="text-gray-500 text-center">אין רשומות עדיין</p>'
                } catch (error) {
                    console.error('Error loading weight history:', error)
                }
            }

            document.getElementById('updateUserForm').addEventListener('submit', async (e) => {
                e.preventDefault()
                const formData = new FormData(e.target)
                const data = Object.fromEntries(formData)
                
                try {
                    await axios.put(\`/api/users/\${userId}\`, data)
                    alert('הפרופיל עודכן בהצלחה!')
                    loadWeightHistory()
                } catch (error) {
                    alert('שגיאה בעדכון פרופיל: ' + (error.response?.data?.error || error.message))
                }
            })

            document.getElementById('updateWeightForm').addEventListener('submit', async (e) => {
                e.preventDefault()
                const formData = new FormData(e.target)
                const new_weight = formData.get('new_weight')
                
                try {
                    await axios.put(\`/api/users/\${userId}\`, { weight_kg: new_weight })
                    alert('המשקל עודכן בהצלחה!')
                    e.target.reset()
                    loadUserData()
                    loadWeightHistory()
                } catch (error) {
                    alert('שגיאה בעדכון משקל: ' + (error.response?.data?.error || error.message))
                }
            })

            // Set today's date as default
            document.querySelector('input[name="measurement_date"]').valueAsDate = new Date()

            loadUserData()
            loadWeightHistory()
        </script>
    </body>
    </html>
  `)
})

/**
 * מסך טיימר אימון - Redirect to static HTML
 */
app.get('/workout-timer', (c) => {
  return c.redirect('/static/workout-timer.html' + '?' + c.req.url.split('?')[1])
})

/**
 * מסך פרטי אימון
 */
app.get('/workout/:id', async (c) => {
  const userId = c.req.query('user')
  const workoutId = c.req.param('id')
  
  if (!userId) {
    return c.redirect('/')
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>פרטי אימון - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    <a href="/dashboard?user=${userId}" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
                        <i class="fas fa-arrow-right ml-2"></i>
                        חזרה לדשבורד
                    </a>
                </div>
            </div>
        </header>

        <main class="max-w-4xl mx-auto px-4 py-8">
            <!-- Workout Details Card -->
            <div id="workoutCard" class="bg-white rounded-xl shadow-lg p-6 mb-6"></div>

            <!-- Charts -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">פילוח זמן</h3>
                    <canvas id="timeChart"></canvas>
                </div>
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">השוואה לממוצע</h3>
                    <canvas id="comparisonChart"></canvas>
                </div>
            </div>

            <!-- Actions -->
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h3 class="text-xl font-bold text-gray-800 mb-4">פעולות</h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <button onclick="editWorkout()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg">
                        <i class="fas fa-edit ml-2"></i>
                        ערוך אימון
                    </button>
                    <button onclick="deleteWorkout()" class="bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg">
                        <i class="fas fa-trash ml-2"></i>
                        מחק אימון
                    </button>
                    <button onclick="duplicateWorkout()" class="bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg">
                        <i class="fas fa-copy ml-2"></i>
                        שכפל אימון
                    </button>
                </div>
            </div>
        </main>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};
            const workoutId = ${workoutId};
            let workoutData = null;

            async function loadWorkoutDetails() {
                try {
                    // Get workout data
                    const response = await axios.get(\`/api/workouts/user/\${userId}\`);
                    workoutData = response.data.workouts.find(w => w.id == workoutId);
                    
                    if (!workoutData) {
                        alert('אימון לא נמצא');
                        window.location.href = '/dashboard?user=' + userId;
                        return;
                    }

                    // Get user stats for comparison
                    const statsResponse = await axios.get(\`/api/workouts/user/\${userId}/stats\`);
                    const stats = statsResponse.data;

                    displayWorkoutDetails(workoutData, stats);
                    createCharts(workoutData, stats);
                } catch (error) {
                    console.error('Error loading workout:', error);
                    alert('שגיאה בטעינת פרטי אימון');
                }
            }

            function displayWorkoutDetails(workout, stats) {
                const intensityText = workout.intensity === 'easy' ? 'קל 💚' : 
                                      workout.intensity === 'medium' ? 'בינוני 💛' : 'קשה 🔥';
                
                const html = \`
                    <div class="space-y-6">
                        <div class="border-b pb-4">
                            <h2 class="text-3xl font-bold text-gray-800 mb-2">
                                אימון מתאריך \${workout.workout_date}
                            </h2>
                            <p class="text-gray-600">נוצר ב-\${new Date(workout.created_at).toLocaleString('he-IL')}</p>
                        </div>

                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div class="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-lg p-4">
                                <div class="text-sm text-indigo-600 mb-1">זמן עבודה</div>
                                <div class="text-3xl font-bold text-indigo-700">\${workout.work_minutes}</div>
                                <div class="text-xs text-indigo-600">דקות</div>
                            </div>

                            <div class="bg-gradient-to-br from-orange-50 to-orange-100 rounded-lg p-4">
                                <div class="text-sm text-orange-600 mb-1">קלוריות</div>
                                <div class="text-3xl font-bold text-orange-700">\${parseFloat(workout.calories_burned).toFixed(2)}</div>
                                <div class="text-xs text-orange-600">נשרפו</div>
                            </div>

                            <div class="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4">
                                <div class="text-sm text-green-600 mb-1">סטים</div>
                                <div class="text-3xl font-bold text-green-700">\${workout.sets_completed || 0}</div>
                                <div class="text-xs text-green-600">הושלמו</div>
                            </div>

                            <div class="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4">
                                <div class="text-sm text-purple-600 mb-1">עצימות</div>
                                <div class="text-2xl font-bold text-purple-700">\${intensityText}</div>
                            </div>
                        </div>

                        \${workout.notes ? \`
                            <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                                <div class="flex items-start gap-3">
                                    <i class="fas fa-sticky-note text-yellow-600 text-xl mt-1"></i>
                                    <div>
                                        <h4 class="font-bold text-gray-800 mb-1">הערות</h4>
                                        <p class="text-gray-700">\${workout.notes}</p>
                                    </div>
                                </div>
                            </div>
                        \` : ''}

                        <div class="bg-gray-50 rounded-lg p-4">
                            <h4 class="font-bold text-gray-800 mb-3">סטטיסטיקות נוספות</h4>
                            <div class="space-y-2 text-sm">
                                <div class="flex justify-between">
                                    <span class="text-gray-600">קלוריות לדקה</span>
                                    <span class="font-bold text-gray-800">\${(workout.calories_burned / workout.work_minutes).toFixed(2)}</span>
                                </div>
                                <div class="flex justify-between">
                                    <span class="text-gray-600">מעל/מתחת לממוצע</span>
                                    <span class="font-bold \${workout.calories_burned > stats.avg_calories_per_workout ? 'text-green-600' : 'text-orange-600'}">
                                        \${workout.calories_burned > stats.avg_calories_per_workout ? '+' : ''}\${Math.round(workout.calories_burned - stats.avg_calories_per_workout)}
                                    </span>
                                </div>
                                <div class="flex justify-between">
                                    <span class="text-gray-600">מספר אימון</span>
                                    <span class="font-bold text-gray-800">#\${workout.id}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;

                document.getElementById('workoutCard').innerHTML = html;
            }

            function createCharts(workout, stats) {
                // Time breakdown chart
                const workSeconds = workout.work_minutes * 60;
                const totalSessionTime = workout.sets_completed > 0 ? 
                    (workout.work_minutes * 60 + (workout.sets_completed - 1) * 30) : workSeconds; // Assume 30s rest
                const restSeconds = totalSessionTime - workSeconds;

                new Chart(document.getElementById('timeChart'), {
                    type: 'doughnut',
                    data: {
                        labels: ['זמן קפיצה', 'זמן מנוחה'],
                        datasets: [{
                            data: [workSeconds, restSeconds],
                            backgroundColor: ['#667eea', '#f093fb']
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            legend: {
                                position: 'bottom'
                            }
                        }
                    }
                });

                // Comparison chart
                new Chart(document.getElementById('comparisonChart'), {
                    type: 'bar',
                    data: {
                        labels: ['אימון זה', 'ממוצע כללי'],
                        datasets: [{
                            label: 'קלוריות',
                            data: [workout.calories_burned, stats.avg_calories_per_workout],
                            backgroundColor: ['#667eea', '#f093fb']
                        }]
                    },
                    options: {
                        responsive: true,
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        },
                        plugins: {
                            legend: {
                                display: false
                            }
                        }
                    }
                });
            }

            function editWorkout() {
                if (!workoutData) return;
                
                // Create edit form
                const editFormHtml = \`
                    <div class="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                        <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                            <h3 class="text-2xl font-bold text-gray-800 mb-4">ערוך אימון</h3>
                            <form id="editWorkoutForm" class="space-y-4">
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">תאריך אימון</label>
                                    <input type="date" name="workout_date" value="\${workoutData.workout_date}" required class="w-full px-4 py-2 border border-gray-300 rounded-lg">
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">זמן עבודה (דקות)</label>
                                    <input type="number" step="0.1" name="work_minutes" value="\${workoutData.work_minutes}" required class="w-full px-4 py-2 border border-gray-300 rounded-lg">
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">מספר סטים</label>
                                    <input type="number" name="sets_completed" value="\${workoutData.sets_completed || 0}" class="w-full px-4 py-2 border border-gray-300 rounded-lg">
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">עצימות</label>
                                    <select name="intensity" class="w-full px-4 py-2 border border-gray-300 rounded-lg">
                                        <option value="easy" \${workoutData.intensity === 'easy' ? 'selected' : ''}>קל</option>
                                        <option value="medium" \${workoutData.intensity === 'medium' ? 'selected' : ''}>בינוני</option>
                                        <option value="hard" \${workoutData.intensity === 'hard' ? 'selected' : ''}>קשה</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">הערות</label>
                                    <textarea name="notes" rows="3" class="w-full px-4 py-2 border border-gray-300 rounded-lg">\${workoutData.notes || ''}</textarea>
                                </div>
                                <div class="flex gap-3">
                                    <button type="submit" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg">
                                        <i class="fas fa-save ml-2"></i>
                                        שמור שינויים
                                    </button>
                                    <button type="button" onclick="closeEditForm()" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg">
                                        ביטול
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                \`;
                
                document.body.insertAdjacentHTML('beforeend', editFormHtml);
                
                // Handle form submission
                document.getElementById('editWorkoutForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const data = Object.fromEntries(formData);
                    
                    try {
                        await axios.put(\`/api/workouts/\${workoutId}\`, data);
                        alert('האימון עודכן בהצלחה!');
                        window.location.reload();
                    } catch (error) {
                        alert('שגיאה בעדכון אימון: ' + (error.response?.data?.error || error.message));
                    }
                });
            }
            
            function closeEditForm() {
                const form = document.querySelector('.fixed.inset-0');
                if (form) form.remove();
            }

            async function deleteWorkout() {
                if (!confirm('האם אתה בטוח שברצונך למחוק אימון זה? פעולה זו אינה הפיכה.')) {
                    return;
                }

                try {
                    await axios.delete(\`/api/workouts/\${workoutId}\`);
                    alert('אימון נמחק בהצלחה');
                    window.location.href = '/dashboard?user=' + userId;
                } catch (error) {
                    alert('שגיאה במחיקת אימון: ' + (error.response?.data?.error || error.message));
                }
            }

            async function duplicateWorkout() {
                if (!confirm('האם ברצונך לשכפל אימון זה להיום?')) {
                    return;
                }

                try {
                    const response = await axios.post(\`/api/workouts/\${workoutId}/duplicate\`);
                    if (response.data.success) {
                        alert('אימון שוכפל בהצלחה! מעבר לדשבורד...');
                        window.location.href = '/dashboard?user=' + userId;
                    }
                } catch (error) {
                    alert('שגיאה בשכפול אימון: ' + (error.response?.data?.error || error.message));
                }
            }

            loadWorkoutDetails();
        </script>
    </body>
    </html>
  `)
})

/**
 * מסך אימון חי (Live Workout)
 * טיימר אינטראקטיבי עם שמירה אוטומטית
 */
app.get('/live-workout', (c) => {
  const userId = c.req.query('user')
  
  if (!userId) {
    return c.redirect('/')
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>אימון חי - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
          .timer-display { font-size: 5rem; font-weight: bold; }
          @media (max-width: 640px) {
            .timer-display { font-size: 3.5rem; }
          }
          .pulse {
            animation: pulse 1s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
          }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    <a href="/dashboard?user=${userId}" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg text-sm sm:text-base">
                        <i class="fas fa-arrow-right ml-2"></i>
                        חזרה
                    </a>
                </div>
            </div>
        </header>

        <main class="max-w-4xl mx-auto px-4 py-8">
            <!-- Setup Phase -->
            <div id="setupPhase" class="bg-white rounded-xl shadow-lg p-6 sm:p-8">
                <h2 class="text-2xl sm:text-3xl font-bold text-gray-800 mb-6 text-center">
                    <i class="fas fa-fire text-orange-500 ml-2"></i>
                    הגדרות אימון
                </h2>
                
                <form id="setupForm" class="space-y-4 sm:space-y-6">
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-lg">עצימות</label>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                            <button type="button" onclick="selectIntensity('easy')" class="intensity-btn py-4 sm:py-6 px-4 border-2 rounded-lg font-bold text-lg sm:text-xl transition hover:scale-105" data-intensity="easy">
                                💚 קל
                            </button>
                            <button type="button" onclick="selectIntensity('medium')" class="intensity-btn py-4 sm:py-6 px-4 border-2 rounded-lg font-bold text-lg sm:text-xl transition hover:scale-105 border-indigo-500 bg-indigo-50" data-intensity="medium">
                                💛 בינוני
                            </button>
                            <button type="button" onclick="selectIntensity('hard')" class="intensity-btn py-4 sm:py-6 px-4 border-2 rounded-lg font-bold text-lg sm:text-xl transition hover:scale-105" data-intensity="hard">
                                🔥 קשה
                            </button>
                        </div>
                    </div>

                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-lg">זמן מטרה (דקות)</label>
                        <input type="number" id="targetMinutes" min="1" max="60" value="10" class="w-full px-4 py-3 sm:py-4 border border-gray-300 rounded-lg text-lg sm:text-xl text-center focus:ring-2 focus:ring-indigo-500">
                    </div>

                    <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 sm:py-6 rounded-lg text-xl sm:text-2xl transition duration-300 hover:scale-105">
                        <i class="fas fa-play ml-2"></i>
                        התחל אימון
                    </button>
                </form>
            </div>

            <!-- Workout Phase -->
            <div id="workoutPhase" class="hidden">
                <div class="bg-white rounded-xl shadow-lg p-6 sm:p-8 mb-6">
                    <div class="text-center mb-6 sm:mb-8">
                        <div class="timer-display text-indigo-600" id="timerDisplay">00:00</div>
                        <div class="text-gray-600 text-lg sm:text-xl mb-4" id="statusText">מוכן להתחיל</div>
                        <div class="text-sm sm:text-base text-gray-500" id="intensityDisplay"></div>
                    </div>

                    <div class="flex gap-3 sm:gap-4 justify-center mb-6">
                        <button id="startBtn" onclick="startTimer()" class="bg-green-600 hover:bg-green-700 text-white font-bold py-3 sm:py-4 px-6 sm:px-8 rounded-lg text-base sm:text-lg">
                            <i class="fas fa-play ml-2"></i>
                            התחל
                        </button>
                        <button id="pauseBtn" onclick="pauseTimer()" class="hidden bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-3 sm:py-4 px-6 sm:px-8 rounded-lg text-base sm:text-lg">
                            <i class="fas fa-pause ml-2"></i>
                            השהה
                        </button>
                        <button id="stopBtn" onclick="stopTimer()" class="bg-red-600 hover:bg-red-700 text-white font-bold py-3 sm:py-4 px-6 sm:px-8 rounded-lg text-base sm:text-lg">
                            <i class="fas fa-stop ml-2"></i>
                            עצור
                        </button>
                    </div>

                    <div class="bg-gradient-to-r from-indigo-100 to-purple-100 rounded-lg p-4 sm:p-6">
                        <div class="flex justify-between items-center mb-2">
                            <span class="text-gray-700 font-bold text-sm sm:text-base">קלוריות שנשרפו</span>
                            <span class="text-2xl sm:text-3xl font-bold text-orange-600" id="caloriesDisplay">0</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="text-gray-700 font-bold text-sm sm:text-base">יעד</span>
                            <span class="text-lg sm:text-xl text-gray-600" id="targetDisplay">10:00</span>
                        </div>
                    </div>
                </div>

                <!-- Summary Phase -->
                <div id="summaryPhase" class="hidden bg-white rounded-xl shadow-lg p-6 sm:p-8">
                    <h2 class="text-2xl sm:text-3xl font-bold text-green-600 mb-6 text-center">
                        <i class="fas fa-check-circle ml-2"></i>
                        אימון הושלם!
                    </h2>

                    <div class="grid grid-cols-2 gap-4 mb-6">
                        <div class="bg-indigo-50 rounded-lg p-4 text-center">
                            <div class="text-gray-600 text-sm mb-1">זמן כולל</div>
                            <div class="text-2xl font-bold text-indigo-600" id="summaryTime">0:00</div>
                        </div>
                        <div class="bg-orange-50 rounded-lg p-4 text-center">
                            <div class="text-gray-600 text-sm mb-1">קלוריות</div>
                            <div class="text-2xl font-bold text-orange-600" id="summaryCalories">0</div>
                        </div>
                    </div>

                    <div class="mb-6">
                        <label class="block text-gray-700 font-bold mb-2">הערות (אופציונלי)</label>
                        <textarea id="workoutNotes" rows="3" class="w-full px-4 py-3 border border-gray-300 rounded-lg" placeholder="איך הרגשת? הערות נוספות..."></textarea>
                    </div>

                    <div class="flex gap-3 sm:gap-4">
                        <button onclick="saveWorkout()" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-lg text-base sm:text-lg">
                            <i class="fas fa-save ml-2"></i>
                            שמור אימון
                        </button>
                        <button onclick="cancelWorkout()" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-4 px-6 rounded-lg text-base sm:text-lg">
                            ביטול
                        </button>
                    </div>
                </div>
            </div>
        </main>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};
            let selectedIntensity = 'medium';
            let targetSeconds = 0;
            let elapsedSeconds = 0;
            let timerInterval = null;
            let isPaused = false;
            let userWeight = 0;

            // Load user data
            async function loadUserData() {
                try {
                    const response = await axios.get(\`/api/users/\${userId}\`);
                    userWeight = response.data.user.weight_kg;
                } catch (error) {
                    console.error('Error loading user:', error);
                }
            }

            function selectIntensity(intensity) {
                selectedIntensity = intensity;
                document.querySelectorAll('.intensity-btn').forEach(btn => {
                    btn.classList.remove('border-indigo-500', 'bg-indigo-50');
                    if (btn.dataset.intensity === intensity) {
                        btn.classList.add('border-indigo-500', 'bg-indigo-50');
                    }
                });
            }

            document.getElementById('setupForm').addEventListener('submit', (e) => {
                e.preventDefault();
                const minutes = parseInt(document.getElementById('targetMinutes').value);
                targetSeconds = minutes * 60;
                
                document.getElementById('setupPhase').classList.add('hidden');
                document.getElementById('workoutPhase').classList.remove('hidden');
                document.getElementById('targetDisplay').textContent = \`\${minutes}:00\`;
                document.getElementById('intensityDisplay').textContent = \`עצימות: \${selectedIntensity === 'easy' ? 'קל 💚' : selectedIntensity === 'medium' ? 'בינוני 💛' : 'קשה 🔥'}\`;
            });

            function startTimer() {
                if (timerInterval) return;
                
                isPaused = false;
                document.getElementById('startBtn').classList.add('hidden');
                document.getElementById('pauseBtn').classList.remove('hidden');
                document.getElementById('statusText').textContent = 'קופץ!';
                document.getElementById('statusText').classList.add('pulse');

                timerInterval = setInterval(() => {
                    elapsedSeconds++;
                    updateDisplay();
                    
                    if (elapsedSeconds >= targetSeconds) {
                        completeWorkout();
                    }
                }, 1000);
            }

            function pauseTimer() {
                isPaused = true;
                clearInterval(timerInterval);
                timerInterval = null;
                document.getElementById('startBtn').classList.remove('hidden');
                document.getElementById('pauseBtn').classList.add('hidden');
                document.getElementById('statusText').textContent = 'מושהה';
                document.getElementById('statusText').classList.remove('pulse');
            }

            function stopTimer() {
                if (confirm('האם אתה בטוח שברצונך לעצור? התקדמותך תישמר.')) {
                    completeWorkout();
                }
            }

            function updateDisplay() {
                const minutes = Math.floor(elapsedSeconds / 60);
                const seconds = elapsedSeconds % 60;
                document.getElementById('timerDisplay').textContent = \`\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
                
                // Calculate calories
                const MET = selectedIntensity === 'easy' ? 8.8 : selectedIntensity === 'medium' ? 11.8 : 12.3;
                const caloriesPerMin = 0.0175 * MET * userWeight;
                const totalCalories = (caloriesPerMin * elapsedSeconds / 60).toFixed(2);
                document.getElementById('caloriesDisplay').textContent = totalCalories;
            }

            function completeWorkout() {
                clearInterval(timerInterval);
                timerInterval = null;
                document.getElementById('workoutPhase').querySelector('.bg-white').classList.add('hidden');
                document.getElementById('summaryPhase').classList.remove('hidden');
                
                const minutes = Math.floor(elapsedSeconds / 60);
                const seconds = elapsedSeconds % 60;
                document.getElementById('summaryTime').textContent = \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
                document.getElementById('summaryCalories').textContent = document.getElementById('caloriesDisplay').textContent;
            }

            async function saveWorkout() {
                const notes = document.getElementById('workoutNotes').value;
                const workMinutes = elapsedSeconds / 60;
                const MET = selectedIntensity === 'easy' ? 8.8 : selectedIntensity === 'medium' ? 11.8 : 12.3;
                const calories = 0.0175 * MET * userWeight * workMinutes;
                
                try {
                    await axios.post('/api/workouts', {
                        user_id: userId,
                        workout_date: new Date().toISOString().split('T')[0],
                        work_minutes: workMinutes.toFixed(2),
                        sets_completed: 1,
                        intensity: selectedIntensity,
                        calories_burned: calories.toFixed(2),
                        notes: notes || 'אימון חי - JumpFitPro'
                    });
                    
                    alert('אימון נשמר בהצלחה! 🎉');
                    window.location.href = '/dashboard?user=' + userId;
                } catch (error) {
                    alert('שגיאה בשמירת אימון: ' + (error.response?.data?.error || error.message));
                }
            }

            function cancelWorkout() {
                if (confirm('האם אתה בטוח? האימון לא יישמר.')) {
                    window.location.href = '/dashboard?user=' + userId;
                }
            }

            loadUserData();
        </script>
    </body>
    </html>
  `)
})

export default app
