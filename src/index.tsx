import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { calculateCalories, calculateCalorieSummary, calculateBMI, calculateWeightProgress, INTENSITY_LEVELS } from './utils/calories'

type Bindings = {
  DB: D1Database;
  OPENAI_API_KEY: string;
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
    const { name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity, email, phone } = body

    // Validation
    if (!name || !age || !height_cm || !weight_kg || !target_weight_kg) {
      return c.json({ error: 'חסרים שדות חובה' }, 400)
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO users (name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      name,
      age,
      gender || 'male',
      height_cm,
      weight_kg,
      target_weight_kg,
      workouts_per_week || 3,
      current_level || 'beginner',
      preferred_intensity || 'medium',
      email || null,
      phone || null
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

    // החזרה עם כל הנתונים
    return c.json({ 
      user: {
        ...user,
        bmi,
        progress
      }
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
    
    // בניית השדות לעדכון דינמית
    const updates: string[] = []
    const values: any[] = []
    
    if (body.name !== undefined) {
      updates.push('name = ?')
      values.push(body.name)
    }
    if (body.age !== undefined) {
      updates.push('age = ?')
      values.push(body.age)
    }
    if (body.gender !== undefined) {
      updates.push('gender = ?')
      values.push(body.gender)
    }
    if (body.height_cm !== undefined) {
      updates.push('height_cm = ?')
      values.push(body.height_cm)
    }
    if (body.weight_kg !== undefined) {
      updates.push('weight_kg = ?')
      values.push(body.weight_kg)
      
      // אם המשקל השתנה, נוסיף רשומה לטבלת מעקב משקל
      const currentUser = await c.env.DB.prepare(`SELECT weight_kg FROM users WHERE id = ?`).bind(userId).first()
      if (currentUser && currentUser.weight_kg !== body.weight_kg) {
        await c.env.DB.prepare(`
          INSERT INTO weight_tracking (user_id, weight_kg, measurement_date, notes)
          VALUES (?, ?, date('now'), ?)
        `).bind(userId, body.weight_kg, 'עדכון משקל').run()
      }
    }
    if (body.target_weight_kg !== undefined) {
      updates.push('target_weight_kg = ?')
      values.push(body.target_weight_kg)
    }
    if (body.workouts_per_week !== undefined) {
      updates.push('workouts_per_week = ?')
      values.push(body.workouts_per_week)
    }
    if (body.current_level !== undefined) {
      updates.push('current_level = ?')
      values.push(body.current_level)
    }
    if (body.email !== undefined) {
      updates.push('email = ?')
      values.push(body.email)
    }
    if (body.phone !== undefined) {
      updates.push('phone = ?')
      values.push(body.phone)
    }
    
    if (updates.length === 0) {
      return c.json({ error: 'אין נתונים לעדכון' }, 400)
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP')
    values.push(userId)
    
    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    await c.env.DB.prepare(query).bind(...values).run()

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
 * שחזור משתמש שנמחק (Soft Delete)
 */
app.patch('/api/users/:id/restore', async (c) => {
  try {
    const userId = c.req.param('id')
    
    await c.env.DB.prepare(`
      UPDATE users SET is_deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(userId).run()
    
    return c.json({ success: true, message: 'משתמש שוחזר בהצלחה' })
  } catch (error) {
    return c.json({ error: 'שגיאה בשחזור משתמש', details: String(error) }, 500)
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
  return c.json({ 
    levels: INTENSITY_LEVELS,
    count: Object.keys(INTENSITY_LEVELS).length
  })
})

// ========================================
// API Routes - תזונה (Nutrition)
// ========================================

/**
 * Chat with Nutrition GPT
 * This endpoint will connect to your custom GPT
 */
app.post('/api/nutrition/chat', async (c) => {
  try {
    const body = await c.req.json()
    const { message, userId, history } = body

    if (!message) {
      return c.json({ error: 'הודעה ריקה' }, 400)
    }

    // TODO: Get OpenAI API key from environment variables
    // For now, return a placeholder response
    // You need to add OPENAI_API_KEY to your wrangler.jsonc secrets
    
    const OPENAI_API_KEY = c.env.OPENAI_API_KEY || ''
    
    if (!OPENAI_API_KEY) {
      return c.json({ 
        response: '⚠️ מערכת התזונה עדיין בהקמה. בינתיים, אתה יכול לשאול שאלות ואני אענה עליהן ברגע שה-API Key יוגדר.\\n\\nכדי להפעיל את המערכת:\\n1. קבל OpenAI API Key\\n2. הוסף אותו ל-wrangler secrets\\n3. חבר את ה-GPT ID שלך'
      })
    }

    // Get user data for context
    const user = await c.env.DB.prepare(`
      SELECT name, age, gender, weight_kg, target_weight_kg, height_cm, current_level
      FROM users WHERE id = ?
    `).bind(userId).first()

    // Build context for GPT
    const userGender = user?.gender === 'male' ? 'זכר' : 'נקבה'
    const systemMessage = `אתה מומחה תזונה ישראלי. המשתמש שלך הוא ${user?.name || 'משתמש'}:
- גיל: ${user?.age || 'לא ידוע'}
- מין: ${userGender}
- משקל נוכחי: ${user?.weight_kg || 'לא ידוע'} ק"ג
- משקל יעד: ${user?.target_weight_kg || 'לא ידוע'} ק"ג
- רמת כושר: ${user?.current_level || 'לא ידוע'}

תן המלצות מותאמות אישית, מתכונים בעברית, וחשב קלוריות כשצריך.
השתמש בשפה חמימה וידידותית.`

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4', // or your GPT model
        messages: [
          { role: 'system', content: systemMessage },
          ...(history || []),
          { role: 'user', content: message }
        ],
        temperature: 0.7,
        max_tokens: 1000
      })
    })

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`)
    }

    const data = await response.json()
    const gptResponse = data.choices[0]?.message?.content || 'לא הצלחתי לקבל תשובה'

    return c.json({ 
      success: true,
      response: gptResponse
    })
  } catch (error) {
    console.error('Nutrition chat error:', error)
    const errorMsg = String(error)
    return c.json({ 
      response: `מצטער, אירעה שגיאה בהתקשרות למערכת התזונה. \n\nהשגיאה: ${errorMsg}\n\nאנא נסה שוב מאוחר יותר.`
    })
  }
})

// ========================================
// API Routes - אימות (Authentication)
// ========================================

/**
 * הרשמת משתמש חדש
 */
app.post('/api/auth/register', async (c) => {
  try {
    const body = await c.req.json()
    const { email, password, name, age, height_cm, weight_kg, target_weight_kg, gender, workouts_per_week, current_level } = body
    
    if (!email || !password || !name) {
      return c.json({ error: 'חובה למלא: מייל, סיסמה ושם מלא' }, 400)
    }
    
    // Check if email already exists
    const existingUser = await c.env.DB.prepare(`
      SELECT id FROM users WHERE email = ?
    `).bind(email).first()
    
    if (existingUser) {
      return c.json({ error: 'המייל כבר רשום במערכת' }, 409)
    }
    
    // Hash password (simple for now - in production use bcrypt)
    const passwordHash = btoa(password) // Base64 encoding (replace with proper hashing in production)
    
    // Create user
    const result = await c.env.DB.prepare(`
      INSERT INTO users (
        email, password_hash, name, age, height_cm, weight_kg, target_weight_kg, 
        gender, workouts_per_week, current_level, role, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 1)
    `).bind(
      email, passwordHash, name, 
      age || 25, height_cm || 170, weight_kg || 70, target_weight_kg || 65,
      gender || 'male', workouts_per_week || 3, current_level || 'beginner'
    ).run()
    
    const userId = result.meta.last_row_id
    
    // Create session
    const sessionToken = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    
    await c.env.DB.prepare(`
      INSERT INTO user_sessions (user_id, session_token, expires_at)
      VALUES (?, ?, ?)
    `).bind(userId, sessionToken, expiresAt.toISOString()).run()
    
    return c.json({ 
      success: true, 
      message: 'הרשמה הושלמה בהצלחה!',
      user_id: userId,
      session_token: sessionToken,
      name: name
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בהרשמה', details: String(error) }, 500)
  }
})

/**
 * הרשמה ראשונית מהירה (מייל + סיסמה בלבד)
 */
app.post('/api/auth/quick-register', async (c) => {
  try {
    const body = await c.req.json()
    const { email, password } = body
    
    if (!email || !password) {
      return c.json({ error: 'חובה למלא מייל וסיסמה' }, 400)
    }
    
    if (password.length < 6) {
      return c.json({ error: 'הסיסמה חייבת להיות לפחות 6 תווים' }, 400)
    }
    
    // Check if email already exists
    const existingUser = await c.env.DB.prepare(`
      SELECT id FROM users WHERE email = ?
    `).bind(email).first()
    
    if (existingUser) {
      return c.json({ error: 'המייל כבר רשום במערכת' }, 409)
    }
    
    // Hash password
    const passwordHash = btoa(password)
    
    // Create user with minimal data
    const result = await c.env.DB.prepare(`
      INSERT INTO users (
        email, password_hash, name, age, height_cm, weight_kg, target_weight_kg, 
        gender, workouts_per_week, current_level, role, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 1)
    `).bind(
      email, passwordHash, 'משתמש חדש', // שם זמני
      25, 170, 70, 65, // ערכי ברירת מחדל
      'male', 3, 'beginner'
    ).run()
    
    const userId = result.meta.last_row_id
    
    // Create session
    const sessionToken = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    
    await c.env.DB.prepare(`
      INSERT INTO user_sessions (user_id, session_token, expires_at)
      VALUES (?, ?, ?)
    `).bind(userId, sessionToken, expiresAt.toISOString()).run()
    
    return c.json({ 
      success: true, 
      message: 'הרשמה הושלמה! עכשיו בואו נשלים את הפרופיל',
      user_id: userId,
      session_token: sessionToken,
      needs_profile: true // דגל שמציין שצריך למלא פרופיל
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בהרשמה', details: String(error) }, 500)
  }
})

/**
 * השלמת פרופיל משתמש (אחרי הרשמה ראשונית)
 */
app.post('/api/auth/complete-profile', async (c) => {
  try {
    const body = await c.req.json()
    const { user_id, name, age, gender, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity, phone, profile_image } = body
    
    if (!user_id || !name) {
      return c.json({ error: 'חסרים פרטים חובה' }, 400)
    }
    
    // Update user profile
    await c.env.DB.prepare(`
      UPDATE users 
      SET name = ?, age = ?, gender = ?, height_cm = ?, weight_kg = ?, 
          target_weight_kg = ?, workouts_per_week = ?, current_level = ?,
          preferred_intensity = ?, phone = ?, profile_image = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      name, age || 25, gender || 'male', height_cm || 170, weight_kg || 70,
      target_weight_kg || 65, workouts_per_week || 3, current_level || 'beginner',
      preferred_intensity || 'medium', phone || null, profile_image || null, user_id
    ).run()
    
    // Add initial weight record
    if (weight_kg) {
      await c.env.DB.prepare(`
        INSERT INTO weight_tracking (user_id, weight_kg, measurement_date, notes)
        VALUES (?, ?, DATE('now'), 'משקל התחלתי')
      `).bind(user_id, weight_kg).run()
    }
    
    return c.json({ 
      success: true, 
      message: 'הפרופיל הושלם בהצלחה!',
      user_id: user_id
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון פרופיל', details: String(error) }, 500)
  }
})

/**
 * התחברות משתמש
 */
app.post('/api/auth/login', async (c) => {
  try {
    const body = await c.req.json()
    const { email, password } = body
    
    if (!email || !password) {
      return c.json({ error: 'חובה למלא מייל וסיסמה' }, 400)
    }
    
    // Find user
    const user = await c.env.DB.prepare(`
      SELECT id, name, email, password_hash, role, is_active 
      FROM users 
      WHERE email = ? AND is_deleted = 0
    `).bind(email).first()
    
    if (!user) {
      return c.json({ error: 'מייל או סיסמה שגויים' }, 401)
    }
    
    if (!user.is_active) {
      return c.json({ error: 'המשתמש לא פעיל. פנה למנהל המערכת' }, 403)
    }
    
    // Verify password
    const passwordHash = btoa(password)
    if (passwordHash !== user.password_hash) {
      return c.json({ error: 'מייל או סיסמה שגויים' }, 401)
    }
    
    // Create session
    const sessionToken = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    
    await c.env.DB.prepare(`
      INSERT INTO user_sessions (user_id, session_token, expires_at)
      VALUES (?, ?, ?)
    `).bind(user.id, sessionToken, expiresAt.toISOString()).run()
    
    // Update last login
    await c.env.DB.prepare(`
      UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(user.id).run()
    
    return c.json({ 
      success: true, 
      message: 'התחברת בהצלחה!',
      user_id: user.id,
      name: user.name,
      role: user.role,
      session_token: sessionToken
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בהתחברות', details: String(error) }, 500)
  }
})

/**
 * התנתקות משתמש
 */
app.post('/api/auth/logout', async (c) => {
  try {
    const body = await c.req.json()
    const { session_token } = body
    
    if (!session_token) {
      return c.json({ error: 'חסר session token' }, 400)
    }
    
    // Delete session
    await c.env.DB.prepare(`
      DELETE FROM user_sessions WHERE session_token = ?
    `).bind(session_token).run()
    
    return c.json({ success: true, message: 'התנתקת בהצלחה' })
  } catch (error) {
    return c.json({ error: 'שגיאה בהתנתקות', details: String(error) }, 500)
  }
})

/**
 * Admin Panel - קבלת כל המשתמשים (Admin בלבד)
 */
app.get('/api/admin/users', async (c) => {
  try {
    const sessionToken = c.req.header('Authorization')?.replace('Bearer ', '')
    
    if (!sessionToken) {
      return c.json({ error: 'נדרשת הרשאת Admin' }, 401)
    }
    
    // Verify admin session
    const session = await c.env.DB.prepare(`
      SELECT s.user_id, u.role 
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.session_token = ? AND s.expires_at > datetime('now')
    `).bind(sessionToken).first()
    
    if (!session || session.role !== 'admin') {
      return c.json({ error: 'נדרשת הרשאת Admin' }, 403)
    }
    
    // Get all users (including soft-deleted)
    const users = await c.env.DB.prepare(`
      SELECT 
        id, name, email, phone, age, height_cm, weight_kg, target_weight_kg,
        gender, current_level, role, is_active, is_deleted, 
        created_at, last_login
      FROM users 
      ORDER BY created_at DESC
    `).all()
    
    return c.json({ 
      success: true, 
      count: users.results.length,
      users: users.results 
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת משתמשים', details: String(error) }, 500)
  }
})

/**
 * Admin Panel - עדכון הרשאות משתמש
 */
app.patch('/api/admin/users/:id', async (c) => {
  try {
    const sessionToken = c.req.header('Authorization')?.replace('Bearer ', '')
    
    if (!sessionToken) {
      return c.json({ error: 'נדרשת הרשאת Admin' }, 401)
    }
    
    // Verify admin session
    const session = await c.env.DB.prepare(`
      SELECT s.user_id, u.role 
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.session_token = ? AND s.expires_at > datetime('now')
    `).bind(sessionToken).first()
    
    if (!session || session.role !== 'admin') {
      return c.json({ error: 'נדרשת הרשאת Admin' }, 403)
    }
    
    const userId = c.req.param('id')
    const body = await c.req.json()
    const { role, is_active } = body
    
    // Update user
    await c.env.DB.prepare(`
      UPDATE users 
      SET role = COALESCE(?, role),
          is_active = COALESCE(?, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(role, is_active, userId).run()
    
    return c.json({ success: true, message: 'משתמש עודכן בהצלחה' })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון משתמש', details: String(error) }, 500)
  }
})

/**
 * Admin Panel - קבלת כל הנתונים המפורטים של משתמש (Admin בלבד)
 */
app.get('/api/admin/users/:id/details', async (c) => {
  try {
    const sessionToken = c.req.header('Authorization')?.replace('Bearer ', '')
    
    if (!sessionToken) {
      return c.json({ error: 'נדרשת הרשאת Admin' }, 401)
    }
    
    // Verify admin session
    const session = await c.env.DB.prepare(`
      SELECT s.user_id, u.role 
      FROM user_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.session_token = ? AND s.expires_at > datetime('now')
    `).bind(sessionToken).first()
    
    if (!session || session.role !== 'admin') {
      return c.json({ error: 'נדרשת הרשאת Admin' }, 403)
    }
    
    const userId = c.req.param('id')
    
    // Get user basic info
    const user = await c.env.DB.prepare(`
      SELECT 
        id, name, email, phone, age, height_cm, weight_kg, target_weight_kg,
        gender, current_level, preferred_intensity, workouts_per_week,
        role, is_active, is_deleted, profile_image,
        created_at, last_login, updated_at
      FROM users 
      WHERE id = ?
    `).bind(userId).first()
    
    if (!user) {
      return c.json({ error: 'משתמש לא נמצא' }, 404)
    }
    
    // Get workout stats
    const workoutStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_workouts,
        SUM(calories_burned) as total_calories,
        SUM(work_minutes) as total_work_minutes,
        MAX(created_at) as last_workout_date
      FROM workout_logs
      WHERE user_id = ?
    `).bind(userId).first()
    
    // Get recent workouts (last 10)
    const recentWorkouts = await c.env.DB.prepare(`
      SELECT 
        id, work_minutes, calories_burned, intensity,
        notes, created_at
      FROM workout_logs
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).bind(userId).all()
    
    // Get weight tracking history
    const weightHistory = await c.env.DB.prepare(`
      SELECT 
        weight_kg, measurement_date, notes
      FROM weight_tracking
      WHERE user_id = ?
      ORDER BY measurement_date DESC
      LIMIT 20
    `).bind(userId).all()
    
    // Get achievements
    const achievements = await c.env.DB.prepare(`
      SELECT 
        achievement_type, achievement_name, achievement_value, earned_date
      FROM achievements
      WHERE user_id = ?
      ORDER BY earned_date DESC
    `).bind(userId).all()
    
    // Calculate BMI
    const bmi = user.height_cm ? (user.weight_kg / Math.pow(user.height_cm / 100, 2)).toFixed(1) : null
    
    // Calculate progress
    const startWeight = weightHistory.results.length > 0 
      ? weightHistory.results[weightHistory.results.length - 1].weight_kg 
      : user.weight_kg
    const currentWeight = user.weight_kg
    const targetWeight = user.target_weight_kg
    const totalToLose = startWeight - targetWeight
    const lost = startWeight - currentWeight
    const remaining = currentWeight - targetWeight
    const progressPercent = totalToLose > 0 ? ((lost / totalToLose) * 100).toFixed(1) : 0
    
    return c.json({ 
      success: true,
      user: {
        ...user,
        bmi: bmi,
        bmi_status: bmi ? (bmi < 18.5 ? 'תת משקל' : bmi < 25 ? 'תקין' : bmi < 30 ? 'עודף משקל' : 'השמנה') : null
      },
      stats: {
        workouts: {
          total: workoutStats.total_workouts || 0,
          total_calories: workoutStats.total_calories || 0,
          total_hours: workoutStats.total_work_minutes ? (workoutStats.total_work_minutes / 60).toFixed(1) : 0,
          last_workout: workoutStats.last_workout_date || null
        },
        weight: {
          start_weight: startWeight,
          current_weight: currentWeight,
          target_weight: targetWeight,
          weight_lost: lost,
          weight_remaining: remaining,
          progress_percent: progressPercent,
          measurements_count: weightHistory.results.length
        },
        achievements: {
          total: achievements.results.length,
          list: achievements.results
        }
      },
      recent_data: {
        workouts: recentWorkouts.results,
        weight_history: weightHistory.results
      }
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת נתוני משתמש', details: String(error) }, 500)
  }
})

/**
 * בדיקת session והחזרת פרטי משתמש
 */
app.get('/api/auth/me', async (c) => {
  try {
    const sessionToken = c.req.header('Authorization')?.replace('Bearer ', '')
    
    if (!sessionToken) {
      return c.json({ error: 'לא מחובר' }, 401)
    }
    
    // Find session
    const session = await c.env.DB.prepare(`
      SELECT user_id, expires_at FROM user_sessions 
      WHERE session_token = ?
    `).bind(sessionToken).first()
    
    if (!session) {
      return c.json({ error: 'Session לא תקף' }, 401)
    }
    
    // Check if expired
    if (new Date(session.expires_at) < new Date()) {
      await c.env.DB.prepare(`
        DELETE FROM user_sessions WHERE session_token = ?
      `).bind(sessionToken).run()
      return c.json({ error: 'Session פג תוקף' }, 401)
    }
    
    // Get user
    const user = await c.env.DB.prepare(`
      SELECT id, name, email, role, created_at, last_login
      FROM users 
      WHERE id = ? AND is_deleted = 0 AND is_active = 1
    `).bind(session.user_id).first()
    
    if (!user) {
      return c.json({ error: 'משתמש לא נמצא' }, 404)
    }
    
    return c.json({ user })
  } catch (error) {
    return c.json({ error: 'שגיאה בבדיקת session', details: String(error) }, 500)
  }
})

// ========================================
// API Routes - הישגים (Achievements)
// ========================================

/**
 * קבלת כל ההישגים של משתמש
 */
app.get('/api/achievements/user/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    
    const { results: achievements } = await c.env.DB.prepare(`
      SELECT * FROM achievements 
      WHERE user_id = ? 
      ORDER BY earned_date DESC
    `).bind(userId).all()
    
    return c.json({ achievements, count: achievements.length })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת הישגים', details: String(error) }, 500)
  }
})

/**
 * בדיקה ומתן הישגים חדשים
 */
app.post('/api/achievements/check/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    const newAchievements = []
    
    // Get user stats
    const workoutsCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM workout_logs WHERE user_id = ?
    `).bind(userId).first()
    
    const weekWorkouts = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM workout_logs 
      WHERE user_id = ? 
      AND workout_date >= date('now', '-7 days')
    `).bind(userId).first()
    
    const weightLoss = await c.env.DB.prepare(`
      SELECT 
        (SELECT weight_kg FROM weight_tracking WHERE user_id = ? ORDER BY measurement_date ASC LIMIT 1) as first_weight,
        (SELECT weight_kg FROM weight_tracking WHERE user_id = ? ORDER BY measurement_date DESC LIMIT 1) as current_weight
    `).bind(userId, userId).first()
    
    // Check existing achievements
    const { results: existing } = await c.env.DB.prepare(`
      SELECT achievement_type FROM achievements WHERE user_id = ?
    `).bind(userId).all()
    
    const existingTypes = new Set(existing.map(a => a.achievement_type))
    
    // Check for new achievements
    const achievementChecks = [
      {
        type: 'first_workout',
        condition: workoutsCount.count >= 1 && !existingTypes.has('first_workout'),
        name: '🥇 אימון ראשון',
        value: 1
      },
      {
        type: 'workout_5',
        condition: workoutsCount.count >= 5 && !existingTypes.has('workout_5'),
        name: '🔥 5 אימונים',
        value: 5
      },
      {
        type: 'workout_10',
        condition: workoutsCount.count >= 10 && !existingTypes.has('workout_10'),
        name: '💪 10 אימונים',
        value: 10
      },
      {
        type: 'workout_25',
        condition: workoutsCount.count >= 25 && !existingTypes.has('workout_25'),
        name: '🎯 25 אימונים',
        value: 25
      },
      {
        type: 'workout_50',
        condition: workoutsCount.count >= 50 && !existingTypes.has('workout_50'),
        name: '🏆 50 אימונים',
        value: 50
      },
      {
        type: 'week_complete',
        condition: weekWorkouts.count >= 3 && !existingTypes.has('week_complete'),
        name: '⭐ שבוע מושלם',
        value: 3
      },
      {
        type: 'weight_loss_1kg',
        condition: weightLoss && weightLoss.first_weight && weightLoss.current_weight && 
                   (weightLoss.first_weight - weightLoss.current_weight >= 1) && 
                   !existingTypes.has('weight_loss_1kg'),
        name: '📉 ירידה של 1 ק"ג',
        value: 1
      },
      {
        type: 'weight_loss_5kg',
        condition: weightLoss && weightLoss.first_weight && weightLoss.current_weight && 
                   (weightLoss.first_weight - weightLoss.current_weight >= 5) && 
                   !existingTypes.has('weight_loss_5kg'),
        name: '🎉 ירידה של 5 ק"ג',
        value: 5
      }
    ]
    
    // Award new achievements
    for (const check of achievementChecks) {
      if (check.condition) {
        await c.env.DB.prepare(`
          INSERT INTO achievements (user_id, achievement_type, achievement_name, achievement_value, earned_date)
          VALUES (?, ?, ?, ?, date('now'))
        `).bind(userId, check.type, check.name, check.value).run()
        
        newAchievements.push({
          type: check.type,
          name: check.name,
          value: check.value
        })
      }
    }
    
    return c.json({ 
      newAchievements, 
      count: newAchievements.length,
      message: newAchievements.length > 0 ? 'הישגים חדשים!' : 'אין הישגים חדשים'
    })
  } catch (error) {
    return c.json({ error: 'שגיאה בבדיקת הישגים', details: String(error) }, 500)
  }
})

// ========================================
// Frontend Routes
// ========================================

/**
 * דף הבית החדש - מערכת אימות
 */
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>JumpFitPro - התחבר או הירשם</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          @keyframes slideIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .animate-slide-in { animation: slideIn 0.5s ease-out; }
        </style>
    </head>
    <body class="bg-white min-h-screen flex items-center justify-center p-4">
        <!-- Welcome Modal (Hidden by default) -->
        <div id="welcomeModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center animate-slide-in">
                <div class="flex items-center justify-center mb-4">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-24" />
                </div>
                <h2 class="text-3xl font-bold text-gray-800 mb-4">יאללה, בואו נקפוץ! 🚀</h2>
                <p class="text-gray-600 mb-4 text-lg">
                    <strong>ברוכים הבאים למועדון הכי קופץ בעולם!</strong> 🌍
                </p>
                <p class="text-gray-500 mb-6">
                    הצטרפת למשפחת JumpFitPro - איפה הקלוריות בורחות מפחד והקילוגרמים מתחילים לבכות! 😂<br/>
                    <span class="text-indigo-600 font-bold">רק תזכור:</span> כל קפיצה היא צעד אחד קרוב יותר למטרה (ועוד קלוריה שלא תחזור)! 💪
                </p>
                <p class="text-sm text-gray-400 mb-6 italic">
                    "החיים קצרים מדי כדי לא לקפוץ" - משפט חכמה מאת חבל קפיצה 🪢
                </p>
                <button onclick="closeWelcomeModal()" class="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold py-3 px-8 rounded-full transition duration-300 transform hover:scale-105 shadow-lg">
                    בואו נתחיל לקפוץ! 🪢💥
                </button>
            </div>
        </div>

        <!-- Main Auth Container -->
        <div class="bg-white rounded-lg border border-gray-200 overflow-hidden max-w-md w-full shadow-sm">
            <div class="p-8">
                <!-- Logo -->
                <div class="flex items-center justify-center mb-8">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-24" />
                </div>

                <!-- Toggle Buttons -->
                <div class="flex gap-2 mb-8 border-b border-gray-200">
                    <button id="loginTabBtn" onclick="showLoginTab()" class="flex-1 py-3 font-bold transition duration-300 border-b-2 border-indigo-600 text-indigo-600">
                        התחברות
                    </button>
                    <button id="registerTabBtn" onclick="showRegisterTab()" class="flex-1 py-3 font-bold transition duration-300 text-gray-500">
                        הרשמה
                    </button>
                </div>

                <!-- Login Form -->
                <div id="loginForm" class="space-y-4">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6 text-center">התחברות</h2>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">מייל</label>
                            <input type="email" id="loginEmail" placeholder="your@email.com" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">סיסמה</label>
                            <input type="password" id="loginPassword" placeholder="••••••••" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                        <button onclick="handleLogin()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition duration-200">
                            התחבר
                        </button>
                        <div class="text-center mt-4 space-y-2">
                            <p class="text-sm">
                                <button onclick="showForgotPassword()" class="text-indigo-600 hover:text-indigo-800 hover:underline font-semibold">
                                    <i class="fas fa-key ml-1"></i>
                                    שכחתי סיסמה
                                </button>
                            </p>
                            <p class="text-gray-600 text-xs">
                                או <a href="/legacy" class="text-indigo-600 hover:underline">השתמש במערכת הישנה</a>
                            </p>
                        </div>
                    </div>

                <!-- Register Form (Hidden) - שלב 1: רק מייל וסיסמה -->
                <div id="registerForm" class="hidden space-y-4">
                    <h2 class="text-2xl font-bold text-gray-800 mb-6 text-center">הרשמה</h2>
                        
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">מייל *</label>
                            <input type="email" id="regEmail" required placeholder="your@email.com" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">סיסמה *</label>
                            <input type="password" id="regPassword" required placeholder="לפחות 6 תווים" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                            <p class="text-xs text-gray-500 mt-1">לפחות 6 תווים</p>
                        </div>
                        <div>
                            <label class="block text-gray-700 font-bold mb-2">אימות סיסמה *</label>
                            <input type="password" id="regPasswordConfirm" required placeholder="הקלד סיסמה שוב" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                        </div>
                        
                        <button onclick="handleQuickRegister()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition duration-200">
                            הרשם עכשיו
                        </button>
                        
                        <p class="text-center text-xs text-gray-500 mt-4">
                            כבר רשום? <button onclick="showLoginTab()" class="text-indigo-600 hover:underline font-bold">התחבר כאן</button>
                        </p>
                    </div>

                    <div id="message" class="mt-4 hidden p-4 rounded-lg"></div>
                </div>
            </div>
        </div>

        <script>
            // Tab switching
            function showLoginTab() {
                document.getElementById('loginForm').classList.remove('hidden')
                document.getElementById('registerForm').classList.add('hidden')
                document.getElementById('loginTabBtn').classList.add('border-b-2', 'border-indigo-600', 'text-indigo-600')
                document.getElementById('loginTabBtn').classList.remove('text-gray-500')
                document.getElementById('registerTabBtn').classList.remove('border-b-2', 'border-indigo-600', 'text-indigo-600')
                document.getElementById('registerTabBtn').classList.add('text-gray-500')
            }

            function showRegisterTab() {
                document.getElementById('registerForm').classList.remove('hidden')
                document.getElementById('loginForm').classList.add('hidden')
                document.getElementById('registerTabBtn').classList.add('border-b-2', 'border-indigo-600', 'text-indigo-600')
                document.getElementById('registerTabBtn').classList.remove('text-gray-500')
                document.getElementById('loginTabBtn').classList.remove('border-b-2', 'border-indigo-600', 'text-indigo-600')
                document.getElementById('loginTabBtn').classList.add('text-gray-500')
            }

            function showMessage(text, type) {
                const msg = document.getElementById('message')
                msg.textContent = text
                msg.className = 'mt-4 p-4 rounded-lg ' + (type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800')
                msg.classList.remove('hidden')
                setTimeout(() => msg.classList.add('hidden'), 5000)
            }

            async function handleLogin() {
                const email = document.getElementById('loginEmail').value
                const password = document.getElementById('loginPassword').value

                if (!email || !password) {
                    showMessage('חובה למלא מייל וסיסמה', 'error')
                    return
                }

                try {
                    const response = await axios.post('/api/auth/login', { email, password })
                    localStorage.setItem('session_token', response.data.session_token)
                    localStorage.setItem('user_id', response.data.user_id)
                    localStorage.setItem('user_name', response.data.name)
                    localStorage.setItem('user_role', response.data.role)
                    
                    // Always redirect to dashboard for all users
                    showMessage('התחברת בהצלחה! מעביר לדשבורד...', 'success')
                    setTimeout(() => {
                        window.location.href = '/dashboard?user=' + response.data.user_id
                    }, 1000)
                } catch (error) {
                    showMessage(error.response?.data?.error || 'שגיאה בהתחברות', 'error')
                }
            }

            // Quick registration - Step 1 (email + password only)
            async function handleQuickRegister() {
                const email = document.getElementById('regEmail').value
                const password = document.getElementById('regPassword').value
                const passwordConfirm = document.getElementById('regPasswordConfirm').value

                if (!email || !password) {
                    showMessage('חובה למלא מייל וסיסמה', 'error')
                    return
                }

                if (password.length < 6) {
                    showMessage('הסיסמה חייבת להיות לפחות 6 תווים', 'error')
                    return
                }

                if (password !== passwordConfirm) {
                    showMessage('הסיסמאות לא תואמות', 'error')
                    return
                }

                try {
                    const response = await axios.post('/api/auth/quick-register', { email, password })
                    
                    if (response.data.success) {
                        localStorage.setItem('session_token', response.data.session_token)
                        localStorage.setItem('user_id', response.data.user_id)
                        
                        showMessage('נרשמת בהצלחה! עכשיו בואו נשלים את הפרופיל...', 'success')
                        
                        // Redirect to profile creation page
                        setTimeout(() => {
                            window.location.href = '/create-profile'
                        }, 1500)
                    }
                } catch (error) {
                    showMessage(error.response?.data?.error || 'שגיאה בהרשמה', 'error')
                }
            }

            // Old full registration function (keeping for legacy /api/auth/register)
            async function handleRegister() {
                const name = document.getElementById('regName').value
                const email = document.getElementById('regEmail').value
                const password = document.getElementById('regPassword').value
                const age = parseInt(document.getElementById('regAge').value)
                const weight_kg = parseFloat(document.getElementById('regWeight').value)
                const target_weight_kg = parseFloat(document.getElementById('regTargetWeight').value)

                if (!name || !email || !password) {
                    showMessage('חובה למלא: שם, מייל וסיסמה', 'error')
                    return
                }

                if (password.length < 6) {
                    showMessage('הסיסמה חייבת להיות לפחות 6 תווים', 'error')
                    return
                }

                try {
                    const response = await axios.post('/api/auth/register', {
                        name, email, password, age, 
                        height_cm: 170, 
                        weight_kg, 
                        target_weight_kg,
                        gender: 'male',
                        workouts_per_week: 3,
                        current_level: 'beginner'
                    })
                    
                    localStorage.setItem('session_token', response.data.session_token)
                    localStorage.setItem('user_id', response.data.user_id)
                    localStorage.setItem('user_name', response.data.name)
                    localStorage.setItem('user_role', 'user')
                    
                    // Show welcome modal
                    document.getElementById('welcomeModal').classList.remove('hidden')
                } catch (error) {
                    showMessage(error.response?.data?.error || 'שגיאה בהרשמה', 'error')
                }
            }

            function closeWelcomeModal() {
                document.getElementById('welcomeModal').classList.add('hidden')
                const userId = localStorage.getItem('user_id')
                window.location.href = '/dashboard?user=' + userId
            }

            function showForgotPassword() {
                const email = prompt('הזן את כתובת המייל שלך:')
                if (email) {
                    alert('תכונת "שכחתי סיסמה" תהיה זמינה בקרוב!\\n\\nלעת עתה, צור קשר עם התמיכה בכתובת: support@jumpfitpro.com\\n\\nאו נסה להירשם שוב עם מייל חדש.')
                }
            }

            // Enter key support
            document.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    if (!document.getElementById('loginForm').classList.contains('hidden')) {
                        handleLogin()
                    } else {
                        handleRegister()
                    }
                }
            })
        </script>
    </body>
    </html>
  `)
})

/**
 * Admin Panel - ניהול משתמשים
 */
app.get('/admin', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Panel - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    </head>
    <body class="bg-gray-100">
        <div class="container mx-auto px-4 py-8">
            <!-- Header -->
            <div class="bg-gradient-to-r from-red-600 to-pink-600 text-white p-6 rounded-lg shadow-lg mb-8">
                <div class="flex justify-between items-center">
                    <div>
                        <h1 class="text-3xl font-bold mb-2">
                            <i class="fas fa-shield-alt mr-2"></i>
                            Admin Panel
                        </h1>
                        <p class="text-red-100">ניהול כל המשתמשים במערכת</p>
                    </div>
                    <div>
                        <span id="adminName" class="bg-white text-red-600 px-4 py-2 rounded-full font-bold"></span>
                        <button onclick="handleLogout()" class="mr-4 bg-red-700 hover:bg-red-800 text-white px-4 py-2 rounded-lg">
                            <i class="fas fa-sign-out-alt mr-2"></i>
                            התנתק
                        </button>
                    </div>
                </div>
            </div>

            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div class="bg-white p-6 rounded-lg shadow-md">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600">סה"כ משתמשים</p>
                            <p id="totalUsers" class="text-3xl font-bold text-gray-800">0</p>
                        </div>
                        <i class="fas fa-users text-4xl text-blue-500"></i>
                    </div>
                </div>
                <div class="bg-white p-6 rounded-lg shadow-md">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600">משתמשים פעילים</p>
                            <p id="activeUsers" class="text-3xl font-bold text-green-600">0</p>
                        </div>
                        <i class="fas fa-user-check text-4xl text-green-500"></i>
                    </div>
                </div>
                <div class="bg-white p-6 rounded-lg shadow-md">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600">מנהלים</p>
                            <p id="adminUsers" class="text-3xl font-bold text-purple-600">0</p>
                        </div>
                        <i class="fas fa-user-shield text-4xl text-purple-500"></i>
                    </div>
                </div>
                <div class="bg-white p-6 rounded-lg shadow-md">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600">משתמשים מחוקים</p>
                            <p id="deletedUsers" class="text-3xl font-bold text-red-600">0</p>
                        </div>
                        <i class="fas fa-user-slash text-4xl text-red-500"></i>
                    </div>
                </div>
            </div>

            <!-- User Details Modal -->
            <div id="userDetailsModal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div class="bg-white rounded-2xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-y-auto">
                    <div class="sticky top-0 bg-gradient-to-r from-indigo-600 to-purple-600 text-white p-6 rounded-t-2xl">
                        <div class="flex justify-between items-center">
                            <h2 class="text-2xl font-bold">
                                <i class="fas fa-user-circle ml-2"></i>
                                פרטי משתמש מלאים
                            </h2>
                            <button onclick="closeUserDetailsModal()" class="text-white hover:text-gray-200 text-2xl">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>
                    <div id="userDetailsContent" class="p-6">
                        <div class="text-center py-8">
                            <i class="fas fa-spinner fa-spin text-4xl text-indigo-600"></i>
                            <p class="mt-4 text-gray-600">טוען נתונים...</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Users Table -->
            <div class="bg-white rounded-lg shadow-md overflow-hidden">
                <div class="p-6 border-b border-gray-200">
                    <h2 class="text-2xl font-bold text-gray-800">
                        <i class="fas fa-list mr-2"></i>
                        רשימת משתמשים
                    </h2>
                </div>
                <div class="overflow-x-auto">
                    <table class="min-w-full">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">ID</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">שם</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">מייל</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">גיל</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">משקל</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">רמה</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">תפקיד</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">סטטוס</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">תאריך הצטרפות</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">פעולות</th>
                            </tr>
                        </thead>
                        <tbody id="usersTableBody" class="bg-white divide-y divide-gray-200">
                            <tr>
                                <td colspan="10" class="px-6 py-4 text-center text-gray-500">
                                    <i class="fas fa-spinner fa-spin text-2xl mb-2"></i>
                                    <p>טוען נתונים...</p>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            console.log('=== Admin Panel Script Started ===')
            let sessionToken = localStorage.getItem('session_token')
            let userId = localStorage.getItem('user_id')
            let userName = localStorage.getItem('user_name')
            let userRole = localStorage.getItem('user_role')

            console.log('localStorage check:')
            console.log('- sessionToken:', sessionToken ? 'EXISTS' : 'MISSING')
            console.log('- userId:', userId)
            console.log('- userName:', userName)
            console.log('- userRole:', userRole)

            // Check authentication
            if (!sessionToken || userRole !== 'admin') {
                console.error('Authentication failed!')
                console.error('- sessionToken exists:', !!sessionToken)
                console.error('- userRole is admin:', userRole === 'admin')
                alert('נדרשת הרשאת Admin!')
                window.location.href = '/'
            }

            console.log('Authentication passed!')
            document.getElementById('adminName').textContent = userName || 'Admin'

            // Load users
            async function loadUsers() {
                console.log('=== loadUsers() called ===')
                console.log('sessionToken:', sessionToken)
                console.log('userRole:', userRole)
                
                try {
                    console.log('Making API call to /api/admin/users...')
                    const response = await axios.get('/api/admin/users', {
                        headers: { 'Authorization': 'Bearer ' + sessionToken }
                    })

                    console.log('Users loaded:', response.data.users.length)
                    const users = response.data.users
                    updateStats(users)
                    renderUsersTable(users)
                } catch (error) {
                    console.error('Error loading users:', error)
                    alert('שגיאה בטעינת משתמשים: ' + (error.response?.data?.error || error.message))
                    if (error.response?.status === 401 || error.response?.status === 403) {
                        window.location.href = '/'
                    }
                }
            }

            function updateStats(users) {
                document.getElementById('totalUsers').textContent = users.length
                document.getElementById('activeUsers').textContent = users.filter(u => u.is_active && !u.is_deleted).length
                document.getElementById('adminUsers').textContent = users.filter(u => u.role === 'admin').length
                document.getElementById('deletedUsers').textContent = users.filter(u => u.is_deleted).length
            }

            function renderUsersTable(users) {
                const tbody = document.getElementById('usersTableBody')
                tbody.innerHTML = users.map(user => \`
                    <tr class="\${user.is_deleted ? 'bg-red-50' : ''}">
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">\${user.id}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">\${user.name}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.email || '-'}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.age || '-'}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.weight_kg || '-'} ק"ג</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.current_level || '-'}</td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            <span class="px-2 py-1 text-xs font-semibold rounded-full \${user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}">
                                \${user.role === 'admin' ? '👑 מנהל' : '👤 משתמש'}
                            </span>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            \${user.is_deleted ? '<span class="px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">🗑️ מחוק</span>' : 
                              user.is_active ? '<span class="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">✅ פעיל</span>' :
                              '<span class="px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">⏸️ לא פעיל</span>'}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${new Date(user.created_at).toLocaleDateString('he-IL')}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                            <button onclick="viewUserDetails(\${user.id})" class="inline-block bg-purple-500 hover:bg-purple-600 text-white px-3 py-1 rounded text-xs">
                                <i class="fas fa-info-circle"></i> פרטים מלאים
                            </button>
                            <button onclick="loginAsUser(\${user.id}, '\${user.name}')" class="inline-block bg-indigo-500 hover:bg-indigo-600 text-white px-3 py-1 rounded text-xs font-bold">
                                <i class="fas fa-sign-in-alt"></i> היכנס כמשתמש
                            </button>
                            <a href="/dashboard?user=\${user.id}" class="inline-block bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-xs">
                                <i class="fas fa-chart-line"></i> דשבורד
                            </a>
                            <a href="/plans?user=\${user.id}" class="inline-block bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded text-xs">
                                <i class="fas fa-dumbbell"></i> תכניות
                            </a>
                            <a href="/live-workout?user=\${user.id}" class="inline-block bg-orange-500 hover:bg-orange-600 text-white px-3 py-1 rounded text-xs">
                                <i class="fas fa-play-circle"></i> אימון
                            </a>
                            <a href="/settings?user=\${user.id}" class="inline-block bg-gray-500 hover:bg-gray-600 text-white px-3 py-1 rounded text-xs">
                                <i class="fas fa-cog"></i> הגדרות
                            </a>
                        </td>
                    </tr>
                \`).join('')
            }

            function handleLogout() {
                localStorage.clear()
                window.location.href = '/'
            }

            // Login as user (Impersonate)
            function loginAsUser(userId, userName) {
                // Save admin info for return
                localStorage.setItem('admin_user_id', localStorage.getItem('user_id'))
                localStorage.setItem('admin_session_token', sessionToken)
                localStorage.setItem('admin_user_name', localStorage.getItem('user_name'))
                
                // Set user info
                localStorage.setItem('user_id', userId)
                localStorage.setItem('user_name', userName)
                localStorage.setItem('impersonating', 'true')
                
                // Redirect to dashboard
                window.location.href = '/dashboard?user=' + userId
            }

            // View user full details
            async function viewUserDetails(userId) {
                document.getElementById('userDetailsModal').classList.remove('hidden')
                document.getElementById('userDetailsContent').innerHTML = \`
                    <div class="text-center py-8">
                        <i class="fas fa-spinner fa-spin text-4xl text-indigo-600"></i>
                        <p class="mt-4 text-gray-600">טוען נתונים...</p>
                    </div>
                \`

                try {
                    const response = await axios.get(\`/api/admin/users/\${userId}/details\`, {
                        headers: { 'Authorization': 'Bearer ' + sessionToken }
                    })

                    const data = response.data
                    const user = data.user
                    const stats = data.stats
                    const recent = data.recent_data

                    document.getElementById('userDetailsContent').innerHTML = \`
                        <!-- User Basic Info -->
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                            <div class="bg-gradient-to-br from-blue-500 to-blue-600 text-white p-6 rounded-lg shadow-md">
                                <h3 class="text-lg font-bold mb-4"><i class="fas fa-user ml-2"></i>פרטים אישיים</h3>
                                <div class="space-y-2 text-sm">
                                    <p><strong>שם:</strong> \${user.name}</p>
                                    <p><strong>מייל:</strong> \${user.email || '-'}</p>
                                    <p><strong>טלפון:</strong> \${user.phone || '-'}</p>
                                    <p><strong>גיל:</strong> \${user.age || '-'}</p>
                                    <p><strong>מין:</strong> \${user.gender === 'male' ? 'זכר' : 'נקבה'}</p>
                                    <p><strong>גובה:</strong> \${user.height_cm} ס"מ</p>
                                </div>
                            </div>

                            <div class="bg-gradient-to-br from-green-500 to-green-600 text-white p-6 rounded-lg shadow-md">
                                <h3 class="text-lg font-bold mb-4"><i class="fas fa-weight ml-2"></i>מידע משקל</h3>
                                <div class="space-y-2 text-sm">
                                    <p><strong>משקל נוכחי:</strong> \${user.weight_kg} ק"ג</p>
                                    <p><strong>משקל יעד:</strong> \${user.target_weight_kg} ק"ג</p>
                                    <p><strong>BMI:</strong> \${user.bmi} (\${user.bmi_status})</p>
                                    <p><strong>ירד במשקל:</strong> \${stats.weight.weight_lost.toFixed(1)} ק"ג</p>
                                    <p><strong>נותר לרדת:</strong> \${stats.weight.weight_remaining.toFixed(1)} ק"ג</p>
                                    <p><strong>התקדמות:</strong> \${stats.weight.progress_percent}%</p>
                                </div>
                            </div>

                            <div class="bg-gradient-to-br from-purple-500 to-purple-600 text-white p-6 rounded-lg shadow-md">
                                <h3 class="text-lg font-bold mb-4"><i class="fas fa-dumbbell ml-2"></i>פרופיל אימון</h3>
                                <div class="space-y-2 text-sm">
                                    <p><strong>רמה:</strong> \${user.current_level}</p>
                                    <p><strong>עוצמה מועדפת:</strong> \${user.preferred_intensity}</p>
                                    <p><strong>אימונים בשבוע:</strong> \${user.workouts_per_week}</p>
                                    <p><strong>תפקיד:</strong> \${user.role === 'admin' ? '👑 מנהל' : '👤 משתמש'}</p>
                                    <p><strong>סטטוס:</strong> \${user.is_active ? '✅ פעיל' : '⏸️ לא פעיל'}</p>
                                    <p><strong>הצטרף:</strong> \${new Date(user.created_at).toLocaleDateString('he-IL')}</p>
                                </div>
                            </div>
                        </div>

                        <!-- Workout Stats -->
                        <div class="bg-white border-2 border-gray-200 rounded-lg p-6 mb-6">
                            <h3 class="text-xl font-bold text-gray-800 mb-4">
                                <i class="fas fa-chart-bar text-indigo-600 ml-2"></i>
                                סטטיסטיקות אימונים
                            </h3>
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <div class="text-center p-4 bg-indigo-50 rounded-lg">
                                    <i class="fas fa-running text-3xl text-indigo-600 mb-2"></i>
                                    <p class="text-2xl font-bold text-gray-800">\${stats.workouts.total}</p>
                                    <p class="text-sm text-gray-600">סך אימונים</p>
                                </div>
                                <div class="text-center p-4 bg-green-50 rounded-lg">
                                    <i class="fas fa-fire text-3xl text-green-600 mb-2"></i>
                                    <p class="text-2xl font-bold text-gray-800">\${stats.workouts.total_calories.toLocaleString()}</p>
                                    <p class="text-sm text-gray-600">קלוריות נשרפו</p>
                                </div>
                                <div class="text-center p-4 bg-orange-50 rounded-lg">
                                    <i class="fas fa-clock text-3xl text-orange-600 mb-2"></i>
                                    <p class="text-2xl font-bold text-gray-800">\${stats.workouts.total_hours}</p>
                                    <p class="text-sm text-gray-600">שעות אימון</p>
                                </div>
                                <div class="text-center p-4 bg-purple-50 rounded-lg">
                                    <i class="fas fa-trophy text-3xl text-purple-600 mb-2"></i>
                                    <p class="text-2xl font-bold text-gray-800">\${stats.achievements.total}</p>
                                    <p class="text-sm text-gray-600">הישגים</p>
                                </div>
                            </div>
                        </div>

                        <!-- Recent Workouts -->
                        <div class="bg-white border-2 border-gray-200 rounded-lg p-6 mb-6">
                            <h3 class="text-xl font-bold text-gray-800 mb-4">
                                <i class="fas fa-history text-indigo-600 ml-2"></i>
                                אימונים אחרונים (10 אחרונים)
                            </h3>
                            <div class="overflow-x-auto">
                                <table class="w-full text-sm">
                                    <thead class="bg-gray-50">
                                        <tr>
                                            <th class="px-4 py-2 text-right">תאריך</th>
                                            <th class="px-4 py-2 text-right">משך (דקות)</th>
                                            <th class="px-4 py-2 text-right">קלוריות</th>
                                            <th class="px-4 py-2 text-right">עוצמה</th>
                                            <th class="px-4 py-2 text-right">הערות</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-gray-200">
                                        \${recent.workouts.length > 0 ? recent.workouts.map(w => \`
                                            <tr>
                                                <td class="px-4 py-2">\${new Date(w.created_at).toLocaleDateString('he-IL')}</td>
                                                <td class="px-4 py-2">\${w.work_minutes ? w.work_minutes.toFixed(1) : '-'}</td>
                                                <td class="px-4 py-2">\${w.calories_burned}</td>
                                                <td class="px-4 py-2">
                                                    <span class="px-2 py-1 text-xs rounded-full \${w.intensity === 'high' ? 'bg-red-100 text-red-800' : w.intensity === 'medium' ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}">
                                                        \${w.intensity}
                                                    </span>
                                                </td>
                                                <td class="px-4 py-2">\${w.notes || '-'}</td>
                                            </tr>
                                        \`).join('') : '<tr><td colspan="5" class="text-center py-4 text-gray-500">אין אימונים</td></tr>'}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <!-- Weight History -->
                        <div class="bg-white border-2 border-gray-200 rounded-lg p-6 mb-6">
                            <h3 class="text-xl font-bold text-gray-800 mb-4">
                                <i class="fas fa-chart-line text-indigo-600 ml-2"></i>
                                היסטוריית משקל (20 אחרונים)
                            </h3>
                            <div class="overflow-x-auto">
                                <table class="w-full text-sm">
                                    <thead class="bg-gray-50">
                                        <tr>
                                            <th class="px-4 py-2 text-right">תאריך</th>
                                            <th class="px-4 py-2 text-right">משקל (ק"ג)</th>
                                            <th class="px-4 py-2 text-right">הערות</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-gray-200">
                                        \${recent.weight_history.length > 0 ? recent.weight_history.map(w => \`
                                            <tr>
                                                <td class="px-4 py-2">\${new Date(w.measurement_date).toLocaleDateString('he-IL')}</td>
                                                <td class="px-4 py-2 font-bold">\${w.weight_kg}</td>
                                                <td class="px-4 py-2">\${w.notes || '-'}</td>
                                            </tr>
                                        \`).join('') : '<tr><td colspan="3" class="text-center py-4 text-gray-500">אין מדידות משקל</td></tr>'}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <!-- Achievements -->
                        <div class="bg-white border-2 border-gray-200 rounded-lg p-6">
                            <h3 class="text-xl font-bold text-gray-800 mb-4">
                                <i class="fas fa-trophy text-yellow-500 ml-2"></i>
                                הישגים (\${stats.achievements.total})
                            </h3>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                \${stats.achievements.total > 0 ? stats.achievements.list.map(a => \`
                                    <div class="bg-gradient-to-br from-yellow-100 to-orange-100 p-4 rounded-lg border-2 border-yellow-300">
                                        <div class="text-center">
                                            <div class="text-3xl mb-2">🏆</div>
                                            <h4 class="font-bold text-gray-800">\${a.achievement_name}</h4>
                                            <p class="text-sm text-gray-600">\${a.achievement_type}</p>
                                            <p class="text-xs text-gray-500 mt-2">\${new Date(a.earned_date).toLocaleDateString('he-IL')}</p>
                                        </div>
                                    </div>
                                \`).join('') : '<p class="text-center text-gray-500">אין הישגים עדיין</p>'}
                            </div>
                        </div>
                    \`
                } catch (error) {
                    document.getElementById('userDetailsContent').innerHTML = \`
                        <div class="text-center py-8">
                            <i class="fas fa-exclamation-circle text-4xl text-red-600"></i>
                            <p class="mt-4 text-gray-600">שגיאה בטעינת נתונים: \${error.response?.data?.error || error.message}</p>
                        </div>
                    \`
                }
            }

            function closeUserDetailsModal() {
                document.getElementById('userDetailsModal').classList.add('hidden')
            }

            // Load on page load
            loadUsers()
        </script>
    </body>
    </html>
  `)
})

/**
 * עמוד השלמת פרופיל - אחרי הרשמה ראשונית
 */
app.get('/create-profile', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>יצירת פרופיל חדש - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen p-4">
        <div class="max-w-2xl mx-auto py-8">
            <!-- Logo and Header -->
            <div class="text-center mb-8">
                <div class="flex items-center justify-center mb-4">
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-16" />
                </div>
                <h2 class="text-2xl font-bold text-indigo-600 mb-2">יצירת פרופיל חדש</h2>
                <p class="text-gray-600">התחל את המסע שלך לירידה במשקל! 💪</p>
            </div>

            <!-- Profile Form - בדיוק כמו בתמונות -->
            <div class="bg-white rounded-2xl shadow-xl p-8">
                <form id="profileForm" class="space-y-5" novalidate>
                    
                    <!-- שם מלא -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">שם מלא</label>
                        <input type="text" id="name" 
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right"
                            placeholder="הכנס שם מלא">
                    </div>

                    <!-- מין -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">מין</label>
                        <select id="gender" 
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right bg-white">
                            <option value="male">זכר</option>
                            <option value="female">נקבה</option>
                        </select>
                    </div>

                    <!-- גיל -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">גיל</label>
                        <input type="number" id="age" min="10" max="100"
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right"
                            placeholder="גיל">
                    </div>

                    <!-- גובה (ס"מ) -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">גובה (ס"מ)</label>
                        <input type="number" id="height_cm" min="100" max="250"
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right"
                            placeholder="גובה בס\"מ">
                    </div>

                    <!-- משקל נוכחי (ק"ג) -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">משקל נוכחי (ק"ג)</label>
                        <input type="number" id="weight_kg" min="30" max="300" step="0.1"
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right"
                            placeholder="משקל נוכחי בק\"ג">
                    </div>

                    <!-- משקל יעד (ק"ג) -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">משקל יעד (ק"ג)</label>
                        <input type="number" id="target_weight_kg" min="30" max="300" step="0.1"
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right"
                            placeholder="משקל יעד בק\"ג">
                    </div>

                    <!-- כמות אימונים בשבוע -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">כמות אימונים בשבוע</label>
                        <select id="workouts_per_week"
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right bg-white">
                            <option value="3">3 אימונים בשבוע</option>
                            <option value="4">4 אימונים בשבוע</option>
                            <option value="5">5 אימונים בשבוע</option>
                            <option value="6">6 אימונים בשבוע</option>
                        </select>
                    </div>

                    <!-- רמת כושר התחלתית -->
                    <div>
                        <label class="block text-gray-700 font-bold mb-2 text-right">רמת כושר התחלתית</label>
                        <select id="current_level"
                            class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right bg-white">
                            <option value="beginner">מתחילים</option>
                            <option value="intermediate">ביניים</option>
                            <option value="advanced">מתקדמים</option>
                        </select>
                    </div>

                    <!-- תמונת פרופיל (אופציונלי) -->
                    <div class="border-2 border-dashed border-gray-300 rounded-lg p-6 bg-gray-50">
                        <h3 class="font-bold text-gray-700 mb-3 text-right">תמונת פרופיל (אופציונלי)</h3>
                        
                        <!-- Preview Image -->
                        <div id="imagePreview" class="hidden mb-4 text-center">
                            <img id="previewImg" src="" alt="תמונה" class="w-32 h-32 rounded-full mx-auto object-cover border-4 border-indigo-500">
                        </div>

                        <!-- Upload Buttons -->
                        <div class="space-y-3">
                            <button type="button" onclick="document.getElementById('fileInput').click()" 
                                class="w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-lg transition flex items-center justify-center gap-2">
                                <i class="fas fa-upload"></i>
                                העלה תמונה
                            </button>
                            
                            <button type="button" onclick="capturePhoto()" 
                                class="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg transition flex items-center justify-center gap-2">
                                <i class="fas fa-camera"></i>
                                צלם תמונה
                            </button>

                            <button type="button" onclick="clearImage()" 
                                class="w-full bg-gray-400 hover:bg-gray-500 text-white font-bold py-2 px-4 rounded-lg transition flex items-center justify-center gap-2">
                                <i class="fas fa-arrow-left"></i>
                                דלג
                            </button>
                        </div>

                        <input type="file" id="fileInput" accept="image/*" class="hidden" onchange="handleFileSelect(event)">
                    </div>

                    <!-- פרטי קשר - לשליחת תכניות (אופציונלי) -->
                    <div class="border-t-2 pt-5">
                        <h3 class="font-bold text-gray-700 mb-1 text-right">
                            <i class="fas fa-envelope ml-2"></i>
                            פרטי קשר (אופציונלי) - לשליחת תכניות
                        </h3>
                        <p class="text-sm text-gray-500 mb-3 text-right">לשליחת תזכורות אימון לפי המייל</p>
                        
                        <!-- טלפון -->
                        <div class="mb-3">
                            <label class="block text-gray-700 font-bold mb-2 text-right">טלפון (עם קוד מדינה)</label>
                            <input type="tel" id="phone" placeholder="972501234567"
                                class="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-right">
                            <p class="text-xs text-gray-500 mt-1 text-right">לשליחת תזכורות ב-WhatsApp</p>
                        </div>
                    </div>

                    <!-- Submit Buttons -->
                    <div class="space-y-3 pt-4">
                        <button type="button" id="submitBtn" onclick="submitProfileForm()"
                            class="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold py-4 rounded-lg transition duration-300 transform hover:scale-105 shadow-lg flex items-center justify-center gap-2">
                            <i class="fas fa-check-circle"></i>
                            <span id="submitBtnText">צור חשבון והתחל</span>
                        </button>
                        
                        <button type="button" onclick="window.history.back()" 
                            class="w-full bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-3 rounded-lg transition flex items-center justify-center gap-2">
                            ביטול
                        </button>
                    </div>

                    <div id="message" class="hidden mt-4 p-4 rounded-lg"></div>
                </form>
            </div>
        </div>

        <script>
            // Wait for DOM to be fully loaded
            document.addEventListener('DOMContentLoaded', function() {
                console.log('=== Profile Creation Script Started (DOM Ready) ===')
                
                // Get user_id and session from localStorage
                const userId = localStorage.getItem('user_id')
                const sessionToken = localStorage.getItem('session_token')

                console.log('User ID:', userId)
                console.log('Session Token:', sessionToken ? 'EXISTS' : 'MISSING')

                if (!userId || !sessionToken) {
                    console.error('Missing user_id or session_token!')
                    alert('אין מזהה משתמש. מעביר לעמוד הבית...')
                    window.location.href = '/'
                    return
                }

                const profileForm = document.getElementById('profileForm')
                if (!profileForm) {
                    console.error('profileForm element not found!')
                    return
                }

                // Helper function to reset submit button state
                function resetSubmitButton() {
                    isSubmitting = false
                    const submitBtn = document.getElementById('submitBtn')
                    const submitBtnText = document.getElementById('submitBtnText')
                    if (submitBtn) {
                        submitBtn.disabled = false
                        submitBtn.classList.remove('opacity-50', 'cursor-not-allowed')
                        if (submitBtnText) submitBtnText.textContent = 'צור חשבון והתחל'
                    }
                }

                // Flag to prevent double submission
                let isSubmitting = false

                // Submit function - called from button onclick
                window.submitProfileForm = async function() {
                    console.log('=== submitProfileForm() called ===')
                    
                    // Prevent double submission
                    if (isSubmitting) {
                        console.log('Already submitting, ignoring duplicate submission')
                        return false
                    }
                    
                    console.log('=== Form Submit Started ===')
                    isSubmitting = true
                    
                    // Disable submit button to prevent double submission
                    const submitBtn = document.getElementById('submitBtn')
                    const submitBtnText = document.getElementById('submitBtnText')
                    if (submitBtn) {
                        submitBtn.disabled = true
                        submitBtn.classList.add('opacity-50', 'cursor-not-allowed')
                        if (submitBtnText) submitBtnText.textContent = 'שומר נתונים...'
                    }

                    // Validation
                    const name = document.getElementById('name').value.trim()
                    const age = parseInt(document.getElementById('age').value)
                    const height = parseInt(document.getElementById('height_cm').value)
                    const weight = parseFloat(document.getElementById('weight_kg').value)
                    const targetWeight = parseFloat(document.getElementById('target_weight_kg').value)

                    console.log('Form values:', { name, age, height, weight, targetWeight })

                    if (!name) {
                        showMessage('נא למלא שם מלא', 'error')
                        resetSubmitButton()
                        return
                    }

                    if (isNaN(age) || age < 10 || age > 100) {
                        showMessage('גיל צריך להיות בין 10 ל-100', 'error')
                        resetSubmitButton()
                        return
                    }

                    if (isNaN(height) || height < 100 || height > 250) {
                        showMessage('גובה צריך להיות בין 100 ל-250 ס"מ', 'error')
                        resetSubmitButton()
                        return
                    }

                    if (isNaN(weight) || weight < 30 || weight > 300) {
                        showMessage('משקל צריך להיות בין 30 ל-300 ק"ג', 'error')
                        resetSubmitButton()
                        return
                    }

                    if (isNaN(targetWeight) || targetWeight < 30 || targetWeight > 300) {
                        showMessage('משקל יעד צריך להיות בין 30 ל-300 ק"ג', 'error')
                        resetSubmitButton()
                        return
                    }

                    const formData = {
                        user_id: parseInt(userId),
                        name: name,
                        age: age,
                        gender: document.getElementById('gender').value,
                        height_cm: height,
                        weight_kg: weight,
                        target_weight_kg: targetWeight,
                        workouts_per_week: parseInt(document.getElementById('workouts_per_week').value),
                        current_level: document.getElementById('current_level').value,
                        preferred_intensity: 'medium',
                        phone: document.getElementById('phone').value || null,
                        profile_image: profileImageBase64
                    }

                    console.log('=== Sending Profile Data ===')
                    console.log('Data:', formData)
                    showMessage('שומר פרטים...', 'info')

                    try {
                        console.log('Making API call to /api/auth/complete-profile...')
                        const response = await axios.post('/api/auth/complete-profile', formData)
                        console.log('=== API Response Received ===')
                        console.log('Response:', response)
                        console.log('Response data:', response.data)
                        
                        if (response.data && response.data.success) {
                            showMessage('✅ הפרופיל נוצר בהצלחה! מעביר לדשבורד...', 'success')
                            localStorage.setItem('user_name', formData.name)
                            
                            setTimeout(() => {
                                console.log('Redirecting to dashboard...')
                                window.location.href = '/dashboard?user=' + userId
                            }, 1500)
                        } else {
                            const errMsg = response.data?.error || 'שגיאה ביצירת פרופיל'
                            console.error('Profile creation failed:', errMsg)
                            showMessage('❌ ' + errMsg, 'error')
                            resetSubmitButton()
                        }
                    } catch (error) {
                        console.error('Profile creation error:', error)
                        const errMsg = error.response?.data?.error || error.message || 'שגיאה בחיבור לשרת'
                        showMessage('❌ ' + errMsg, 'error')
                        resetSubmitButton()
                    }
                } // End of submitProfileForm

                function showMessage(text, type) {
                const msg = document.getElementById('message')
                msg.textContent = text
                let className = 'mt-4 p-4 rounded-lg '
                if (type === 'success') {
                    className += 'bg-green-100 text-green-800 border border-green-300'
                } else if (type === 'info') {
                    className += 'bg-blue-100 text-blue-800 border border-blue-300'
                } else {
                    className += 'bg-red-100 text-red-800 border border-red-300'
                }
                msg.className = className
                msg.classList.remove('hidden')
            }

            // Profile Image Functions
            // Profile Image Functions - must be global for onclick handlers
            let profileImageBase64 = null

            window.handleFileSelect = function(event) {
                const file = event.target.files[0]
                if (file) {
                    const reader = new FileReader()
                    reader.onload = (e) => {
                        profileImageBase64 = e.target.result
                        window.showImagePreview(e.target.result)
                    }
                    reader.readAsDataURL(file)
                }
            }

            window.capturePhoto = function() {
                alert('פיצר צילום תמונה יהיה זמין בקרוב! לעת עתה השתמש בהעלאת תמונה')
            }

            window.showImagePreview = function(src) {
                document.getElementById('previewImg').src = src
                document.getElementById('imagePreview').classList.remove('hidden')
            }

            window.clearImage = function() {
                profileImageBase64 = null
                document.getElementById('imagePreview').classList.add('hidden')
                document.getElementById('fileInput').value = ''
            }
            
            console.log('=== Profile Creation Script Initialized ===')
            }) // End of DOMContentLoaded
        </script>
    </body>
    </html>
  `)
})

/**
 * Admin Panel - ניהול משתמשים (Admin בלבד)
 */
app.get('/admin', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Panel - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    </head>
    <body class="bg-gray-100 min-h-screen p-4">
        <div class="max-w-7xl mx-auto">
            <!-- Header -->
            <div class="bg-white rounded-lg shadow-md p-6 mb-6">
                <div class="flex justify-between items-center">
                    <div>
                        <h1 class="text-3xl font-bold text-gray-800">
                            <i class="fas fa-user-shield text-indigo-600 ml-2"></i>
                            Admin Panel
                        </h1>
                        <p class="text-gray-600 mt-2">ניהול כל המשתמשים במערכת</p>
                    </div>
                    <div>
                        <span id="adminName" class="text-lg font-bold text-indigo-600"></span>
                        <button onclick="logout()" class="mr-4 bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg transition">
                            <i class="fas fa-sign-out-alt ml-2"></i>
                            התנתק
                        </button>
                    </div>
                </div>
            </div>

            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div class="bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-lg shadow-md p-6">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-blue-100 text-sm">סך הכל משתמשים</p>
                            <p id="totalUsers" class="text-3xl font-bold mt-1">0</p>
                        </div>
                        <i class="fas fa-users text-5xl text-blue-200"></i>
                    </div>
                </div>
                <div class="bg-gradient-to-br from-green-500 to-green-600 text-white rounded-lg shadow-md p-6">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-green-100 text-sm">משתמשים פעילים</p>
                            <p id="activeUsers" class="text-3xl font-bold mt-1">0</p>
                        </div>
                        <i class="fas fa-user-check text-5xl text-green-200"></i>
                    </div>
                </div>
                <div class="bg-gradient-to-br from-purple-500 to-purple-600 text-white rounded-lg shadow-md p-6">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-purple-100 text-sm">מנהלי מערכת</p>
                            <p id="adminUsers" class="text-3xl font-bold mt-1">0</p>
                        </div>
                        <i class="fas fa-user-shield text-5xl text-purple-200"></i>
                    </div>
                </div>
                <div class="bg-gradient-to-br from-red-500 to-red-600 text-white rounded-lg shadow-md p-6">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-red-100 text-sm">משתמשים מחוקים</p>
                            <p id="deletedUsers" class="text-3xl font-bold mt-1">0</p>
                        </div>
                        <i class="fas fa-user-slash text-5xl text-red-200"></i>
                    </div>
                </div>
            </div>

            <!-- Users Table -->
            <div class="bg-white rounded-lg shadow-md overflow-hidden">
                <div class="p-6 border-b border-gray-200">
                    <h2 class="text-xl font-bold text-gray-800">
                        <i class="fas fa-list ml-2"></i>
                        רשימת משתמשים
                    </h2>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">ID</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">שם</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">מייל</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">משקל נוכחי</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">משקל יעד</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">הרשאה</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">סטטוס</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">התחבר לאחרונה</th>
                                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">פעולות</th>
                            </tr>
                        </thead>
                        <tbody id="usersTableBody" class="bg-white divide-y divide-gray-200">
                            <tr>
                                <td colspan="9" class="px-6 py-4 text-center text-gray-500">
                                    <i class="fas fa-spinner fa-spin text-2xl"></i>
                                    <p class="mt-2">טוען משתמשים...</p>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <script>
            const sessionToken = localStorage.getItem('session_token')
            const userName = localStorage.getItem('user_name')
            const userRole = localStorage.getItem('user_role')

            // Check admin access
            if (!sessionToken || userRole !== 'admin') {
                alert('נדרשת הרשאת Admin! מעביר לעמוד ההתחברות...')
                window.location.href = '/'
            }

            document.getElementById('adminName').textContent = userName || 'Admin'

            // Load users
            async function loadUsers() {
                try {
                    const response = await axios.get('/api/admin/users', {
                        headers: { 'Authorization': 'Bearer ' + sessionToken }
                    })

                    const users = response.data.users

                    // Update stats
                    document.getElementById('totalUsers').textContent = users.length
                    document.getElementById('activeUsers').textContent = users.filter(u => u.is_active && !u.is_deleted).length
                    document.getElementById('adminUsers').textContent = users.filter(u => u.role === 'admin').length
                    document.getElementById('deletedUsers').textContent = users.filter(u => u.is_deleted).length

                    // Render table
                    const tbody = document.getElementById('usersTableBody')
                    tbody.innerHTML = users.map(user => \`
                        <tr class="\${user.is_deleted ? 'bg-red-50' : ''}">
                            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">\${user.id}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">\${user.name}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.email || '-'}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.weight_kg} ק"ג</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.target_weight_kg} ק"ג</td>
                            <td class="px-6 py-4 whitespace-nowrap">
                                <span class="px-2 py-1 text-xs rounded-full \${user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}">
                                    \${user.role === 'admin' ? '👑 Admin' : 'משתמש'}
                                </span>
                            </td>
                            <td class="px-6 py-4 whitespace-nowrap">
                                <span class="px-2 py-1 text-xs rounded-full \${user.is_deleted ? 'bg-red-100 text-red-800' : (user.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800')}">
                                    \${user.is_deleted ? '🗑️ נמחק' : (user.is_active ? '✅ פעיל' : '⏸️ מושהה')}
                                </span>
                            </td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">\${user.last_login ? new Date(user.last_login).toLocaleDateString('he-IL') : 'מעולם לא'}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm">
                                <a href="/dashboard?user=\${user.id}" class="text-indigo-600 hover:text-indigo-900 ml-3" target="_blank">
                                    <i class="fas fa-external-link-alt"></i>
                                </a>
                                <button onclick="toggleActive(\${user.id}, \${!user.is_active})" class="text-yellow-600 hover:text-yellow-900 ml-3">
                                    <i class="fas fa-\${user.is_active ? 'pause' : 'play'}-circle"></i>
                                </button>
                                <button onclick="toggleAdmin(\${user.id}, '\${user.role}')" class="text-purple-600 hover:text-purple-900 ml-3">
                                    <i class="fas fa-crown"></i>
                                </button>
                            </td>
                        </tr>
                    \`).join('')
                } catch (error) {
                    alert('שגיאה בטעינת משתמשים: ' + (error.response?.data?.error || error.message))
                }
            }

            async function toggleActive(userId, isActive) {
                try {
                    await axios.patch(\`/api/admin/users/\${userId}\`, 
                        { is_active: isActive ? 1 : 0 },
                        { headers: { 'Authorization': 'Bearer ' + sessionToken } }
                    )
                    alert('סטטוס המשתמש עודכן!')
                    loadUsers()
                } catch (error) {
                    alert('שגיאה: ' + (error.response?.data?.error || error.message))
                }
            }

            async function toggleAdmin(userId, currentRole) {
                const newRole = currentRole === 'admin' ? 'user' : 'admin'
                if (!confirm(\`האם להפוך משתמש זה ל\${newRole === 'admin' ? 'Admin' : 'משתמש רגיל'}?\`)) return

                try {
                    await axios.patch(\`/api/admin/users/\${userId}\`, 
                        { role: newRole },
                        { headers: { 'Authorization': 'Bearer ' + sessionToken } }
                    )
                    alert('הרשאות עודכנו!')
                    loadUsers()
                } catch (error) {
                    alert('שגיאה: ' + (error.response?.data?.error || error.message))
                }
            }

            function logout() {
                localStorage.clear()
                window.location.href = '/'
            }

            // Load on page load
            loadUsers()
        </script>
    </body>
    </html>
  `)
})

/**
 * דף הבית הישן - למשתמשים קיימים ללא אימות
 */
app.get('/legacy', (c) => {
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
                    
                    <!-- תמונת פרופיל -->
                    <div class="bg-gray-50 rounded-lg p-4 border-2 border-dashed border-gray-300">
                        <label class="block text-gray-700 font-bold mb-3">
                            <i class="fas fa-camera ml-2"></i>
                            תמונת פרופיל (אופציונלי)
                        </label>
                        <div class="flex flex-col sm:flex-row gap-3">
                            <input type="file" id="newUserProfileImage" accept="image/*" class="hidden" onchange="handleNewUserImageSelect(event)">
                            <button type="button" onclick="document.getElementById('newUserProfileImage').click()" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded-lg text-sm">
                                <i class="fas fa-upload ml-2"></i>
                                העלה תמונה
                            </button>
                            <button type="button" onclick="captureNewUserPhoto()" class="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded-lg text-sm">
                                <i class="fas fa-camera ml-2"></i>
                                צלם תמונה
                            </button>
                            <button type="button" onclick="skipProfileImage()" class="flex-1 bg-gray-400 hover:bg-gray-500 text-white font-bold py-2 px-4 rounded-lg text-sm">
                                <i class="fas fa-arrow-left ml-2"></i>
                                דלג
                            </button>
                        </div>
                        <div id="newUserImagePreview" class="hidden mt-3">
                            <img id="newUserImagePreviewImg" src="" alt="תצוגה מקדימה" class="w-24 h-24 rounded-full object-cover mx-auto border-4 border-indigo-500">
                            <p class="text-center text-sm text-green-600 mt-2">
                                <i class="fas fa-check-circle ml-1"></i>
                                תמונה נבחרה
                            </p>
                        </div>
                    </div>
                    
                    <!-- שדות ליצירת קשר (אופציונליים) -->
                    <div class="bg-blue-50 rounded-lg p-4 border border-blue-200">
                        <h4 class="font-bold text-gray-800 mb-3">
                            <i class="fas fa-envelope ml-2"></i>
                            פרטי קשר (אופציונלי - לשליחת תכניות)
                        </h4>
                        <div class="space-y-3">
                            <div>
                                <label class="block text-gray-700 font-bold mb-2">מייל</label>
                                <input type="email" name="email" placeholder="example@email.com" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                <p class="text-xs text-gray-500 mt-1">לשליחת תכניות אימון למייל</p>
                            </div>
                            <div>
                                <label class="block text-gray-700 font-bold mb-2">טלפון (עם קוד מדינה)</label>
                                <input type="tel" name="phone" placeholder="972501234567" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                                <p class="text-xs text-gray-500 mt-1">לשליחת תכניות ב-WhatsApp</p>
                            </div>
                        </div>
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

        <!-- Notification Container -->
        <div id="notificationContainer" class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4"></div>
        
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
          // Notification System (מערכת התראות ללא חסימה)
          function showNotification(message, type = 'info') {
            const container = document.getElementById('notificationContainer')
            const notif = document.createElement('div')
            
            const colors = {
              success: 'bg-green-500',
              error: 'bg-red-500',
              warning: 'bg-yellow-500',
              info: 'bg-blue-500'
            }
            
            const icons = {
              success: '✅',
              error: '❌',
              warning: '⚠️',
              info: 'ℹ️'
            }
            
            notif.className = colors[type] + ' text-white px-6 py-4 rounded-lg shadow-2xl mb-3 transform transition-all duration-500 ease-in-out'
            notif.innerHTML = '<div class="flex items-center gap-3"><span class="text-2xl">' + icons[type] + '</span><span class="font-bold">' + message + '</span></div>'
            
            container.appendChild(notif)
            
            // Animation in
            setTimeout(() => {
              notif.style.opacity = '1'
              notif.style.transform = 'translateY(0)'
            }, 10)
            
            // Auto remove after 4 seconds
            setTimeout(() => {
              notif.style.opacity = '0'
              notif.style.transform = 'translateY(-20px)'
              setTimeout(() => notif.remove(), 500)
            }, 4000)
          }
          
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
              showNotification('שגיאה בטעינת משתמשים', 'error')
            }
          }

          function hideUserList() {
            document.getElementById('userListContainer').classList.add('hidden')
          }

          function selectUser(userId) {
            window.location.href = '/dashboard?user=' + userId
          }

          // Handle profile image selection for new user
          let newUserProfileImage = null;
          
          function handleNewUserImageSelect(event) {
            const file = event.target.files[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = (e) => {
                newUserProfileImage = e.target.result;
                document.getElementById('newUserImagePreviewImg').src = e.target.result;
                document.getElementById('newUserImagePreview').classList.remove('hidden');
              };
              reader.readAsDataURL(file);
            }
          }
          
          function captureNewUserPhoto() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.capture = 'camera';
            input.onchange = handleNewUserImageSelect;
            input.click();
          }
          
          function skipProfileImage() {
            // דילוג על תמונת פרופיל - נמשיך ליצירת החשבון בלי תמונה
            newUserProfileImage = null;
            document.getElementById('newUserImagePreview').classList.add('hidden');
            showNotification('תמונת פרופיל לא תיווסף (ניתן להוסיף בהגדרות מאוחר יותר)', 'info');
          }

          // Handle new user form submission
          document.getElementById('newUserForm').addEventListener('submit', async (e) => {
            e.preventDefault()
            const formData = new FormData(e.target)
            const data = Object.fromEntries(formData)
            
            try {
              // יצירת משתמש תחילה
              const response = await axios.post('/api/users', data)
              if (response.data.success) {
                const userId = response.data.user_id
                
                // אם יש תמונה, נעלה אותה
                if (newUserProfileImage) {
                  try {
                    await axios.patch(\`/api/users/\${userId}/profile-image\`, {
                      profile_image: newUserProfileImage
                    })
                  } catch (imgError) {
                    console.error('שגיאה בהעלאת תמונה:', imgError)
                  }
                }
                
                showNotification('חשבון נוצר בהצלחה! 🎉', 'success')
                setTimeout(() => {
                  window.location.href = '/dashboard?user=' + userId
                }, 1500)
              }
            } catch (error) {
              showNotification('שגיאה ביצירת חשבון: ' + (error.response?.data?.error || error.message), 'error')
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
                        <div class="flex items-center gap-2">
                            <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                        </div>
                        <div class="flex items-center gap-3">
                            <img id="userProfileImage" src="" alt="Profile" class="h-10 w-10 rounded-full object-cover border-2 border-indigo-500 hidden" />
                            <div>
                                <p id="userName" class="text-lg font-bold text-gray-700"></p>
                                <p id="userGender" class="text-sm text-gray-500"></p>
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button id="returnToAdminBtn" onclick="returnToAdmin()" class="hidden bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-4 rounded-lg">
                            <i class="fas fa-arrow-right ml-2"></i>
                            חזור לאדמין
                        </button>
                        <a href="/admin" id="adminPanelBtn" class="hidden bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-lg">
                            <i class="fas fa-shield-alt ml-2"></i>
                            Admin Panel
                        </a>
                        <a href="/" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
                            <i class="fas fa-home ml-2"></i>
                            חזרה
                        </a>
                    </div>
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

            <!-- Workout Reminders -->
            <div id="workoutReminders" class="mb-8">
                <!-- Reminders will be dynamically inserted here -->
            </div>

            <!-- Achievements Section -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
                <h3 class="text-xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-trophy text-yellow-500 ml-2"></i>
                    הישגים
                </h3>
                <div id="achievementsContainer" class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <!-- Achievements will be dynamically inserted here -->
                </div>
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
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 sm:gap-4">
                    <button onclick="window.location.href='/live-workout?user=${userId}'" class="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-fire ml-2"></i>
                        אימון חי
                    </button>
                    <button onclick="showWorkoutForm()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-plus ml-2"></i>
                        הוסף אימון
                    </button>
                    <button onclick="showCalorieCalculator()" class="bg-purple-600 hover:bg-purple-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-calculator ml-2"></i>
                        חישוב קלוריות
                    </button>
                    <button onclick="window.location.href='/plans?user=${userId}'" class="bg-green-600 hover:bg-green-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-list ml-2"></i>
                        תכניות
                    </button>
                    <button onclick="window.location.href='/nutrition?user=${userId}'" class="bg-gradient-to-r from-green-500 to-teal-500 hover:from-green-600 hover:to-teal-600 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-utensils ml-2"></i>
                        תזונה
                    </button>
                    <button onclick="window.location.href='/settings?user=${userId}'" class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-4 sm:py-5 rounded-lg transition duration-300 text-base sm:text-lg">
                        <i class="fas fa-cog ml-2"></i>
                        הגדרות
                    </button>
                </div>
            </div>
            
            <!-- Quick Calorie Calculator (Hidden) -->
            <div id="calorieCalculatorContainer" class="hidden bg-white rounded-xl shadow-lg p-6 mb-8 border-4 border-purple-500">
                <h3 class="text-xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-calculator ml-2 text-purple-600"></i>
                    מחשבון קלוריות מהיר
                </h3>
                <p class="text-sm text-gray-600 mb-4">חישוב מהיר של קלוריות לפי זמן ועצימות - ללא שמירה</p>
                
                <div class="space-y-4">
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">
                            משך זמן: <span id="durationValue" class="text-purple-600">30</span> דקות
                        </label>
                        <input type="range" id="durationSlider" min="1" max="60" value="30" 
                               class="w-full h-3 bg-purple-200 rounded-lg appearance-none cursor-pointer"
                               oninput="updateCalorieEstimate()">
                        <div class="flex justify-between text-xs text-gray-500 mt-1">
                            <span>1 דקה</span>
                            <span>60 דקות</span>
                        </div>
                    </div>
                    
                    <div>
                        <label class="block text-gray-700 font-bold mb-2">עצימות:</label>
                        <div class="grid grid-cols-3 gap-3">
                            <button type="button" id="intensityLight" onclick="selectIntensity('light')" 
                                    class="intensity-btn bg-green-100 hover:bg-green-200 text-green-800 font-bold py-3 rounded-lg border-2 border-transparent transition">
                                😌 קל
                            </button>
                            <button type="button" id="intensityMedium" onclick="selectIntensity('medium')" 
                                    class="intensity-btn bg-yellow-100 hover:bg-yellow-200 text-yellow-800 font-bold py-3 rounded-lg border-4 border-yellow-500 transition">
                                🔥 בינוני
                            </button>
                            <button type="button" id="intensityHard" onclick="selectIntensity('hard')" 
                                    class="intensity-btn bg-red-100 hover:bg-red-200 text-red-800 font-bold py-3 rounded-lg border-2 border-transparent transition">
                                💪 קשה
                            </button>
                        </div>
                    </div>
                    
                    <div class="bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl p-6 text-center">
                        <p class="text-white text-sm mb-2">קלוריות משוערות:</p>
                        <p id="calorieResult" class="text-white text-5xl font-bold">0</p>
                        <p class="text-purple-100 text-xs mt-2">קלוריות</p>
                    </div>
                    
                    <button onclick="hideCalorieCalculator()" class="w-full bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 rounded-lg">
                        סגור
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

        <!-- Notification Container -->
        <div id="notificationContainer" class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4"></div>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
          const userId = ${userId};
          
          // Notification System (מערכת התראות ללא חסימה)
          function showNotification(message, type = 'info') {
            const container = document.getElementById('notificationContainer')
            const notif = document.createElement('div')
            
            const colors = {
              success: 'bg-green-500',
              error: 'bg-red-500',
              warning: 'bg-yellow-500',
              info: 'bg-blue-500'
            }
            
            const icons = {
              success: '✅',
              error: '❌',
              warning: '⚠️',
              info: 'ℹ️'
            }
            
            notif.className = colors[type] + ' text-white px-6 py-4 rounded-lg shadow-2xl mb-3 transform transition-all duration-500 ease-in-out'
            notif.innerHTML = '<div class="flex items-center gap-3"><span class="text-2xl">' + icons[type] + '</span><span class="font-bold">' + message + '</span></div>'
            
            container.appendChild(notif)
            
            // Animation in
            setTimeout(() => {
              notif.style.opacity = '1'
              notif.style.transform = 'translateY(0)'
            }, 10)
            
            // Auto remove after 4 seconds
            setTimeout(() => {
              notif.style.opacity = '0'
              notif.style.transform = 'translateY(-20px)'
              setTimeout(() => notif.remove(), 500)
            }, 4000)
          }

          // Load dashboard data
          async function loadDashboard() {
            try {
              // Load user data
              const userResponse = await axios.get(\`/api/users/\${userId}\`)
              const userData = userResponse.data.user
              
              // הצגת כפתור Admin Panel למנהלים בלבד
              const userRole = localStorage.getItem('user_role')
              const isImpersonating = localStorage.getItem('impersonating') === 'true'
              
              if (isImpersonating) {
                // Admin is viewing as user - show return button
                document.getElementById('returnToAdminBtn').classList.remove('hidden')
              } else if (userRole === 'admin') {
                // Regular admin - show admin panel button
                document.getElementById('adminPanelBtn').classList.remove('hidden')
              }
              
              // הצגת שם + אימוג'י מין
              const genderEmoji = userData.gender === 'female' ? '👩' : '👨'
              const genderText = userData.gender === 'female' ? 'נקבה' : 'זכר'
              document.getElementById('userName').textContent = \`\${genderEmoji} \${userData.name}\`
              document.getElementById('userGender').textContent = genderText
              
              // הצגת תמונת פרופיל אם קיימת
              if (userData.profile_image && userData.profile_image !== 'null') {
                const profileImg = document.getElementById('userProfileImage')
                profileImg.src = userData.profile_image
                profileImg.classList.remove('hidden')
              }
              
              document.getElementById('currentWeight').textContent = userData.weight_kg + ' ק"ג'
              document.getElementById('targetWeight').textContent = userData.target_weight_kg + ' ק"ג'
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
              loadAchievements()
            } catch (error) {
              console.error('Error loading dashboard:', error)
              console.error('Error details:', error.response?.data || error.message)
              showNotification('שגיאה בטעינת נתונים: ' + (error.response?.data?.error || error.message || 'שגיאה לא ידועה'), 'error')
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
              
              // Show reminders after loading progress
              showWorkoutReminders(data)
            } catch (error) {
              console.error('Error loading weekly progress:', error)
            }
          }
          
          async function showWorkoutReminders(weekData) {
            try {
              // Get last workout date
              const workoutsResponse = await axios.get(\`/api/workouts/user/\${userId}\`)
              const workouts = workoutsResponse.data.workouts
              
              const reminders = []
              
              // Check if no workout today
              const today = new Date().toISOString().split('T')[0]
              const todayWorkout = workouts.find(w => w.workout_date === today)
              
              if (!todayWorkout && workouts.length > 0) {
                const lastWorkout = workouts[0]
                const lastDate = new Date(lastWorkout.workout_date)
                const now = new Date()
                const daysSince = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24))
                
                if (daysSince >= 1) {
                  reminders.push({
                    type: 'warning',
                    icon: 'fa-calendar-xmark',
                    text: \`עבר \${daysSince} \${daysSince === 1 ? 'יום' : 'ימים'} ללא אימון - זמן לקפוץ! 🔥\`,
                    color: 'orange'
                  })
                }
              }
              
              // Check weekly goal progress
              if (weekData.remaining > 0) {
                reminders.push({
                  type: 'info',
                  icon: 'fa-bullseye',
                  text: \`עוד \${weekData.remaining} אימונים ליעד השבועי! 💪\`,
                  color: 'blue'
                })
              } else if (weekData.completed >= weekData.target) {
                reminders.push({
                  type: 'success',
                  icon: 'fa-trophy',
                  text: 'יעד שבועי הושלם! אתה/את מדהים/ה! 🎉',
                  color: 'green'
                })
              }
              
              // Check if user has NO workouts at all
              if (workouts.length === 0) {
                reminders.push({
                  type: 'info',
                  icon: 'fa-rocket',
                  text: 'בואו נתחיל! האימון הראשון שלך מחכה 🚀',
                  color: 'indigo'
                })
              }
              
              // Display reminders
              if (reminders.length > 0) {
                const colors = {
                  orange: 'bg-orange-50 border-orange-200 text-orange-800',
                  blue: 'bg-blue-50 border-blue-200 text-blue-800',
                  green: 'bg-green-50 border-green-200 text-green-800',
                  indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800'
                }
                
                const remindersHtml = reminders.map(r => \`
                  <div class="rounded-xl border-2 \${colors[r.color]} p-4 flex items-center gap-3 animate-pulse">
                    <i class="fas \${r.icon} text-2xl"></i>
                    <p class="font-semibold">\${r.text}</p>
                  </div>
                \`).join('')
                
                document.getElementById('workoutReminders').innerHTML = remindersHtml
              }
            } catch (error) {
              console.error('Error showing reminders:', error)
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
              
              // Calculate trend line (linear regression)
              const weights = data.map(d => d.weight)
              const n = weights.length
              const indices = Array.from({length: n}, (_, i) => i)
              const sumX = indices.reduce((a, b) => a + b, 0)
              const sumY = weights.reduce((a, b) => a + b, 0)
              const sumXY = indices.reduce((sum, x, i) => sum + x * weights[i], 0)
              const sumX2 = indices.reduce((sum, x) => sum + x * x, 0)
              
              const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
              const intercept = (sumY - slope * sumX) / n
              const trendLine = indices.map(i => slope * i + intercept)
              
              // Calculate % change from start
              const startWeight = weights[0]
              const currentWeight = weights[weights.length - 1]
              const percentChange = (((currentWeight - startWeight) / startWeight) * 100).toFixed(1)
              const changeText = percentChange > 0 ? \`+\${percentChange}%\` : \`\${percentChange}%\`
              
              // Color points based on trend (green = down, red = up)
              const pointColors = weights.map((weight, i) => {
                if (i === 0) return '#667eea'
                return weight < weights[i-1] ? '#10b981' : weight > weights[i-1] ? '#ef4444' : '#667eea'
              })
              
              const ctx = document.getElementById('weightChart').getContext('2d')
              new Chart(ctx, {
                type: 'line',
                data: {
                  labels: data.map(d => d.date),
                  datasets: [
                    {
                      label: 'משקל (ק"ג)',
                      data: weights,
                      borderColor: '#667eea',
                      backgroundColor: 'rgba(102, 126, 234, 0.1)',
                      tension: 0.4,
                      fill: true,
                      pointBackgroundColor: pointColors,
                      pointBorderColor: pointColors,
                      pointRadius: 6,
                      pointHoverRadius: 8,
                      pointBorderWidth: 2
                    },
                    {
                      label: 'מגמה',
                      data: trendLine,
                      borderColor: 'rgba(251, 191, 36, 0.6)',
                      borderDash: [5, 5],
                      borderWidth: 2,
                      fill: false,
                      pointRadius: 0,
                      tension: 0
                    }
                  ]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: true,
                  animation: {
                    duration: 1500,
                    easing: 'easeInOutQuart'
                  },
                  plugins: {
                    legend: { 
                      display: true,
                      position: 'top',
                      labels: {
                        font: { size: 12 },
                        usePointStyle: true
                      }
                    },
                    tooltip: {
                      callbacks: {
                        title: (items) => items[0].label,
                        label: (context) => {
                          if (context.datasetIndex === 1) return 'מגמה: ' + context.parsed.y.toFixed(1) + ' ק"ג'
                          return 'משקל: ' + context.parsed.y + ' ק"ג'
                        },
                        afterLabel: (context) => {
                          if (context.datasetIndex === 0 && context.dataIndex > 0) {
                            const prev = weights[context.dataIndex - 1]
                            const curr = weights[context.dataIndex]
                            const diff = curr - prev
                            const diffText = diff > 0 ? \`+\${diff.toFixed(1)}\` : diff.toFixed(1)
                            return \`שינוי: \${diffText} ק"ג\`
                          }
                          return ''
                        }
                      }
                    },
                    title: {
                      display: true,
                      text: \`שינוי כולל: \${changeText}\`,
                      font: { size: 14, weight: 'bold' },
                      color: percentChange < 0 ? '#10b981' : '#ef4444'
                    }
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

          async function loadAchievements() {
            try {
              // Check for new achievements
              await axios.post(\`/api/achievements/check/\${userId}\`)
              
              // Load all achievements
              const response = await axios.get(\`/api/achievements/user/\${userId}\`)
              const achievements = response.data.achievements
              
              if (achievements.length === 0) {
                document.getElementById('achievementsContainer').innerHTML = 
                  '<p class="text-gray-500 text-center col-span-full">עדיין אין הישגים - המשך להתאמן! 💪</p>'
                return
              }
              
              const achievementsHtml = achievements.map(a => \`
                <div class="bg-gradient-to-br from-yellow-50 to-orange-50 border-2 border-yellow-300 rounded-xl p-4 text-center hover:scale-105 transition-transform">
                  <h4 class="text-3xl font-bold text-gray-800 mb-2">\${a.achievement_name}</h4>
                  <p class="text-xs text-gray-500 mt-2">\${new Date(a.earned_date).toLocaleDateString('he-IL')}</p>
                </div>
              \`).join('')
              
              document.getElementById('achievementsContainer').innerHTML = achievementsHtml
            } catch (error) {
              console.error('Error loading achievements:', error)
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
                showNotification(\`אימון נשמר! שרפת \${parseFloat(response.data.calories_burned).toFixed(2)} קלוריות 🔥\`, 'success')
                hideWorkoutForm()
                loadDashboard()
              }
            } catch (error) {
              showNotification('שגיאה בשמירת אימון: ' + (error.response?.data?.error || error.message), 'error')
            }
          })

          // Calorie Calculator Functions
          let currentIntensity = 'medium'
          
          function showCalorieCalculator() {
            document.getElementById('calorieCalculatorContainer').classList.remove('hidden')
            updateCalorieEstimate()
          }
          
          function hideCalorieCalculator() {
            document.getElementById('calorieCalculatorContainer').classList.add('hidden')
          }
          
          function selectIntensity(intensity) {
            currentIntensity = intensity
            
            // Reset all buttons
            document.getElementById('intensityLight').className = 'intensity-btn bg-green-100 hover:bg-green-200 text-green-800 font-bold py-3 rounded-lg border-2 border-transparent transition'
            document.getElementById('intensityMedium').className = 'intensity-btn bg-yellow-100 hover:bg-yellow-200 text-yellow-800 font-bold py-3 rounded-lg border-2 border-transparent transition'
            document.getElementById('intensityHard').className = 'intensity-btn bg-red-100 hover:bg-red-200 text-red-800 font-bold py-3 rounded-lg border-2 border-transparent transition'
            
            // Highlight selected
            if (intensity === 'light') {
              document.getElementById('intensityLight').className = 'intensity-btn bg-green-100 hover:bg-green-200 text-green-800 font-bold py-3 rounded-lg border-4 border-green-500 transition'
            } else if (intensity === 'medium') {
              document.getElementById('intensityMedium').className = 'intensity-btn bg-yellow-100 hover:bg-yellow-200 text-yellow-800 font-bold py-3 rounded-lg border-4 border-yellow-500 transition'
            } else {
              document.getElementById('intensityHard').className = 'intensity-btn bg-red-100 hover:bg-red-200 text-red-800 font-bold py-3 rounded-lg border-4 border-red-500 transition'
            }
            
            updateCalorieEstimate()
          }
          
          function updateCalorieEstimate() {
            const duration = document.getElementById('durationSlider').value
            document.getElementById('durationValue').textContent = duration
            
            // MET values for jumping rope
            const metValues = {
              'light': 8.8,    // Easy pace
              'medium': 11.8,  // Moderate pace
              'hard': 12.3     // Vigorous pace
            }
            
            const met = metValues[currentIntensity]
            
            // Assuming average weight of 70kg
            const weight = 70
            const calories = Math.round((met * weight * duration) / 60)
            
            document.getElementById('calorieResult').textContent = calories
          }

          // Return to admin panel
          function returnToAdmin() {
            // Restore admin credentials
            const adminUserId = localStorage.getItem('admin_user_id')
            const adminSessionToken = localStorage.getItem('admin_session_token')
            const adminUserName = localStorage.getItem('admin_user_name')
            
            localStorage.setItem('user_id', adminUserId)
            localStorage.setItem('session_token', adminSessionToken)
            localStorage.setItem('user_name', adminUserName)
            
            // Clear impersonation flags
            localStorage.removeItem('impersonating')
            localStorage.removeItem('admin_user_id')
            localStorage.removeItem('admin_session_token')
            localStorage.removeItem('admin_user_name')
            
            // Redirect to admin panel
            window.location.href = '/admin'
          }

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
                    <div class="flex items-center gap-2">
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    </div>
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
                        
                        <!-- Share Buttons -->
                        <div class="flex gap-3 mb-6">
                            <button onclick="sendPlanByEmail()" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition duration-300 flex items-center justify-center gap-2">
                                <i class="fas fa-envelope"></i>
                                שלח למייל
                            </button>
                            <button onclick="sendPlanByWhatsApp()" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition duration-300 flex items-center justify-center gap-2">
                                <i class="fab fa-whatsapp"></i>
                                שלח ב-WhatsApp
                            </button>
                        </div>
                        
                        <div id="planDetailsContent"></div>
                    </div>
                </div>
            </div>
        </main>

        <!-- Notification Container -->
        <div id="notificationContainer" class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4"></div>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};
            
            // Notification System (מערכת התראות ללא חסימה)
            function showNotification(message, type = 'info') {
              const container = document.getElementById('notificationContainer')
              const notif = document.createElement('div')
              
              const colors = {
                success: 'bg-green-500',
                error: 'bg-red-500',
                warning: 'bg-yellow-500',
                info: 'bg-blue-500'
              }
              
              const icons = {
                success: '✅',
                error: '❌',
                warning: '⚠️',
                info: 'ℹ️'
              }
              
              notif.className = colors[type] + ' text-white px-6 py-4 rounded-lg shadow-2xl mb-3 transform transition-all duration-500 ease-in-out'
              notif.innerHTML = '<div class="flex items-center gap-3"><span class="text-2xl">' + icons[type] + '</span><span class="font-bold">' + message + '</span></div>'
              
              container.appendChild(notif)
              
              // Animation in
              setTimeout(() => {
                notif.style.opacity = '1'
                notif.style.transform = 'translateY(0)'
              }, 10)
              
              // Auto remove after 4 seconds
              setTimeout(() => {
                notif.style.opacity = '0'
                notif.style.transform = 'translateY(-20px)'
                setTimeout(() => notif.remove(), 500)
              }, 4000)
            }

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
                    console.error('Error loading plans:', error)
                    showNotification('שגיאה בטעינת תכניות: ' + error.message, 'error')
                }
            }

            async function viewPlanDetails(planId) {
                currentPlanId = planId  // Save for sharing
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
                    showNotification('שגיאה בטעינת פרטי תכנית: ' + error.message, 'error')
                }
            }

            function closePlanDetails() {
                document.getElementById('planDetailsModal').classList.add('hidden')
                currentPlanId = null
            }

            function startWorkoutTimer(sessionId, planId) {
                window.location.href = \`/workout-timer?user=\${userId}&session=\${sessionId}&plan=\${planId}\`;
            }

            let currentPlanId = null
            
            async function sendPlanByEmail() {
                if (!currentPlanId) {
                    showNotification('אנא בחר תכנית תחילה', 'error')
                    return
                }
                
                try {
                    // Get user email
                    const userResponse = await axios.get(\`/api/users/\${userId}\`)
                    const userEmail = userResponse.data.user.email
                    
                    if (!userEmail) {
                        showNotification('לא נמצא מייל במערכת. אנא הוסף מייל בהגדרות', 'warning')
                        return
                    }
                    
                    // Send email
                    const response = await axios.post(\`/api/plans/\${currentPlanId}/email\`, {
                        email: userEmail
                    })
                    
                    if (response.data.success) {
                        showNotification('התכנית נשלחה למייל בהצלחה! 📧', 'success')
                    } else {
                        showNotification(response.data.message || 'שליחת מייל תהיה זמינה בקרוב 🚧', 'info')
                    }
                } catch (error) {
                    showNotification('שגיאה בשליחה: ' + error.message, 'error')
                }
            }
            
            async function sendPlanByWhatsApp() {
                if (!currentPlanId) {
                    showNotification('אנא בחר תכנית תחילה', 'error')
                    return
                }
                
                try {
                    // Get user phone
                    const userResponse = await axios.get(\`/api/users/\${userId}\`)
                    const userPhone = userResponse.data.user.phone
                    
                    let phone = userPhone
                    
                    // If no phone in system, ask for it
                    if (!phone) {
                        phone = prompt('הזן מספר טלפון עם קוד מדינה (לדוגמה: 972501234567):')
                        if (!phone) {
                            showNotification('ביטול שליחה', 'info')
                            return
                        }
                    }
                    
                    // Send via WhatsApp
                    const response = await axios.post(\`/api/plans/\${currentPlanId}/share\`, {
                        phone_number: phone,
                        method: 'whatsapp'
                    })
                    
                    if (response.data.success) {
                        window.open(response.data.share_url, '_blank')
                        showNotification('קישור WhatsApp נוצר בהצלחה! 📱', 'success')
                    }
                } catch (error) {
                    showNotification('שגיאה בשליחה: ' + error.message, 'error')
                }
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

/**
 * מסך טיימר אימון - Redirect to static HTML
 */
app.get('/workout-timer', async (c) => {
  const userId = c.req.query('user')
  const sessionId = c.req.query('session')
  const planId = c.req.query('plan')
  
  if (!userId || !sessionId || !planId) {
    return c.redirect(`/dashboard?user=${userId || 1}`)
  }

  // Return HTML directly (Cloudflare Workers cannot serve static HTML files)
  // TODO: This is a workaround - ideally workout-timer should be a separate route
  return c.html(`
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>טיימר אימון - קפיצה בחבל</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        }
        .timer-circle {
            width: 300px;
            height: 300px;
            position: relative;
            margin: 0 auto;
        }
        .timer-display {
            font-size: 4rem;
            font-weight: bold;
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
        }
        .pulse {
            animation: pulse 1s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        .work-phase {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .rest-phase {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
        }
        .progress-bar-container {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 8px;
            background: rgba(0,0,0,0.1);
            z-index: 100;
        }
        .progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            transition: width 0.3s ease;
        }
    </style>
</head>
<body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
    <!-- Header -->
    <header class="bg-white shadow-md">
        <div class="max-w-7xl mx-auto px-4 py-4">
            <div class="flex items-center justify-between">
                <img src="/static/logo.svg" alt="קפיצה לחיים" class="h-12" />
                <button onclick="exitWorkout()" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-lg">
                    <i class="fas fa-times ml-2"></i>
                    יציאה
                </button>
            </div>
        </div>
    </header>

    <!-- Main Timer -->
    <main class="max-w-4xl mx-auto px-4 py-8">
        <!-- Timer Card -->
        <div id="timerCard" class="bg-white rounded-xl shadow-2xl p-8 mb-6 transition-all duration-500">
            <!-- Phase Indicator -->
            <div class="text-center mb-6">
                <div id="phaseIndicator" class="inline-block px-6 py-3 rounded-full text-2xl font-bold">
                    מוכן להתחלה
                </div>
            </div>

            <!-- Timer Circle -->
            <div class="timer-circle mb-6">
                <svg width="300" height="300" style="transform: rotate(-90deg)">
                    <circle cx="150" cy="150" r="140" stroke="#e5e7eb" stroke-width="12" fill="none"/>
                    <circle id="progressCircle" cx="150" cy="150" r="140" stroke="#667eea" stroke-width="12" fill="none" 
                            stroke-dasharray="879.6" stroke-dashoffset="879.6" stroke-linecap="round"
                            style="transition: stroke-dashoffset 0.3s ease"/>
                </svg>
                <div class="timer-display" id="timerDisplay">00:00</div>
            </div>

            <!-- Current Set Info -->
            <div class="text-center mb-6">
                <div class="text-4xl font-bold text-gray-800 mb-2" id="setCounter">סט 0/0</div>
                <div class="text-xl text-gray-600" id="nextPhaseInfo">לחץ התחל כדי להתחיל</div>
            </div>

            <!-- Control Buttons -->
            <div class="flex justify-center gap-4 mb-6">
                <button id="startBtn" onclick="startTimer()" class="bg-green-600 hover:bg-green-700 text-white font-bold py-4 px-8 rounded-lg text-xl">
                    <i class="fas fa-play ml-2"></i>
                    התחל
                </button>
                <button id="pauseBtn" onclick="pauseTimer()" class="hidden bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-4 px-8 rounded-lg text-xl">
                    <i class="fas fa-pause ml-2"></i>
                    השהה
                </button>
                <button id="resumeBtn" onclick="resumeTimer()" class="hidden bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-8 rounded-lg text-xl">
                    <i class="fas fa-play ml-2"></i>
                    המשך
                </button>
                <button id="skipBtn" onclick="skipPhase()" class="hidden bg-orange-600 hover:bg-orange-700 text-white font-bold py-4 px-8 rounded-lg text-xl">
                    <i class="fas fa-forward ml-2"></i>
                    דלג
                </button>
            </div>

            <!-- Stats -->
            <div class="grid grid-cols-3 gap-4 text-center">
                <div class="bg-gray-50 rounded-lg p-4">
                    <div class="text-3xl font-bold text-indigo-600" id="totalTime">0:00</div>
                    <div class="text-sm text-gray-600">זמן כולל</div>
                </div>
                <div class="bg-gray-50 rounded-lg p-4">
                    <div class="text-3xl font-bold text-orange-600" id="caloriesBurned">0</div>
                    <div class="text-sm text-gray-600">קלוריות</div>
                </div>
                <div class="bg-gray-50 rounded-lg p-4">
                    <div class="text-3xl font-bold text-green-600" id="completedSets">0</div>
                    <div class="text-sm text-gray-600">סטים הושלמו</div>
                </div>
            </div>
        </div>

        <!-- Progress Bar at Bottom -->
        <div class="progress-bar-container">
            <div id="progressBarFill" class="progress-bar-fill" style="width: 0%"></div>
        </div>

        <!-- Completion Modal -->
        <div id="completionModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 text-center">
                <div class="text-6xl mb-4">🎉</div>
                <h2 class="text-3xl font-bold text-gray-800 mb-4">כל הכבוד!</h2>
                <p class="text-xl text-gray-600 mb-6">סיימת את האימון בהצלחה!</p>
                
                <div class="bg-gray-50 rounded-lg p-6 mb-6">
                    <div class="grid grid-cols-2 gap-4 text-right">
                        <div>
                            <div class="text-sm text-gray-600">זמן כולל</div>
                            <div class="text-2xl font-bold text-indigo-600" id="finalTime"></div>
                        </div>
                        <div>
                            <div class="text-sm text-gray-600">קלוריות</div>
                            <div class="text-2xl font-bold text-orange-600" id="finalCalories"></div>
                        </div>
                        <div>
                            <div class="text-sm text-gray-600">סטים</div>
                            <div class="text-2xl font-bold text-green-600" id="finalSets"></div>
                        </div>
                        <div>
                            <div class="text-sm text-gray-600">עצימות</div>
                            <div class="text-2xl font-bold text-purple-600" id="finalIntensity"></div>
                        </div>
                    </div>
                </div>

                <div class="space-y-3">
                    <button onclick="saveWorkout()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg">
                        <i class="fas fa-save ml-2"></i>
                        שמור אימון
                    </button>
                    <button onclick="exitWorkout()" class="w-full bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 rounded-lg">
                        חזור לדשבורד
                    </button>
                </div>
            </div>
        </div>
    </main>

    <!-- Audio Elements -->
    <audio id="startSound" preload="auto">
        <source src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBDGD0fPTgjMGHm7A7+OZSR0RVq3r8K1gGQU+kdvvxnMjBSuBzvLaiTcIGWe77OWdTQwNUKnk8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8A==" type="audio/wav">
    </audio>
    <audio id="endSound" preload="auto">
        <source src="data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBDGD0fPTgjMGHm7A7+OZSR0RVq3r8K1gGQU+kdvvxnMjBSuBzvLaiTcIGWe77OWdTQwNUKnk8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8LViFAk5j9vyxnksBS2Ay/HajDkIGWi+7+SbTQwMUKjj8A==" type="audio/wav">
    </audio>

    <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    <script>
        // Get URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('user');
        const sessionId = urlParams.get('session');
        const planId = urlParams.get('plan');

        // Timer state
        let timerState = {
            isRunning: false,
            isPaused: false,
            currentPhase: 'ready',
            currentSet: 0,
            totalSets: 0,
            workTime: 0,
            restTime: 0,
            currentTime: 0,
            totalWorkTime: 0,
            completedSets: 0,
            startTime: null,
            timerInterval: null,
            userWeight: 0,
            intensity: 'medium'
        };

        async function loadSessionData() {
            try {
                if (sessionId && planId) {
                    const response = await axios.get(\`/api/plans/\${planId}\`);
                    const session = response.data.sessions.find(s => s.id == sessionId);
                    
                    if (session) {
                        timerState.totalSets = session.sets_count;
                        timerState.workTime = session.work_seconds;
                        timerState.restTime = session.rest_seconds;
                        timerState.intensity = session.intensity;
                    } else {
                        alert('אימון לא נמצא במערכת');
                        return;
                    }
                } else {
                    alert('חסרים פרמטרים (session/plan)');
                    return;
                }
                
                if (userId) {
                    const userResponse = await axios.get(\`/api/users/\${userId}\`);
                    timerState.userWeight = userResponse.data.user.weight_kg;
                }
                
                updateSetCounter();
            } catch (error) {
                console.error('Error loading session:', error);
                alert('שגיאה בטעינת נתוני אימון');
            }
        }

        function startTimer() {
            if (timerState.totalSets === 0) {
                alert('לא נטענו נתוני אימון');
                return;
            }
            
            timerState.isRunning = true;
            timerState.currentSet = 1;
            timerState.currentPhase = 'work';
            timerState.currentTime = timerState.workTime;
            timerState.startTime = Date.now();
            
            document.getElementById('startBtn').classList.add('hidden');
            document.getElementById('pauseBtn').classList.remove('hidden');
            document.getElementById('skipBtn').classList.remove('hidden');
            
            playSound('startSound');
            updateUI();
            startTimerInterval();
        }

        function startTimerInterval() {
            timerState.timerInterval = setInterval(() => {
                if (!timerState.isPaused) {
                    timerState.currentTime--;
                    
                    if (timerState.currentTime <= 0) {
                        handlePhaseComplete();
                    }
                    
                    updateUI();
                }
            }, 1000);
        }

        function handlePhaseComplete() {
            playSound('endSound');
            
            if (timerState.currentPhase === 'work') {
                timerState.totalWorkTime += timerState.workTime;
                
                if (timerState.currentSet < timerState.totalSets) {
                    timerState.currentPhase = 'rest';
                    timerState.currentTime = timerState.restTime;
                } else {
                    timerState.completedSets = timerState.currentSet;
                    completeWorkout();
                    return;
                }
            } else if (timerState.currentPhase === 'rest') {
                timerState.currentSet++;
                timerState.currentPhase = 'work';
                timerState.currentTime = timerState.workTime;
                playSound('startSound');
            }
            
            updateUI();
        }

        function pauseTimer() {
            timerState.isPaused = true;
            document.getElementById('pauseBtn').classList.add('hidden');
            document.getElementById('resumeBtn').classList.remove('hidden');
        }

        function resumeTimer() {
            timerState.isPaused = false;
            document.getElementById('pauseBtn').classList.remove('hidden');
            document.getElementById('resumeBtn').classList.add('hidden');
        }

        function skipPhase() {
            if (confirm('האם אתה בטוח שברצונך לדלג על שלב זה?')) {
                timerState.currentTime = 0;
            }
        }

        function updateUI() {
            const minutes = Math.floor(timerState.currentTime / 60);
            const seconds = timerState.currentTime % 60;
            document.getElementById('timerDisplay').textContent = 
                \`\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
            
            const phaseIndicator = document.getElementById('phaseIndicator');
            const timerCard = document.getElementById('timerCard');
            
            if (timerState.currentPhase === 'work') {
                phaseIndicator.textContent = '🔥 קפיצה!';
                phaseIndicator.className = 'inline-block px-6 py-3 rounded-full text-2xl font-bold bg-indigo-600 text-white pulse';
                timerCard.classList.remove('rest-phase');
                timerCard.classList.add('work-phase');
            } else if (timerState.currentPhase === 'rest') {
                phaseIndicator.textContent = '⏸️ מנוחה';
                phaseIndicator.className = 'inline-block px-6 py-3 rounded-full text-2xl font-bold bg-orange-500 text-white';
                timerCard.classList.remove('work-phase');
                timerCard.classList.add('rest-phase');
            }
            
            document.getElementById('setCounter').textContent = 
                \`סט \${timerState.currentSet}/\${timerState.totalSets}\`;
            
            if (timerState.currentPhase === 'work') {
                document.getElementById('nextPhaseInfo').textContent = 
                    \`הבא: מנוחה \${timerState.restTime} שניות\`;
            } else if (timerState.currentPhase === 'rest') {
                document.getElementById('nextPhaseInfo').textContent = 
                    \`הבא: קפיצה \${timerState.workTime} שניות\`;
            }
            
            const maxTime = timerState.currentPhase === 'work' ? timerState.workTime : timerState.restTime;
            const progress = (maxTime - timerState.currentTime) / maxTime;
            const circumference = 879.6;
            const offset = circumference - (progress * circumference);
            document.getElementById('progressCircle').style.strokeDashoffset = offset;
            
            if (timerState.startTime) {
                const elapsedSeconds = Math.floor((Date.now() - timerState.startTime) / 1000);
                const totalMinutes = Math.floor(elapsedSeconds / 60);
                const totalSeconds = elapsedSeconds % 60;
                document.getElementById('totalTime').textContent = 
                    \`\${totalMinutes}:\${totalSeconds.toString().padStart(2, '0')}\`;
            }
            
            const workMinutes = timerState.totalWorkTime / 60;
            const calories = calculateCalories(workMinutes);
            document.getElementById('caloriesBurned').textContent = Math.round(calories);
            
            const completedForDisplay = timerState.currentPhase === 'work' ? 
                timerState.currentSet - 1 : timerState.currentSet;
            document.getElementById('completedSets').textContent = completedForDisplay;
            
            const totalProgress = (timerState.currentSet - 1 + 
                (timerState.currentPhase === 'rest' ? 1 : (timerState.workTime - timerState.currentTime) / timerState.workTime)) 
                / timerState.totalSets;
            document.getElementById('progressBarFill').style.width = (totalProgress * 100) + '%';
        }

        function updateSetCounter() {
            document.getElementById('setCounter').textContent = \`סט 0/\${timerState.totalSets}\`;
            document.getElementById('nextPhaseInfo').textContent = 
                \`\${timerState.totalSets} סטים × \${timerState.workTime} שניות קפיצה / \${timerState.restTime} שניות מנוחה\`;
        }

        function calculateCalories(minutes) {
            const metValues = { easy: 8.8, medium: 11.8, hard: 12.3 };
            const met = metValues[timerState.intensity] || 11.8;
            return 0.0175 * met * timerState.userWeight * minutes;
        }

        function playSound(soundId) {
            const sound = document.getElementById(soundId);
            sound.currentTime = 0;
            sound.play().catch(e => console.log('Audio play failed:', e));
        }

        function completeWorkout() {
            clearInterval(timerState.timerInterval);
            timerState.isRunning = false;
            
            const totalSeconds = Math.floor((Date.now() - timerState.startTime) / 1000);
            const totalMinutes = Math.floor(totalSeconds / 60);
            const remainingSeconds = totalSeconds % 60;
            
            const workMinutes = timerState.totalWorkTime / 60;
            const calories = calculateCalories(workMinutes);
            
            document.getElementById('finalTime').textContent = 
                \`\${totalMinutes}:\${remainingSeconds.toString().padStart(2, '0')}\`;
            document.getElementById('finalCalories').textContent = Math.round(calories);
            document.getElementById('finalSets').textContent = timerState.completedSets;
            document.getElementById('finalIntensity').textContent = 
                timerState.intensity === 'easy' ? 'קל' : 
                timerState.intensity === 'medium' ? 'בינוני' : 'קשה';
            
            document.getElementById('completionModal').classList.remove('hidden');
        }

        async function saveWorkout() {
            const workMinutes = timerState.totalWorkTime / 60;
            const calories = calculateCalories(workMinutes);
            
            const workoutData = {
                user_id: parseInt(userId),
                plan_id: planId ? parseInt(planId) : null,
                session_id: sessionId ? parseInt(sessionId) : null,
                workout_date: new Date().toISOString().split('T')[0],
                work_minutes: workMinutes,
                sets_completed: timerState.completedSets,
                intensity: timerState.intensity,
                notes: \`אימון הושלם דרך הטיימר\`
            };
            
            try {
                const response = await axios.post('/api/workouts', workoutData);
                if (response.data.success) {
                    alert('אימון נשמר בהצלחה! 🎉');
                    window.location.href = \`/dashboard?user=\${userId}\`;
                }
            } catch (error) {
                alert('שגיאה בשמירת אימון: ' + (error.response?.data?.error || error.message));
            }
        }

        function exitWorkout() {
            if (timerState.isRunning && !confirm('האם אתה בטוח שברצונך לצאת? האימון לא יישמר.')) {
                return;
            }
            window.location.href = \`/dashboard?user=\${userId}\`;
        }

        loadSessionData();
    </script>
</body>
</html>
  `)
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
                    <div class="flex items-center gap-2">
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    </div>
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
            
            // Confirmation Dialog (דיאלוג אישור יפה)
            function showConfirmDialog(message, onConfirm, onCancel) {
              const overlay = document.createElement('div')
              overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
              
              const dialog = document.createElement('div')
              dialog.className = 'bg-white rounded-xl shadow-2xl p-8 max-w-md mx-4'
              
              dialog.innerHTML = '<div class="text-center"><div class="text-6xl mb-4">⚠️</div><p class="text-gray-800 text-xl font-bold mb-6 leading-relaxed">' + message + '</p><div class="flex gap-4"><button id="cancelBtn" class="flex-1 bg-gray-500 hover:bg-gray-600 text-white font-bold py-4 px-6 rounded-lg transition text-lg">ביטול</button><button id="confirmBtn" class="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-4 px-6 rounded-lg transition text-lg">אישור</button></div></div>'
              
              overlay.appendChild(dialog)
              document.body.appendChild(overlay)
              
              document.getElementById('confirmBtn').onclick = function() {
                document.body.removeChild(overlay)
                if (onConfirm) onConfirm()
              }
              
              document.getElementById('cancelBtn').onclick = function() {
                document.body.removeChild(overlay)
                if (onCancel) onCancel()
              }
              
              overlay.onclick = function(e) {
                if (e.target === overlay) {
                  document.body.removeChild(overlay)
                  if (onCancel) onCancel()
                }
              }
            }

            async function loadWorkoutDetails() {
                try {
                    // Get workout data
                    const response = await axios.get(\`/api/workouts/user/\${userId}\`);
                    workoutData = response.data.workouts.find(w => w.id == workoutId);
                    
                    if (!workoutData) {
                        showNotification('אימון לא נמצא', 'error');
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
                    showNotification('שגיאה בטעינת פרטי אימון', 'error');
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
                        showNotification('האימון עודכן בהצלחה', 'success');
                        window.location.reload();
                    } catch (error) {
                        showNotification('שגיאה בעדכון אימון: ' + (error.response?.data?.error || error.message), 'error');
                    }
                });
            }
            
            function closeEditForm() {
                const form = document.querySelector('.fixed.inset-0');
                if (form) form.remove();
            }

            async function deleteWorkout() {
                const userConfirmed = await new Promise(resolve => {
                    showConfirmDialog('האם אתה בטוח שברצונך למחוק אימון זה? פעולה זו אינה הפיכה.', () => resolve(true), () => resolve(false));
                });
                if (!userConfirmed) return;

                try {
                    await axios.delete(\`/api/workouts/\${workoutId}\`);
                    showNotification('אימון נמחק בהצלחה', 'success');
                    window.location.href = '/dashboard?user=' + userId;
                } catch (error) {
                    showNotification('שגיאה במחיקת אימון: ' + (error.response?.data?.error || error.message), 'error');
                }
            }

            async function duplicateWorkout() {
                const userConfirmed = await new Promise(resolve => {
                    showConfirmDialog('האם ברצונך לשכפל אימון זה להיום?', () => resolve(true), () => resolve(false));
                });
                if (!userConfirmed) return;

                try {
                    const response = await axios.post(\`/api/workouts/\${workoutId}/duplicate\`);
                    if (response.data.success) {
                        showNotification('אימון שוכפל בהצלחה', 'success');
                        window.location.href = '/dashboard?user=' + userId;
                    }
                } catch (error) {
                    showNotification('שגיאה בשכפול אימון: ' + (error.response?.data?.error || error.message), 'error');
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
                    <div class="flex items-center gap-2">
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    </div>
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

        <!-- Notification Container -->
        <div id="notificationContainer" class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4"></div>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};
            let selectedIntensity = 'medium';
            let targetSeconds = 0;
            let elapsedSeconds = 0;
            let timerInterval = null;
            let isPaused = false;
            let userWeight = 0;
            
            // Notification System (מערכת התראות ללא חסימה)
            function showNotification(message, type = 'info') {
              const container = document.getElementById('notificationContainer')
              const notif = document.createElement('div')
              
              const colors = {
                success: 'bg-green-500',
                error: 'bg-red-500',
                warning: 'bg-yellow-500',
                info: 'bg-blue-500'
              }
              
              const icons = {
                success: '✅',
                error: '❌',
                warning: '⚠️',
                info: 'ℹ️'
              }
              
              notif.className = colors[type] + ' text-white px-6 py-4 rounded-lg shadow-2xl mb-3 transform transition-all duration-500 ease-in-out'
              notif.innerHTML = '<div class="flex items-center gap-3"><span class="text-2xl">' + icons[type] + '</span><span class="font-bold">' + message + '</span></div>'
              
              container.appendChild(notif)
              
              // Animation in
              setTimeout(() => {
                notif.style.opacity = '1'
                notif.style.transform = 'translateY(0)'
              }, 10)
              
              // Auto remove after 4 seconds
              setTimeout(() => {
                notif.style.opacity = '0'
                notif.style.transform = 'translateY(-20px)'
                setTimeout(() => notif.remove(), 500)
              }, 4000)
            }

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
                showConfirm('האם אתה בטוח שברצונך לעצור? התקדמותך תישמר.', function() {
                    completeWorkout();
                });
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
                    
                    showNotification('אימון נשמר בהצלחה', 'success');
                    window.location.href = '/dashboard?user=' + userId;
                } catch (error) {
                    showNotification('שגיאה בשמירת אימון: ' + (error.response?.data?.error || error.message), 'error');
                }
            }

            function cancelWorkout() {
                showConfirm('האם אתה בטוח? האימון לא יישמר.', function() {
                    window.location.href = '/dashboard?user=' + userId;
                });
            }
            
            // Confirmation Dialog System (מערכת אישורים יפה)
            function showConfirm(message, onConfirm, onCancel) {
              const overlay = document.createElement('div')
              overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
              
              const dialog = document.createElement('div')
              dialog.className = 'bg-white rounded-xl shadow-2xl p-8 max-w-md mx-4'
              
              dialog.innerHTML = '<div class="text-center"><div class="text-6xl mb-4">⚠️</div><p class="text-gray-800 text-xl font-bold mb-6 leading-relaxed">' + message + '</p><div class="flex gap-4"><button id="cancelBtn" class="flex-1 bg-gray-500 hover:bg-gray-600 text-white font-bold py-4 px-6 rounded-lg transition text-lg">ביטול</button><button id="confirmBtn" class="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-4 px-6 rounded-lg transition text-lg">אישור</button></div></div>'
              
              overlay.appendChild(dialog)
              document.body.appendChild(overlay)
              
              document.getElementById('confirmBtn').onclick = function() {
                document.body.removeChild(overlay)
                if (onConfirm) onConfirm()
              }
              
              document.getElementById('cancelBtn').onclick = function() {
                document.body.removeChild(overlay)
                if (onCancel) onCancel()
              }
              
              overlay.onclick = function(e) {
                if (e.target === overlay) {
                  document.body.removeChild(overlay)
                  if (onCancel) onCancel()
                }
              }
            }

            loadUserData();
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
        <!-- Header -->
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                    </div>
                    <a href="/dashboard?user=${userId}" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
                        <i class="fas fa-arrow-right ml-2"></i>
                        חזרה לדשבורד
                    </a>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <main class="max-w-4xl mx-auto px-4 py-8">
            <h1 class="text-3xl font-bold text-gray-800 mb-8">
                <i class="fas fa-cog ml-2"></i>
                הגדרות
            </h1>

            <!-- Profile Image Section -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-camera ml-2"></i>
                    תמונת פרופיל
                </h2>
                <div class="flex items-center gap-6 mb-4">
                    <img id="currentProfileImage" src="" alt="Profile" class="h-32 w-32 rounded-full object-cover border-4 border-indigo-500 hidden" />
                    <div id="noImagePlaceholder" class="h-32 w-32 rounded-full bg-gray-200 flex items-center justify-center border-4 border-gray-300">
                        <i class="fas fa-user text-6xl text-gray-400"></i>
                    </div>
                </div>
                
                <div class="space-y-4">
                    <input type="file" id="imageInput" accept="image/*" class="hidden" />
                    <div class="flex gap-4">
                        <button onclick="document.getElementById('imageInput').click()" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition">
                            <i class="fas fa-image ml-2"></i>
                            העלה מהגלריה
                        </button>
                        <button onclick="capturePhoto()" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition">
                            <i class="fas fa-camera ml-2"></i>
                            צלם תמונה
                        </button>
                    </div>
                    <button onclick="removeProfileImage()" class="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-2 rounded-lg transition">
                        <i class="fas fa-trash ml-2"></i>
                        מחק תמונה
                    </button>
                </div>
            </div>

            <!-- Edit User Profile -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-user-edit ml-2"></i>
                    עריכת פרטים
                </h2>
                <button onclick="openEditProfile()" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-lg transition text-xl">
                    <i class="fas fa-edit ml-2"></i>
                    ערוך פרטי משתמש
                </button>
                <p class="text-sm text-gray-600 mt-2 text-center">
                    ערוך שם, גיל, גובה, משקל, יעדים, מייל וטלפון
                </p>
            </div>

            <!-- User Actions -->
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-tools ml-2"></i>
                    פעולות
                </h2>
                <div class="space-y-3">
                    <button onclick="deleteUserSoft()" class="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3 rounded-lg transition">
                        <i class="fas fa-user-times ml-2"></i>
                        מחק משתמש (ניתן לשחזר)
                    </button>
                    <button onclick="deleteUserPermanent()" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition">
                        <i class="fas fa-exclamation-triangle ml-2"></i>
                        מחק משתמש לצמיתות (לא ניתן לשחזר)
                    </button>
                </div>
            </div>
            
            <!-- Edit Profile Modal -->
            <div id="editProfileModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                    <div class="p-6">
                        <div class="flex items-center justify-between mb-6">
                            <h2 class="text-2xl font-bold text-gray-800">
                                <i class="fas fa-user-edit ml-2"></i>
                                עריכת פרטי משתמש
                            </h2>
                            <button onclick="closeEditProfile()" class="text-gray-500 hover:text-gray-700">
                                <i class="fas fa-times text-2xl"></i>
                            </button>
                        </div>
                        
                        <form id="editProfileForm" class="space-y-4">
                            <div>
                                <label class="block text-gray-700 font-bold mb-2">שם מלא</label>
                                <input type="text" name="name" id="editName" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                            </div>
                            
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">גיל</label>
                                    <input type="number" name="age" id="editAge" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">מין</label>
                                    <select name="gender" id="editGender" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                        <option value="male">זכר</option>
                                        <option value="female">נקבה</option>
                                    </select>
                                </div>
                            </div>
                            
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">גובה (ס"מ)</label>
                                    <input type="number" name="height_cm" id="editHeight" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">משקל נוכחי (ק"ג)</label>
                                    <input type="number" step="0.1" name="weight_kg" id="editWeight" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                </div>
                            </div>
                            
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">משקל יעד (ק"ג)</label>
                                    <input type="number" step="0.1" name="target_weight_kg" id="editTargetWeight" required class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                </div>
                                <div>
                                    <label class="block text-gray-700 font-bold mb-2">אימונים בשבוע</label>
                                    <select name="workouts_per_week" id="editWorkoutsPerWeek" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                        <option value="3">3</option>
                                        <option value="4">4</option>
                                        <option value="5">5</option>
                                    </select>
                                </div>
                            </div>
                            
                            <div>
                                <label class="block text-gray-700 font-bold mb-2">רמת כושר</label>
                                <select name="current_level" id="editLevel" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                    <option value="beginner">מתחילים</option>
                                    <option value="intermediate">בינוני</option>
                                    <option value="advanced">מתקדם</option>
                                </select>
                            </div>
                            
                            <div class="bg-blue-50 rounded-lg p-4 border border-blue-200">
                                <h4 class="font-bold text-gray-800 mb-3">פרטי קשר</h4>
                                <div class="space-y-3">
                                    <div>
                                        <label class="block text-gray-700 font-bold mb-2">מייל</label>
                                        <input type="email" name="email" id="editEmail" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                    </div>
                                    <div>
                                        <label class="block text-gray-700 font-bold mb-2">טלפון</label>
                                        <input type="tel" name="phone" id="editPhone" placeholder="972501234567" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                    </div>
                                </div>
                            </div>
                            
                            <div class="flex gap-4">
                                <button type="submit" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition">
                                    <i class="fas fa-save ml-2"></i>
                                    שמור שינויים
                                </button>
                                <button type="button" onclick="closeEditProfile()" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg">
                                    ביטול
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </main>

        <!-- Notification Container -->
        <div id="notificationContainer" class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4"></div>

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script>
            const userId = ${userId};
            
            // Notification System (מערכת התראות ללא חסימה)
            function showNotification(message, type = 'info') {
              const container = document.getElementById('notificationContainer')
              const notif = document.createElement('div')
              
              const colors = {
                success: 'bg-green-500',
                error: 'bg-red-500',
                warning: 'bg-yellow-500',
                info: 'bg-blue-500'
              }
              
              const icons = {
                success: '✅',
                error: '❌',
                warning: '⚠️',
                info: 'ℹ️'
              }
              
              notif.className = colors[type] + ' text-white px-6 py-4 rounded-lg shadow-2xl mb-3 transform transition-all duration-500 ease-in-out'
              notif.innerHTML = '<div class="flex items-center gap-3"><span class="text-2xl">' + icons[type] + '</span><span class="font-bold">' + message + '</span></div>'
              
              container.appendChild(notif)
              
              // Animation in
              setTimeout(() => {
                notif.style.opacity = '1'
                notif.style.transform = 'translateY(0)'
              }, 10)
              
              // Auto remove after 4 seconds
              setTimeout(() => {
                notif.style.opacity = '0'
                notif.style.transform = 'translateY(-20px)'
                setTimeout(() => notif.remove(), 500)
              }, 4000)
            }

            // Load current profile image
            async function loadProfileImage() {
                try {
                    const response = await axios.get('/api/users/' + userId)
                    const user = response.data.user
                    if (user.profile_image && user.profile_image !== 'null') {
                        document.getElementById('currentProfileImage').src = user.profile_image
                        document.getElementById('currentProfileImage').classList.remove('hidden')
                        document.getElementById('noImagePlaceholder').classList.add('hidden')
                    }
                } catch (error) {
                    console.error('Error loading profile image:', error)
                }
            }
            
            // Confirmation Dialog (דיאלוג אישור יפה)
            function showConfirmDialog(message, onConfirm, onCancel) {
              const overlay = document.createElement('div')
              overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
              
              const dialog = document.createElement('div')
              dialog.className = 'bg-white rounded-xl shadow-2xl p-8 max-w-md mx-4'
              
              dialog.innerHTML = '<div class="text-center"><div class="text-6xl mb-4">⚠️</div><p class="text-gray-800 text-xl font-bold mb-6 leading-relaxed whitespace-pre-line">' + message + '</p><div class="flex gap-4"><button id="cancelBtn" class="flex-1 bg-gray-500 hover:bg-gray-600 text-white font-bold py-4 px-6 rounded-lg transition text-lg">ביטול</button><button id="confirmBtn" class="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-4 px-6 rounded-lg transition text-lg">אישור</button></div></div>'
              
              overlay.appendChild(dialog)
              document.body.appendChild(overlay)
              
              document.getElementById('confirmBtn').onclick = function() {
                document.body.removeChild(overlay)
                if (onConfirm) onConfirm()
              }
              
              document.getElementById('cancelBtn').onclick = function() {
                document.body.removeChild(overlay)
                if (onCancel) onCancel()
              }
              
              overlay.onclick = function(e) {
                if (e.target === overlay) {
                  document.body.removeChild(overlay)
                  if (onCancel) onCancel()
                }
              }
            }

            // Handle file upload
            document.getElementById('imageInput').addEventListener('change', async (e) => {
                const file = e.target.files[0]
                if (!file) return

                const reader = new FileReader()
                reader.onload = async (event) => {
                    const base64Image = event.target.result
                    await uploadProfileImage(base64Image)
                }
                reader.readAsDataURL(file)
            })

            // Capture photo (opens camera)
            async function capturePhoto() {
                document.getElementById('imageInput').setAttribute('capture', 'camera')
                document.getElementById('imageInput').click()
            }

            // Upload profile image
            async function uploadProfileImage(base64Image) {
                try {
                    const response = await axios.patch('/api/users/' + userId + '/profile-image', {
                        profile_image: base64Image
                    })
                    showNotification('תמונת הפרופיל עודכנה בהצלחה', 'success')
                    location.reload()
                } catch (error) {
                    showNotification('שגיאה בעדכון תמונה: ' + (error.response?.data?.error || error.message), 'error')
                }
            }

            // Remove profile image
            async function removeProfileImage() {
                const userConfirmed = await new Promise(resolve => {
                    showConfirmDialog('האם אתה בטוח שברצונך למחוק את תמונת הפרופיל?', () => resolve(true), () => resolve(false));
                });
                if (!userConfirmed) return;

                try {
                    await axios.patch('/api/users/' + userId + '/profile-image', {
                        profile_image: null
                    })
                    showNotification('תמונת הפרופיל נמחקה בהצלחה', 'success')
                    location.reload()
                } catch (error) {
                    showNotification('שגיאה במחיקת תמונה: ' + (error.response?.data?.error || error.message), 'error')
                }
            }

            // Delete user (soft)
            async function deleteUserSoft() {
                const userConfirmed = await new Promise(resolve => {
                    showConfirmDialog('האם אתה בטוח שברצונך למחוק את המשתמש? (ניתן לשחזר)', () => resolve(true), () => resolve(false));
                });
                if (!userConfirmed) return;

                try {
                    await axios.delete('/api/users/' + userId)
                    showNotification('המשתמש נמחק בהצלחה', 'success')
                    window.location.href = '/'
                } catch (error) {
                    showNotification('שגיאה במחיקת משתמש: ' + (error.response?.data?.error || error.message), 'error')
                }
            }

            // Delete user (permanent)
            async function deleteUserPermanent() {
                const userConfirmed = await new Promise(resolve => {
                    showConfirmDialog('⚠️ אזהרה! מחיקה זו לא ניתנת לשחזור.\\n\\nהאם אתה בטוח לחלוטין שברצונך למחוק את המשתמש וכל הנתונים שלו לצמיתות?', () => resolve(true), () => resolve(false));
                });
                if (!userConfirmed) return;

                try {
                    await axios.delete('/api/users/' + userId + '/permanent')
                    showNotification('המשתמש נמחק לצמיתות', 'success')
                    window.location.href = '/'
                } catch (error) {
                    showNotification('שגיאה במחיקה מלאה: ' + (error.response?.data?.error || error.message), 'error')
                }
            }

            async function openEditProfile() {
                try {
                    // Load current user data
                    const response = await axios.get('/api/users/' + userId)
                    const user = response.data.user
                    
                    // Fill form with current data
                    document.getElementById('editName').value = user.name || ''
                    document.getElementById('editAge').value = user.age || ''
                    document.getElementById('editGender').value = user.gender || 'male'
                    document.getElementById('editHeight').value = user.height_cm || ''
                    document.getElementById('editWeight').value = user.weight_kg || ''
                    document.getElementById('editTargetWeight').value = user.target_weight_kg || ''
                    document.getElementById('editWorkoutsPerWeek').value = user.workouts_per_week || 3
                    document.getElementById('editLevel').value = user.current_level || 'beginner'
                    document.getElementById('editEmail').value = user.email || ''
                    document.getElementById('editPhone').value = user.phone || ''
                    
                    // Show modal
                    document.getElementById('editProfileModal').classList.remove('hidden')
                } catch (error) {
                    showNotification('שגיאה בטעינת נתונים: ' + error.message, 'error')
                }
            }
            
            function closeEditProfile() {
                document.getElementById('editProfileModal').classList.add('hidden')
            }
            
            document.getElementById('editProfileForm').addEventListener('submit', async (e) => {
                e.preventDefault()
                
                const formData = new FormData(e.target)
                const data = {
                    name: formData.get('name'),
                    age: parseInt(formData.get('age')),
                    gender: formData.get('gender'),
                    height_cm: parseFloat(formData.get('height_cm')),
                    weight_kg: parseFloat(formData.get('weight_kg')),
                    target_weight_kg: parseFloat(formData.get('target_weight_kg')),
                    workouts_per_week: parseInt(formData.get('workouts_per_week')),
                    current_level: formData.get('current_level'),
                    email: formData.get('email') || null,
                    phone: formData.get('phone') || null
                }
                
                try {
                    const response = await axios.put('/api/users/' + userId, data)
                    showNotification('✅ פרטי המשתמש עודכנו בהצלחה!', 'success')
                    closeEditProfile()
                    
                    // Refresh page after 1 second
                    setTimeout(() => {
                        window.location.reload()
                    }, 1000)
                } catch (error) {
                    showNotification('שגיאה בעדכון: ' + (error.response?.data?.error || error.message), 'error')
                }
            })

            loadProfileImage()
        </script>
    </body>
    </html>
  `)
})

/**
 * Nutrition Page - דף תזונה ומתכונים
 */
app.get('/nutrition', (c) => {
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
        <title>תזונה ומתכונים - JumpFitPro</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    </head>
    <body class="bg-gradient-to-br from-green-50 to-blue-50 min-h-screen">
        <!-- Header -->
        <header class="bg-white shadow-lg sticky top-0 z-50">
            <div class="max-w-7xl mx-auto px-4 py-4">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-4">
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                        <h1 class="text-2xl font-bold text-gray-800">
                            <i class="fas fa-utensils text-green-600 ml-2"></i>
                            תזונה ומתכונים
                        </h1>
                    </div>
                    <div class="flex gap-2">
                        <button id="returnToAdminBtn" onclick="returnToAdmin()" class="hidden bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-4 rounded-lg">
                            <i class="fas fa-arrow-right ml-2"></i>
                            חזור לאדמין
                        </button>
                        <a href="/admin" id="adminPanelBtn" class="hidden bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-lg">
                            <i class="fas fa-shield-alt ml-2"></i>
                            Admin Panel
                        </a>
                        <a href="/dashboard?user=${userId}" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded-lg">
                            <i class="fas fa-arrow-right ml-2"></i>
                            חזרה לדשבורד
                        </a>
                    </div>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <main class="max-w-7xl mx-auto px-4 py-8">
            <!-- Stats Cards -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-fire text-3xl text-orange-500"></i>
                        <span class="text-gray-500 text-sm">יעד יומי</span>
                    </div>
                    <h3 class="text-3xl font-bold text-gray-800" id="dailyCalorieGoal">0</h3>
                    <p class="text-gray-600 text-sm">קלוריות ליום</p>
                </div>
                
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-apple-alt text-3xl text-green-500"></i>
                        <span class="text-gray-500 text-sm">היום</span>
                    </div>
                    <h3 class="text-3xl font-bold text-gray-800" id="todayCalories">0</h3>
                    <p class="text-gray-600 text-sm">קלוריות נצרכו</p>
                </div>
                
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-2">
                        <i class="fas fa-balance-scale text-3xl text-blue-500"></i>
                        <span class="text-gray-500 text-sm">יתרה</span>
                    </div>
                    <h3 class="text-3xl font-bold" id="calorieBalance">0</h3>
                    <p class="text-gray-600 text-sm">קלוריות נותרו</p>
                </div>
            </div>

            <!-- Chat with Nutrition GPT -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-comments text-green-600 ml-2"></i>
                    שאל את המומחה לתזונה
                </h2>
                <p class="text-gray-600 mb-4">שאל שאלות על תזונה, קבל המלצות למתכונים, וקבל תכנית תזונה מותאמת אישית</p>
                
                <!-- Chat Messages -->
                <div id="chatMessages" class="border-2 border-gray-200 rounded-lg p-4 mb-4 h-96 overflow-y-auto bg-gray-50">
                    <div class="text-center text-gray-500 py-8">
                        <i class="fas fa-robot text-4xl mb-4"></i>
                        <p>התחל שיחה עם המומחה לתזונה שלנו</p>
                        <p class="text-sm mt-2">שאל שאלות כמו: "תן לי מתכון בריא לארוחת בוקר" או "כמה קלוריות יש בבננה?"</p>
                    </div>
                </div>
                
                <!-- Chat Input -->
                <div class="flex gap-2">
                    <input 
                        type="text" 
                        id="chatInput" 
                        placeholder="כתוב את השאלה שלך כאן..." 
                        class="flex-1 px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-green-500"
                        onkeypress="if(event.key === 'Enter') sendMessage()"
                    />
                    <button 
                        onclick="sendMessage()" 
                        class="bg-green-600 hover:bg-green-700 text-white font-bold px-6 py-3 rounded-lg transition">
                        <i class="fas fa-paper-plane ml-2"></i>
                        שלח
                    </button>
                </div>
                
                <div id="loadingIndicator" class="hidden mt-4 text-center">
                    <i class="fas fa-spinner fa-spin text-2xl text-green-600"></i>
                    <p class="text-gray-600 mt-2">המומחה חושב...</p>
                </div>
            </div>

            <!-- Quick Recipe Suggestions -->
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-lightbulb text-yellow-500 ml-2"></i>
                    הצעות מהירות
                </h2>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <button onclick="quickQuestion('תן לי מתכון בריא לארוחת בוקר')" 
                        class="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-bold py-4 px-6 rounded-lg transition">
                        <i class="fas fa-sun ml-2"></i>
                        ארוחת בוקר
                    </button>
                    <button onclick="quickQuestion('תן לי מתכון בריא לארוחת צהריים')" 
                        class="bg-gradient-to-r from-green-500 to-teal-500 hover:from-green-600 hover:to-teal-600 text-white font-bold py-4 px-6 rounded-lg transition">
                        <i class="fas fa-utensils ml-2"></i>
                        ארוחת צהריים
                    </button>
                    <button onclick="quickQuestion('תן לי מתכון בריא לארוחת ערב')" 
                        class="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-bold py-4 px-6 rounded-lg transition">
                        <i class="fas fa-moon ml-2"></i>
                        ארוחת ערב
                    </button>
                    <button onclick="quickQuestion('תן לי רעיונות לחטיפים בריאים')" 
                        class="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-bold py-4 px-6 rounded-lg transition">
                        <i class="fas fa-cookie ml-2"></i>
                        חטיפים
                    </button>
                    <button onclick="quickQuestion('כמה קלוריות צריך לאכול ביום?')" 
                        class="bg-gradient-to-r from-indigo-500 to-blue-500 hover:from-indigo-600 hover:to-blue-600 text-white font-bold py-4 px-6 rounded-lg transition">
                        <i class="fas fa-calculator ml-2"></i>
                        חישוב קלוריות
                    </button>
                    <button onclick="quickQuestion('תן לי תכנית תזונה שבועית')" 
                        class="bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600 text-white font-bold py-4 px-6 rounded-lg transition">
                        <i class="fas fa-calendar-week ml-2"></i>
                        תכנית שבועית
                    </button>
                </div>
            </div>
        </main>

        <script>
            const userId = ${userId};
            let conversationHistory = [];

            // Check if user is impersonating
            const isImpersonating = localStorage.getItem('impersonating') === 'true';
            const userRole = localStorage.getItem('user_role');

            if (isImpersonating) {
                document.getElementById('returnToAdminBtn').classList.remove('hidden');
            } else if (userRole === 'admin') {
                document.getElementById('adminPanelBtn').classList.remove('hidden');
            }

            function returnToAdmin() {
                const adminUserId = localStorage.getItem('admin_user_id');
                const adminSessionToken = localStorage.getItem('admin_session_token');
                const adminUserName = localStorage.getItem('admin_user_name');
                
                localStorage.setItem('user_id', adminUserId);
                localStorage.setItem('session_token', adminSessionToken);
                localStorage.setItem('user_name', adminUserName);
                localStorage.removeItem('impersonating');
                localStorage.removeItem('admin_user_id');
                localStorage.removeItem('admin_session_token');
                localStorage.removeItem('admin_user_name');
                
                window.location.href = '/admin';
            }

            // Load user calorie data
            async function loadUserData() {
                try {
                    const response = await axios.get(\`/api/users/\${userId}\`);
                    const user = response.data;
                    
                    // Calculate daily calorie goal (example: BMR * activity factor)
                    const bmr = user.gender === 'male' 
                        ? 10 * user.weight_kg + 6.25 * user.height_cm - 5 * user.age + 5
                        : 10 * user.weight_kg + 6.25 * user.height_cm - 5 * user.age - 161;
                    
                    const activityFactor = 1.5; // Moderate activity
                    const dailyGoal = Math.round(bmr * activityFactor);
                    
                    document.getElementById('dailyCalorieGoal').textContent = dailyGoal;
                    
                    // TODO: Load today's consumed calories from database
                    // For now, placeholder
                    const consumed = 0;
                    document.getElementById('todayCalories').textContent = consumed;
                    
                    const balance = dailyGoal - consumed;
                    const balanceEl = document.getElementById('calorieBalance');
                    balanceEl.textContent = balance;
                    balanceEl.classList.add(balance >= 0 ? 'text-green-600' : 'text-red-600');
                } catch (error) {
                    console.error('Error loading user data:', error);
                }
            }

            function addMessage(content, isUser = false) {
                const messagesDiv = document.getElementById('chatMessages');
                
                // Clear welcome message if exists
                if (messagesDiv.querySelector('.text-center')) {
                    messagesDiv.innerHTML = '';
                }
                
                const messageDiv = document.createElement('div');
                messageDiv.className = \`mb-4 flex \${isUser ? 'justify-end' : 'justify-start'}\`;
                
                messageDiv.innerHTML = \`
                    <div class="\${isUser ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'} rounded-lg p-4 max-w-xl">
                        <div class="flex items-start gap-2">
                            <i class="fas \${isUser ? 'fa-user' : 'fa-robot'} mt-1"></i>
                            <div class="whitespace-pre-wrap">\${content}</div>
                        </div>
                    </div>
                \`;
                
                messagesDiv.appendChild(messageDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            async function sendMessage() {
                const input = document.getElementById('chatInput');
                const message = input.value.trim();
                
                if (!message) return;
                
                // Add user message
                addMessage(message, true);
                input.value = '';
                
                // Show loading
                document.getElementById('loadingIndicator').classList.remove('hidden');
                
                try {
                    // Call your GPT API here
                    const response = await axios.post('/api/nutrition/chat', {
                        message: message,
                        userId: userId,
                        history: conversationHistory
                    });
                    
                    conversationHistory.push({ role: 'user', content: message });
                    conversationHistory.push({ role: 'assistant', content: response.data.response });
                    
                    // Add GPT response
                    addMessage(response.data.response, false);
                } catch (error) {
                    console.error('Error:', error);
                    addMessage('מצטער, אירעה שגיאה. אנא נסה שוב.', false);
                }
                
                // Hide loading
                document.getElementById('loadingIndicator').classList.add('hidden');
            }

            function quickQuestion(question) {
                document.getElementById('chatInput').value = question;
                sendMessage();
            }

            // Load data on page load
            loadUserData();
        </script>
    </body>
    </html>
  `)
})

export default app
