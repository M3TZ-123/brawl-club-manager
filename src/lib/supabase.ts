import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-key";

// Using 'any' type to avoid strict type checking with Supabase
// In production, you should generate types from your Supabase schema
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);
