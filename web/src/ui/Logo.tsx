/** The Strata logo: three layers, the top one carrying a lower third. `mono`: all white. */
export function Logo({ size = 20, mono = false }: { size?: number; mono?: boolean }) {
  const [a, b, c] = mono ? ['#fff', '#fff', '#fff'] : ['#7c5cff', '#ff3b5c', '#9d85ff'];
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="m3.5 20.6 12.5 6.4 12.5-6.4" fill="none" stroke={c} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" opacity={mono ? 0.6 : 1} />
      <path d="M16 4.6 28.5 11 16 17.4 3.5 11z" fill={a} />
      <path d="m10.2 11.9 6.2-3.2 3.4 1.7-6.2 3.2z" fill={mono ? '#000' : '#fff'} opacity={mono ? 0.35 : 0.9} />
      <path d="m14.2 13.9 6.2-3.2 2 1-6.2 3.2z" fill={b} />
    </svg>
  );
}
