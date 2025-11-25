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
                        <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
                        <div class="flex items-center gap-3">
                            <img id="userProfileImage" src="" alt="Profile" class="h-10 w-10 rounded-full object-cover border-2 border-indigo-500 hidden" />
                            <div>
                                <p id="userName" class="text-lg font-bold text-gray-700"></p>
                                <p id="userGender" class="text-sm text-gray-500"></p>
                            </div>
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
                    <img src="/static/logo.svg" alt="JumpFitPro" class="h-12" />
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

export default app
