export function normalizeCareerLink(input: string): string | null {
  const value = input.trim();
  if (!value) return '';
  if (
    value.length > 2048 ||
    !/^https:\/\/[^/]/i.test(value) ||
    /[\\\s]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return null;
  }

  try {
    // URL parsing removes dot segments automatically. Check the original and decoded path first.
    let path = value.split(/[?#]/, 1)[0];
    for (let round = 0; round < 3; round++) {
      if (path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return null;
      if (!/%[0-9a-f]{2}/i.test(path)) break;
      path = decodeURIComponent(path);
      if (round === 2) return null;
    }
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
