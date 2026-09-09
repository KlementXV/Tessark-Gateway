import type { Registry } from "@/generated/prisma/client"
import { decryptSecret } from "@/lib/crypto"
import { isWeakRegistryPassword } from "./password-security"

// Never send a stored secret to the client — neither the Harbor admin credential nor the
// Gateway system robot's. Both are replaced by a boolean: the UI only ever needs to know
// whether one is set.
export function toPublicRegistry(registry: Registry) {
  const {
    encryptedSecret: _encryptedSecret,
    systemRobotSecret: _systemRobotSecret,
    ...rest
  } = registry
  return {
    ...rest,
    hasSecret: Boolean(_encryptedSecret),
    weakPassword: registry.authType === "basic" && Boolean(_encryptedSecret) &&
      isWeakRegistryPassword(decryptSecret(_encryptedSecret!), registry.username),
    hasSystemRobot: Boolean(_systemRobotSecret && registry.systemRobotName),
  }
}
