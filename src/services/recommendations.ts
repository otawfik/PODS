import { supabase } from './supabase';

export interface PodRecommendation {
  podId: string;
  /** One short sentence explaining the pick. */
  reason: string;
  source: 'claude' | 'heuristic';
}

/**
 * Ranked pods for the signed-in student, from the `recommend-pods` Edge
 * Function (supabase/functions/recommend-pods). Claude does the ranking on
 * the server; if it is unavailable the function falls back to a keyword
 * heuristic, so this only throws on network/auth errors.
 */
export async function getPodRecommendations(): Promise<PodRecommendation[]> {
  const { data, error } = await supabase.functions.invoke<{
    recommendations: PodRecommendation[];
  }>('recommend-pods', { method: 'POST', body: {} });
  if (error) throw new Error(error.message);
  return data?.recommendations ?? [];
}
