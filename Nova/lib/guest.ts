export const GUEST_COOKIE = "nova_guest";

export function isGuestClient(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split("; ").some((c) => c === `${GUEST_COOKIE}=1`);
}

export function setGuestCookie() {
  // Session cookie — cleared when the browser closes.
  document.cookie = `${GUEST_COOKIE}=1; path=/; samesite=lax`;
}

export function clearGuestCookie() {
  document.cookie = `${GUEST_COOKIE}=; path=/; max-age=0`;
}
