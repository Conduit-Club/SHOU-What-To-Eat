export function floatingSubmitVisible(path: string): boolean {
  return path === '/' || /^\/(foods|restaurants)(\/|$)/.test(path) || /^\/(search|live-detail)\/?$/.test(path);
}

export function clampPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, bottomInset = 0) {
  const min = 12;
  return {
    x: Math.max(min, Math.min(x, Math.max(min, viewportWidth - width - min))),
    y: Math.max(min, Math.min(y, Math.max(min, viewportHeight - height - bottomInset - min))),
  };
}

export function initTheme() {
  const button = document.querySelector<HTMLButtonElement>('.theme-toggle');
  const media = matchMedia('(prefers-color-scheme: dark)');
  let explicit = false;
  try { explicit = ['light', 'dark'].includes(localStorage.getItem('shou-theme') || ''); } catch { /* storage may be disabled */ }
  const apply = (dark: boolean) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#191817' : '#fbf9f6');
    const label = dark ? '切换到白天模式' : '切换到黑夜模式';
    button?.setAttribute('aria-label', label);
    button?.setAttribute('title', label);
    const text = button?.querySelector('.theme-label');
    if (text) text.textContent = dark ? '白天模式' : '黑夜模式';
  };
  apply(document.documentElement.dataset.theme === 'dark');
  button?.addEventListener('click', () => {
    explicit = true;
    const dark = document.documentElement.dataset.theme !== 'dark';
    apply(dark);
    try { localStorage.setItem('shou-theme', dark ? 'dark' : 'light'); } catch { /* keep this page usable */ }
  });
  media.addEventListener('change', () => { if (!explicit) apply(media.matches); });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'shou-theme' && event.key !== null) return;
    explicit = event.newValue === 'dark' || event.newValue === 'light';
    apply(explicit ? event.newValue === 'dark' : media.matches);
  });
}

export function initFloatingSubmit() {
  const link = document.querySelector<HTMLAnchorElement>('.floating-submit');
  if (!link || !floatingSubmitVisible(location.pathname)) return;
  link.hidden = false;
  let position: {x: number; y: number} | undefined;
  let drag: {id: number; startX: number; startY: number; x: number; y: number; moved: boolean} | undefined;
  let suppressClick = false;
  const bounds = () => {
    const rect = link.getBoundingClientRect();
    const nav = document.querySelector<HTMLElement>('.bottom-nav');
    const navRect = nav?.getBoundingClientRect();
    const inset = navRect && navRect.height ? innerHeight - navRect.top : 0;
    return {rect, inset};
  };
  const place = (x: number, y: number) => {
    const {rect, inset} = bounds();
    position = clampPosition(x, y, rect.width, rect.height, document.documentElement.clientWidth || innerWidth, innerHeight, inset);
    link.style.left = `${position.x}px`;
    link.style.top = `${position.y}px`;
    link.style.right = 'auto';
    link.style.bottom = 'auto';
  };
  const save = () => {
    try { localStorage.setItem('shou-submit-position', JSON.stringify(position)); } catch { /* optional preference */ }
  };
  try {
    const saved = JSON.parse(localStorage.getItem('shou-submit-position') || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y);
  } catch { /* ignore corrupt or unavailable storage */ }
  link.addEventListener('dragstart', (event) => event.preventDefault());
  link.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick = false;
    const rect = link.getBoundingClientRect();
    drag = {id: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.x, y: rect.y, moved: false};
    link.setPointerCapture(event.pointerId);
  });
  link.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 7) return;
    drag.moved = true;
    link.dataset.dragging = '';
    place(drag.x + dx, drag.y + dy);
  });
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = drag.moved;
    if (drag.moved) save();
    drag = undefined;
    delete link.dataset.dragging;
  };
  link.addEventListener('pointerup', finish);
  link.addEventListener('pointercancel', finish);
  link.addEventListener('lostpointercapture', finish);
  link.addEventListener('click', (event) => {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); suppressClick = false; }
  });
  link.addEventListener('keydown', (event) => {
    const offsets: Record<string, [number, number]> = {ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20]};
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const rect = link.getBoundingClientRect();
    place(rect.x + offset[0], rect.y + offset[1]);
    save();
  });
  window.addEventListener('resize', () => {
    if (position) place(position.x, position.y);
  });
}
