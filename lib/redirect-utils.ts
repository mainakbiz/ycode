import type { Redirect } from '@/types';

/**
 * Convert legacy PCRE-style substitution tokens to JS `String.replace` tokens.
 * The UI documents `$0` as the full matched path (PHP `preg_replace` behavior),
 * but JS uses `$&` for the full match. `$1`+ capture groups are left untouched.
 */
function normalizeReplacementTokens(replacement: string): string {
  return replacement.replace(/\$0/g, '$$&');
}

/**
 * Match a request path against configured redirects.
 * Exact string matches take priority, then regex patterns (`.+`, `.*`).
 * Ported from legacy CustomDomain::getRedirectedUrl behavior.
 */
export function matchRedirect(
  currentPath: string,
  redirects: Redirect[],
): Redirect | null {
  const exactMatches: Redirect[] = [];
  const regexMatches: Redirect[] = [];

  for (const r of redirects) {
    let oldUrl = r.oldUrl;

    if (!oldUrl.startsWith('/')) {
      oldUrl = '/' + oldUrl;
    }

    const isRegex = oldUrl.includes('.+') || oldUrl.includes('.*');

    if (isRegex) {
      regexMatches.push({ ...r, oldUrl });
    } else {
      exactMatches.push({ ...r, oldUrl });
    }
  }

  for (const r of exactMatches) {
    if (r.oldUrl === currentPath) {
      return r;
    }
  }

  for (const r of regexMatches) {
    try {
      const escapedPattern = r.oldUrl.replace(/\?/g, '\\?');
      const regex = new RegExp(`^${escapedPattern}$`);

      if (regex.test(currentPath)) {
        const newUrl = currentPath.replace(regex, normalizeReplacementTokens(r.newUrl));
        return { ...r, newUrl };
      }
    } catch {
      // Invalid regex pattern — skip
    }
  }

  return null;
}
