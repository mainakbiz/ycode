/**
 * Supabase Constants
 *
 * Centralized constants for Supabase operations to avoid
 * hitting query limits and URL length restrictions.
 */

/**
 * Default row limit for Supabase queries.
 * Supabase returns max 1000 rows by default.
 * Use pagination with this batch size to fetch all records.
 */
export const SUPABASE_QUERY_LIMIT = 1000;

/**
 * Batch size for insert/update/upsert operations.
 * Smaller to avoid Supabase URL length limits on write operations.
 */
export const SUPABASE_WRITE_BATCH_SIZE = 100;

/**
 * Page through a Supabase SELECT past the 1000-row default cap.
 * `buildPage(from, to)` must return a fresh query each call (Supabase
 * builders aren't reusable). Stops on error or short page.
 */
export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize: number = SUPABASE_QUERY_LIMIT,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}
