/**
 * מסך תכניות אימון - לא נדרש בנפרד כי ה-HTML נמצא ב-index.tsx
 * הקובץ הזה ישמש כתבנית עתידית אם נרצה להפריד את ה-UI
 */

export const plansPageHTML = (userId: string) => `
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>תכניות אימון - אפליקציית קפיצה בחבל</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
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
                            <button onclick="selectPlan(\${plan.id})" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg transition duration-300">
                                <i class="fas fa-check ml-2"></i>
                                בחר תכנית
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

        async function selectPlan(planId) {
            if (confirm('האם אתה בטוח שברצונך לבחור תכנית זו?')) {
                try {
                    await axios.put(\`/api/users/\${userId}\`, { current_plan_id: planId })
                    alert('התכנית נבחרה בהצלחה!')
                    window.location.href = '/dashboard?user=' + userId
                } catch (error) {
                    alert('שגיאה בבחירת תכנית: ' + error.message)
                }
            }
        }

        loadPlans()
    </script>
</body>
</html>
`
