import { cookies } from "next/headers";
import { GUEST_COOKIE } from "./guest";

export async function isGuestServer(): Promise<boolean> {
  const store = await cookies();
  return store.get(GUEST_COOKIE)?.value === "1";
}
