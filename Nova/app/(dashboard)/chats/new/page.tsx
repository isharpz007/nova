"use client";

import { Suspense } from "react";
import { ChatThread } from "@/components/ChatThread";

export default function NewChatPage() {
  return (
    <Suspense>
      <ChatThread />
    </Suspense>
  );
}
