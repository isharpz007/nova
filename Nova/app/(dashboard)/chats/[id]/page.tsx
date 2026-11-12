"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ChatThread } from "@/components/ChatThread";

function Thread() {
  const { id } = useParams<{ id: string }>();
  return <ChatThread conversationId={id} />;
}

export default function ChatDetailPage() {
  return (
    <Suspense>
      <Thread />
    </Suspense>
  );
}
