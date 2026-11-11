import type { ReactNode } from 'react';

/**
 * Round buttons for the business's contact links. Simple generic glyphs in each network's color
 * (not the networks' own logos); the name is in the tooltip and for screen readers.
 */
type Net = 'whatsapp' | 'instagram' | 'facebook' | 'tiktok';
const STYLE: Record<Net, { bg: string; label: string; icon: ReactNode }> = {
  whatsapp: {
    bg: 'bg-[#25D366] hover:bg-[#1ebe5b]',
    label: 'WhatsApp',
    // Chat bubble with a handset
    icon: (
      <>
        <path d="M4 20l1.3-3.9A8 8 0 1 1 8 18.7L4 20z" />
        <path d="M9.5 9.2c.3 1.6 1.7 3.2 3.4 3.9l1-1 1.6.7-.4 1.4c-2.9 0-5.7-2.7-5.9-5.6l1.4-.4.7 1.6-.8.4z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  instagram: {
    bg: 'bg-gradient-to-tr from-[#f58529] via-[#dd2a7b] to-[#8134af] hover:opacity-90',
    label: 'Instagram',
    // Camera
    icon: (
      <>
        <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.2-2h5l1.2 2h1.8A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
        <circle cx="12" cy="12.5" r="3.4" />
      </>
    ),
  },
  facebook: {
    bg: 'bg-[#1877F2] hover:bg-[#0f63d4]',
    label: 'Facebook',
    // People
    icon: (
      <>
        <circle cx="9" cy="8.5" r="3" />
        <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
        <circle cx="16.5" cy="9.5" r="2.4" />
        <path d="M15.5 14.4c2.4-.3 4.4 1.2 5 3.9" />
      </>
    ),
  },
  tiktok: {
    bg: 'bg-slate-900 hover:bg-black',
    label: 'TikTok',
    // Music note
    icon: (
      <>
        <path d="M14 4v10.5" />
        <circle cx="10.5" cy="15.5" r="3" />
        <path d="M14 4c.6 2.4 2.3 3.8 5 4" />
      </>
    ),
  },
};

export function SocialButton({ net, href }: { net: Net; href: string }) {
  const s = STYLE[net];
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={s.label}
      aria-label={s.label}
      data-testid={`social-${net}`}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-white shadow-sm transition ${s.bg}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {s.icon}
      </svg>
    </a>
  );
}
