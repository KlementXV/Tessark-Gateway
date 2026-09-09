// Local heuristic only: absence of a warning is not proof of password strength.
export function isWeakRegistryPassword(password: string, username: string | null = null): boolean {
  const normalized = password.toLowerCase()
  return password.length < 15 ||
    /^(.)\1+$/.test(password) ||
    /^(harbor|password|admin|changeme|welcome|qwerty|123456)[\d!@#$%^&*._-]*$/i.test(password) ||
    Boolean(username && normalized === username.toLowerCase())
}
