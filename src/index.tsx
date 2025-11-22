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
    const { name, age, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity } = body

    // Validation
    if (!name || !age || !height_cm || !weight_kg || !target_weight_kg) {
      return c.json({ error: 'חסרים שדות חובה' }, 400)
    }

    const result = await c.env.DB.prepare(`
      INSERT INTO users (name, age, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      name,
      age,
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
 * קבלת כל המשתמשים
 */
app.get('/api/users', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM users ORDER BY created_at DESC
    `).all()
    
    return c.json({ users: results })
  } catch (error) {
    return c.json({ error: 'שגיאה בקבלת משתמשים', details: String(error) }, 500)
  }
})

/**
 * קבלת משתמש לפי ID
 */
app.get('/api/users/:id', async (c) => {
  try {
    const userId = c.req.param('id')
    const user = await c.env.DB.prepare(`
      SELECT * FROM users WHERE id = ?
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
    const { name, age, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity } = body

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
          height_cm = COALESCE(?, height_cm),
          weight_kg = COALESCE(?, weight_kg),
          target_weight_kg = COALESCE(?, target_weight_kg),
          workouts_per_week = COALESCE(?, workouts_per_week),
          current_level = COALESCE(?, current_level),
          preferred_intensity = COALESCE(?, preferred_intensity),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(name, age, height_cm, weight_kg, target_weight_kg, workouts_per_week, current_level, preferred_intensity, userId).run()

    return c.json({ success: true, message: 'משתמש עודכן בהצלחה' })
  } catch (error) {
    return c.json({ error: 'שגיאה בעדכון משתמש', details: String(error) }, 500)
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
        <title>אפליקציית קפיצה בחבל - ירידה במשקל</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <!-- Header -->
        <header class="bg-white shadow-md">
            <div class="max-w-7xl mx-auto px-4 py-6">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <i class="fas fa-dumbbell text-4xl text-indigo-600"></i>
                        <div>
                            <h1 class="text-3xl font-bold text-gray-800">אפליקציית קפיצה בחבל</h1>
                            <p class="text-gray-600">תכנית מלאה לירידה במשקל</p>
                        </div>
                    </div>
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
              const response = await axios.get('/api/users')
              const users = response.data.users
              
              const userListHtml = users.map(user => \`
                <div class="border border-gray-300 rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition" onclick="selectUser(\${user.id})">
                  <div class="flex items-center justify-between">
                    <div>
                      <h4 class="font-bold text-lg text-gray-800">\${user.name}</h4>
                      <p class="text-gray-600">גיל: \${user.age} | משקל נוכחי: \${user.weight_kg} ק"ג | יעד: \${user.target_weight_kg} ק"ג</p>
                    </div>
                    <i class="fas fa-arrow-left text-indigo-600 text-2xl"></i>
                  </div>
                </div>
              \`).join('')
              
              document.getElementById('userList').innerHTML = userListHtml
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
        <title>דשבורד - אפליקציית קפיצה בחבל</title>
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
                        <i class="fas fa-dumbbell text-3xl text-indigo-600"></i>
                        <div>
                            <h1 class="text-2xl font-bold text-gray-800">הדשבורד שלי</h1>
                            <p id="userName" class="text-gray-600"></p>
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

            <!-- Quick Actions -->
            <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
                <h3 class="text-xl font-bold text-gray-800 mb-4">פעולות מהירות</h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <button onclick="showWorkoutForm()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-lg transition duration-300">
                        <i class="fas fa-plus ml-2"></i>
                        הוסף אימון חדש
                    </button>
                    <button onclick="window.location.href='/plans?user=${userId}'" class="bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-lg transition duration-300">
                        <i class="fas fa-list ml-2"></i>
                        תכניות אימון
                    </button>
                    <button onclick="window.location.href='/settings?user=${userId}'" class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-4 rounded-lg transition duration-300">
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
              
              document.getElementById('todayCalories').textContent = stats.today_calories
              document.getElementById('weeklyCalories').textContent = stats.weekly_calories
              document.getElementById('monthlyCalories').textContent = stats.monthly_calories
              document.getElementById('totalWorkouts').textContent = stats.total_workouts

              // Load recent workouts
              const workoutsResponse = await axios.get(\`/api/workouts/user/\${userId}\`)
              const workouts = workoutsResponse.data.workouts.slice(0, 5)
              
              const workoutsHtml = workouts.map(workout => \`
                <div class="border border-gray-200 rounded-lg p-4">
                  <div class="flex items-center justify-between">
                    <div>
                      <span class="font-bold text-gray-800">\${workout.workout_date}</span>
                      <span class="text-gray-600 mr-4">\${workout.work_minutes} דקות</span>
                      <span class="text-gray-600">| עצימות: \${workout.intensity === 'easy' ? 'קל' : workout.intensity === 'medium' ? 'בינוני' : 'קשה'}</span>
                    </div>
                    <div class="text-orange-500 font-bold">\${workout.calories_burned} קלוריות</div>
                  </div>
                </div>
              \`).join('')
              
              document.getElementById('recentWorkouts').innerHTML = workoutsHtml || '<p class="text-gray-500 text-center">אין אימונים עדיין</p>'
            } catch (error) {
              console.error('Error loading dashboard:', error)
              alert('שגיאה בטעינת נתונים')
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
        <title>תכניות אימון - אפליקציית קפיצה בחבל</title>
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
                    <div class="flex items-center gap-3">
                        <i class="fas fa-list text-3xl text-indigo-600"></i>
                        <h1 class="text-2xl font-bold text-gray-800">תכניות אימון</h1>
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
                                    <div class="text-sm text-gray-600">
                                        <p>\${session.sets_count} סטים × \${session.work_seconds} שניות עבודה / \${session.rest_seconds} שניות מנוחה</p>
                                        <p class="mt-1">עצימות: \${session.intensity === 'easy' ? 'קל 💚' : session.intensity === 'medium' ? 'בינוני 💛' : 'קשה 🔥'}</p>
                                        \${session.notes ? \`<p class="mt-1 text-indigo-600">\${session.notes}</p>\` : ''}
                                    </div>
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
        <title>הגדרות - אפליקציית קפיצה בחבל</title>
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
                    <div class="flex items-center gap-3">
                        <i class="fas fa-cog text-3xl text-indigo-600"></i>
                        <h1 class="text-2xl font-bold text-gray-800">הגדרות</h1>
                    </div>
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

export default app
