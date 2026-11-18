/**
 * A path on this site that is safe to send a browser to after sign-in: it starts with one slash, and has no second
 * slash or backslash after it, so it can never become another site (“//evil.com”, “/\\evil.com”).
 */
export const isLocalPath = (path: string): boolean => /^\/(?![\/\\])/.test(path) && !path.includes('\\') && !/[\u0000-\u001f]/.test(path);
