/* Toasts: one quiet card, a coloured dot, plain sentence-case copy.
   The palette stays on the card surface — no glowing borders or icons. */

const TOAST_TONE = {
  success: { dot: 'bg-[#4cbb5e]', bar: 'bg-[#4cbb5e]/60', ms: 4000 },
  error:   { dot: 'bg-[#e0685d]', bar: 'bg-[#e0685d]/60', ms: 6000 },
  info:    { dot: 'bg-white/45',  bar: 'bg-white/35',     ms: 4000 }
};

function showToast(message, type = 'info', title = '') {
  const container = document.getElementById('flash-toast-container');
  if (!container) return;

  const tone = TOAST_TONE[type] || TOAST_TONE.info;

  const toast = document.createElement('div');
  toast.className = 'toast-item pointer-events-auto w-full bg-[#16171c] border border-white/10 rounded-lg shadow-[0_10px_28px_rgba(0,0,0,0.5)] overflow-hidden relative';
  toast.innerHTML = `
    <div class="flex items-start gap-2.5 pl-3.5 pr-2.5 py-3">
      <span class="mt-[6px] w-1.5 h-1.5 rounded-full ${tone.dot} shrink-0"></span>
      <div class="min-w-0 flex-1">
        ${title ? `<p class="text-[11px] font-medium text-white/40 mb-0.5">${title}</p>` : ''}
        <p class="text-[13px] leading-snug text-white/85">${message}</p>
      </div>
      <button type="button" aria-label="Dismiss"
              class="close-btn shrink-0 -my-1 p-1.5 rounded text-white/35 hover:text-white/80 transition-colors cursor-pointer">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div class="h-[2px] bg-white/[0.04]">
      <div class="progress-bar h-full ${tone.bar}" style="width: 100%;"></div>
    </div>`;

  container.appendChild(toast);

  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-visible')));

  let closing = false;
  const dismiss = () => {
    if (closing) return;
    closing = true;
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 240);
  };

  toast.querySelector('.close-btn').addEventListener('click', dismiss);

  const progress = toast.querySelector('.progress-bar');
  let remaining = tone.ms;
  let startedAt = Date.now();
  let timer;

  const run = () => {
    startedAt = Date.now();
    progress.style.transition = `width ${remaining}ms linear`;
    progress.style.width = '0%';
    timer = setTimeout(dismiss, remaining);
  };

  toast.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    remaining -= Date.now() - startedAt;
    const width = getComputedStyle(progress).width;
    progress.style.transition = 'none';
    progress.style.width = width;
  });

  toast.addEventListener('mouseleave', () => {
    if (!closing && remaining > 0) run();
  });

  run();
}
