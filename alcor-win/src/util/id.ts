export function newId(): string {
  return crypto.randomUUID().toUpperCase();
}
