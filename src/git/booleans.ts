// git-config boolean semantics (git-config(1)): bare key = true;
// true/false/yes/no/on/off/1/0 case-insensitive; anything else is invalid
// (git itself rejects the command) → null.

export function gitBool(v: string | true | null | undefined): boolean | null {
  if (v === true) return true
  if (v == null) return null
  const s = v.trim().toLowerCase()
  if (s === "" || s === "true" || s === "yes" || s === "on" || s === "1") return true
  if (s === "false" || s === "no" || s === "off" || s === "0") return false
  return null
}
