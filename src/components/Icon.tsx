// Small hand-drawn icon set (24×24, stroke based) so the app ships no icon font.
const P: Record<string, string> = {
  dashboard: 'M3 12a9 9 0 1 1 18 0M12 12l4-4M5 16h14',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  gamepad: 'M6 9h4M8 7v4M15 10h.01M18 8h.01M7 5h10a5 5 0 0 1 4.9 6l-.9 5a3 3 0 0 1-5.3 1.3L14 15h-4l-1.7 2.3A3 3 0 0 1 3 16l-.9-5A5 5 0 0 1 7 5Z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM19 11a7 7 0 0 1-14 0M12 18v3',
  speaker: 'M6 3h12v18H6zM12 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 7h.01',
  voice: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z',
  orbit: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M3 12a9 4 0 1 0 18 0 9 4 0 1 0-18 0M7.5 4.2a9 4 60 1 0 9 15.6',
  wand: 'M15 4V2M15 10V8M11 6h2M17 6h2M3 21l12-12M18 13l1.5 1.5M13 3l-1.5-1.5',
  equalizer: 'M4 20v-6M8 20V8M12 20v-9M16 20V4M20 20v-12',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z',
  devices: 'M3 6h12v10H3zM7 20h4M9 16v4M17 9h4v11h-4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
  headphones: 'M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z',
  earbuds: 'M7 4a4 4 0 0 1 4 4v1a3 3 0 0 1-3 3H7v8M17 4a4 4 0 0 0-4 4v1a3 3 0 0 0 3 3h1v8',
  laptop: 'M4 5h16v10H4zM2 19h20',
  soundbar: 'M2 9h20v6H2zM6 12h.01M10 12h.01M14 12h.01M18 12h.01',
  tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
  bluetooth: 'M7 7l10 10-5 5V2l5 5L7 17',
  display: 'M3 4h18v12H3zM9 20h6M12 16v4',
  home: 'M3 11l9-8 9 8M5 9v12h14V9',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  save: 'M5 3h11l3 3v15H5zM8 3v5h8M8 21v-7h8v7',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9 12l2 2 4-4',
  compare: 'M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4M8 12h-6M22 12h-6',
  waveform: 'M2 12h2l2-6 3 12 3-15 3 18 3-12 2 3h2',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  warning: 'M12 3l10 18H2zM12 10v4M12 18h.01',
  logs: 'M5 3h10l4 4v14H5zM9 9h6M9 13h6M9 17h4',
  expand: 'M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7',
  chevron: 'M9 6l6 6-6 6',
  stereo: 'M7 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0M17 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
};

export function Icon({ name, size = 18, className, strokeWidth = 1.8 }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={P[name] ?? P.info} />
    </svg>
  );
}

export function categoryIcon(category: string) {
  switch (category) {
    case 'headphones': return 'headphones';
    case 'earbuds': return 'earbuds';
    case 'laptop': return 'laptop';
    case 'soundbar': return 'soundbar';
    case 'tv': return 'tv';
    case 'bluetooth-speaker': return 'speaker';
    case 'display': return 'display';
    case 'home-theater': return 'home';
    case 'speakers': return 'speaker';
    default: return 'speaker';
  }
}
