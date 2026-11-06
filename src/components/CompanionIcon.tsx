/** Shared, decorative line icons for the companion controls. */
export default function CompanionIcon({ name }: { name: 'chat' | 'style' | 'link' | 'play' | 'stop' | 'refresh' | 'wave' | 'smile' | 'tilt' | 'moon' | 'arrow' | 'close' }) {
  const paths = {
    chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6',
    style: 'm12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z',
    link: 'm10 14 4-4M9 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1',
    play: 'm9 5 10 7-10 7V5Z',
    stop: 'M7 7h10v10H7V7Z',
    refresh: 'M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 11.6-2L20 8M4 16l2.9 3A7 7 0 0 0 18.5 17',
    wave: 'M5 13V9a1.5 1.5 0 0 1 3 0v3-6a1.5 1.5 0 0 1 3 0v6-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6l1-1a1.5 1.5 0 0 1 2 2l-3 5a6 6 0 0 1-10 0l-3-4a1.5 1.5 0 0 1 1-2Z',
    smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 9h.01M16 9h.01M8 14s1 3 4 3 4-3 4-3',
    tilt: 'M20 10a8 8 0 1 1-8-8M14 3h7v7M21 3l-8 8',
    moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    close: 'm6 6 12 12M6 18 18 6',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="companion-icon"><path d={paths[name]} /></svg>;
}
