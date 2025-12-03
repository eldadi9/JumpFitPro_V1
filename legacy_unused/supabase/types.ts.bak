export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      achievements: {
        Row: {
          achievement_name: string
          achievement_type: string
          achievement_value: number | null
          created_at: string | null
          earned_date: string | null
          id: string
          user_id: string
        }
        Insert: {
          achievement_name: string
          achievement_type: string
          achievement_value?: number | null
          created_at?: string | null
          earned_date?: string | null
          id?: string
          user_id: string
        }
        Update: {
          achievement_name?: string
          achievement_type?: string
          achievement_value?: number | null
          created_at?: string | null
          earned_date?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "achievements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_sessions: {
        Row: {
          day_of_week: string | null
          id: number
          intensity: string | null
          notes: string | null
          plan_id: number | null
          rest_seconds: number | null
          session_number: number
          sets_count: number | null
          week_number: number
          work_seconds: number | null
        }
        Insert: {
          day_of_week?: string | null
          id?: number
          intensity?: string | null
          notes?: string | null
          plan_id?: number | null
          rest_seconds?: number | null
          session_number: number
          sets_count?: number | null
          week_number: number
          work_seconds?: number | null
        }
        Update: {
          day_of_week?: string | null
          id?: number
          intensity?: string | null
          notes?: string | null
          plan_id?: number | null
          rest_seconds?: number | null
          session_number?: number
          sets_count?: number | null
          week_number?: number
          work_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_sessions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "workout_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          age: number | null
          created_at: string | null
          current_level: string | null
          email: string | null
          gender: string | null
          height_cm: number | null
          id: string
          is_favorite: boolean | null
          name: string
          phone: string | null
          preferred_intensity: string | null
          profile_image: string | null
          target_weight_kg: number | null
          updated_at: string | null
          weight_kg: number | null
          workouts_per_week: number | null
        }
        Insert: {
          age?: number | null
          created_at?: string | null
          current_level?: string | null
          email?: string | null
          gender?: string | null
          height_cm?: number | null
          id: string
          is_favorite?: boolean | null
          name?: string
          phone?: string | null
          preferred_intensity?: string | null
          profile_image?: string | null
          target_weight_kg?: number | null
          updated_at?: string | null
          weight_kg?: number | null
          workouts_per_week?: number | null
        }
        Update: {
          age?: number | null
          created_at?: string | null
          current_level?: string | null
          email?: string | null
          gender?: string | null
          height_cm?: number | null
          id?: string
          is_favorite?: boolean | null
          name?: string
          phone?: string | null
          preferred_intensity?: string | null
          profile_image?: string | null
          target_weight_kg?: number | null
          updated_at?: string | null
          weight_kg?: number | null
          workouts_per_week?: number | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      weight_tracking: {
        Row: {
          created_at: string | null
          id: string
          measurement_date: string
          notes: string | null
          user_id: string
          weight_kg: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          measurement_date?: string
          notes?: string | null
          user_id: string
          weight_kg: number
        }
        Update: {
          created_at?: string | null
          id?: string
          measurement_date?: string
          notes?: string | null
          user_id?: string
          weight_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "weight_tracking_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      workout_logs: {
        Row: {
          calories_burned: number | null
          completed: boolean | null
          created_at: string | null
          id: string
          intensity: string | null
          notes: string | null
          plan_id: number | null
          session_id: number | null
          sets_completed: number | null
          user_id: string
          work_minutes: number
          workout_date: string
        }
        Insert: {
          calories_burned?: number | null
          completed?: boolean | null
          created_at?: string | null
          id?: string
          intensity?: string | null
          notes?: string | null
          plan_id?: number | null
          session_id?: number | null
          sets_completed?: number | null
          user_id: string
          work_minutes: number
          workout_date?: string
        }
        Update: {
          calories_burned?: number | null
          completed?: boolean | null
          created_at?: string | null
          id?: string
          intensity?: string | null
          notes?: string | null
          plan_id?: number | null
          session_id?: number | null
          sets_completed?: number | null
          user_id?: string
          work_minutes?: number
          workout_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "workout_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      workout_plans: {
        Row: {
          created_at: string | null
          description: string | null
          duration_weeks: number | null
          id: number
          level: string | null
          plan_name: string
          sessions_per_week: number | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          duration_weeks?: number | null
          id?: number
          level?: string | null
          plan_name: string
          sessions_per_week?: number | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          duration_weeks?: number | null
          id?: number
          level?: string | null
          plan_name?: string
          sessions_per_week?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
