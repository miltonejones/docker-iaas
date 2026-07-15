// Subtle pointer-tracking spotlight for elements with the `glow` class.
// A single delegated pointermove listener updates CSS custom properties
// (--mx / --my) on whichever `.glow` element the cursor is over, so newly
// rendered cards are covered automatically without per-element wiring.
export function initSpotlight() {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  window.addEventListener(
    'pointermove',
    (e) => {
      const target = (e.target as Element | null)?.closest<HTMLElement>('.glow');
      if (!target) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      target.style.setProperty('--my', `${e.clientY - rect.top}px`);
    },
    { passive: true },
  );
}
