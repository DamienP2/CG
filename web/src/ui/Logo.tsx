/** The Pulse CG logo (same drawing as the app icon). */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#12141f" />
      <rect x="6" y="9" width="14" height="7" rx="1.5" fill="#7c5cff" />
      <rect x="6" y="18" width="20" height="6" rx="1.5" fill="#ff3b5c" />
    </svg>
  );
}
