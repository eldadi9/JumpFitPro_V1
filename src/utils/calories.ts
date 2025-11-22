/**
 * מודול חישוב קלוריות לקפיצה בחבל
 * מבוסס על נוסחת MET (Metabolic Equivalent of Task)
 * 
 * מקורות מדעיים:
 * - HealthMatch.io: MET values for jump rope
 * - Captain Calculator: Calories burned jumping rope
 * - Jump Rope Dudes: Scientific MET calculations
 * 
 * נוסחה: calories_per_minute = 0.0175 * MET * weight_kg
 */

export interface IntensityLevel {
  name: string;
  met: number;
  description: string;
  skips_per_minute: string;
}

export interface CalorieCalculationInput {
  weight_kg: number;
  work_minutes: number;
  intensity: 'easy' | 'medium' | 'hard';
}

export interface CalorieCalculationResult {
  calories_per_minute: number;
  total_calories: number;
  intensity_level: IntensityLevel;
  work_minutes: number;
  weight_kg: number;
}

/**
 * רמות עצימות לפי מחקר מדעי
 * MET values מבוססים על מחקרים של:
 * - Slow pace (< 100 skips/min): MET = 8.8
 * - Moderate pace (100-120 skips/min): MET = 11.8
 * - Fast pace (120-160 skips/min): MET = 12.3
 */
export const INTENSITY_LEVELS: Record<string, IntensityLevel> = {
  easy: {
    name: 'קל',
    met: 8.8,
    description: 'קצב איטי, פחות מ-100 קפיצות לדקה',
    skips_per_minute: '< 100'
  },
  medium: {
    name: 'בינוני',
    met: 11.8,
    description: 'קצב בינוני, 100-120 קפיצות לדקה',
    skips_per_minute: '100-120'
  },
  hard: {
    name: 'גבוה',
    met: 12.3,
    description: 'קצב מהיר, 120-160 קפיצות לדקה',
    skips_per_minute: '120-160'
  }
};

/**
 * חישוב קלוריות שנשרפו בקפיצה בחבל
 * 
 * @param input - פרמטרי חישוב (משקל, זמן, עצימות)
 * @returns תוצאות חישוב מפורטות
 */
export function calculateCalories(input: CalorieCalculationInput): CalorieCalculationResult {
  const { weight_kg, work_minutes, intensity } = input;
  
  // קבלת ערך MET לפי עצימות
  const intensityLevel = INTENSITY_LEVELS[intensity];
  
  if (!intensityLevel) {
    throw new Error(`Invalid intensity level: ${intensity}`);
  }
  
  // חישוב לפי נוסחת MET
  // calories_per_minute = 0.0175 * MET * weight_kg
  const calories_per_minute = 0.0175 * intensityLevel.met * weight_kg;
  
  // חישוב סך הכל קלוריות
  const total_calories = calories_per_minute * work_minutes;
  
  return {
    calories_per_minute: Math.round(calories_per_minute * 100) / 100,
    total_calories: Math.round(total_calories * 100) / 100,
    intensity_level: intensityLevel,
    work_minutes,
    weight_kg
  };
}

/**
 * חישוב קלוריות יומיות/שבועיות/חודשיות
 * 
 * @param daily_calories - קלוריות ליום
 * @param workouts_per_week - כמות אימונים בשבוע
 * @returns סיכום קלוריות לתקופות שונות
 */
export function calculateCalorieSummary(
  daily_calories: number,
  workouts_per_week: number
) {
  const weekly_calories = daily_calories * workouts_per_week;
  const monthly_calories = weekly_calories * 4; // 4 שבועות
  
  return {
    daily: Math.round(daily_calories),
    weekly: Math.round(weekly_calories),
    monthly: Math.round(monthly_calories)
  };
}

/**
 * הערכת זמן אימון נדרש להשגת יעד קלוריות
 * 
 * @param target_calories - יעד קלוריות
 * @param weight_kg - משקל בק"ג
 * @param intensity - רמת עצימות
 * @returns זמן אימון נדרש בדקות
 */
export function estimateWorkoutTime(
  target_calories: number,
  weight_kg: number,
  intensity: 'easy' | 'medium' | 'hard'
): number {
  const intensityLevel = INTENSITY_LEVELS[intensity];
  const calories_per_minute = 0.0175 * intensityLevel.met * weight_kg;
  
  return Math.ceil(target_calories / calories_per_minute);
}

/**
 * חישוב BMI (Body Mass Index)
 * 
 * @param weight_kg - משקל בק"ג
 * @param height_cm - גובה בס"מ
 * @returns BMI ומצב בריאותי
 */
export function calculateBMI(weight_kg: number, height_cm: number) {
  const height_m = height_cm / 100;
  const bmi = weight_kg / (height_m * height_m);
  
  let status = '';
  if (bmi < 18.5) status = 'תת משקל';
  else if (bmi < 25) status = 'משקל תקין';
  else if (bmi < 30) status = 'עודף משקל';
  else status = 'השמנה';
  
  return {
    bmi: Math.round(bmi * 10) / 10,
    status
  };
}

/**
 * חישוב התקדמות ליעד משקל
 * 
 * @param current_weight - משקל נוכחי
 * @param target_weight - משקל יעד
 * @returns אחוזי התקדמות וק"ג שנותרו
 */
export function calculateWeightProgress(
  current_weight: number,
  target_weight: number
) {
  const total_to_lose = current_weight - target_weight;
  const remaining = current_weight - target_weight;
  const progress_percentage = ((total_to_lose - remaining) / total_to_lose) * 100;
  
  return {
    remaining_kg: Math.round(remaining * 10) / 10,
    progress_percentage: Math.max(0, Math.round(progress_percentage)),
    total_to_lose: Math.round(total_to_lose * 10) / 10
  };
}
