"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconBell,
  IconChat,
  IconHome,
  IconPlus,
  IconUser,
} from "@/components/Icons";

const NAV = [
  { href: "/", label: "Home", Icon: IconHome },
  { href: "/chats/new", label: "New", Icon: IconPlus },
  { href: "/chats", label: "Chats", Icon: IconChat },
  { href: "/notifications", label: "Alerts", Icon: IconBell },
  { href: "/profile", label: "Profile", Icon: IconUser },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#171717]">
      <div className="flex justify-around py-2">
        {NAV.map(({ href, label, Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href.replace("/new", ""));
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-0.5 px-2 py-1 text-[10px] font-medium ${
                active ? "text-teal-600 dark:text-teal-400" : "text-slate-500 dark:text-neutral-400"
              }`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
