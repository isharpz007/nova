interface ActivityItem {
  id: string;
  title: string;
  subtitle?: string;
  timestamp: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ActivityList({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">
        No recent activity yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {items.map((item) => (
        <li key={item.id} className="py-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{item.title}</p>
            {item.subtitle && (
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {item.subtitle}
              </p>
            )}
          </div>
          <span className="text-xs text-slate-400 whitespace-nowrap">
            {timeAgo(item.timestamp)}
          </span>
        </li>
      ))}
    </ul>
  );
}
