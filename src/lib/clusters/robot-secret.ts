// Harbor's robot secret policy, in a leaf module with no server-only imports so the create
// form can validate against the very same rule the API enforces. Keeping it out of
// clusters/robots.ts matters: that module reaches for node:crypto and Prisma, which have no
// business being pulled into a client bundle.

export const ROBOT_SECRET_MIN_LENGTH = 8
export const ROBOT_SECRET_MAX_LENGTH = 128

export type RobotSecretViolation = "length" | "lowercase" | "uppercase" | "digit"

/**
 * Null when the secret satisfies Harbor's policy, otherwise which rule it breaks. The UI
 * turns the code into a sentence in the visitor's language (projects.robots.policy*); the API
 * uses robotSecretPolicyError below for its English error body.
 */
export function robotSecretPolicyViolation(secret: string): RobotSecretViolation | null {
  if (secret.length < ROBOT_SECRET_MIN_LENGTH || secret.length > ROBOT_SECRET_MAX_LENGTH) return "length"
  if (!/[a-z]/.test(secret)) return "lowercase"
  if (!/[A-Z]/.test(secret)) return "uppercase"
  if (!/[0-9]/.test(secret)) return "digit"
  return null
}

const VIOLATION_MESSAGES: Record<RobotSecretViolation, string> = {
  length: `Use between ${ROBOT_SECRET_MIN_LENGTH} and ${ROBOT_SECRET_MAX_LENGTH} characters`,
  lowercase: "Include a lowercase letter",
  uppercase: "Include an uppercase letter",
  digit: "Include a digit",
}

/** Null when the secret satisfies Harbor's policy, otherwise the reason it does not (English, for the API). */
export function robotSecretPolicyError(secret: string): string | null {
  const violation = robotSecretPolicyViolation(secret)
  return violation ? VIOLATION_MESSAGES[violation] : null
}
