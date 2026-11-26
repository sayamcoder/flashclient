/* Bundled news shown when no content server is set in Settings. Edit this file
   to change the offline copy — the live list comes from the cloud dashboard.
   tone: 'green' | 'amber' | 'red' | 'blue' */
const BUNDLED_NEWS = [
  {
    tag: 'Store',
    tone: 'amber',
    title: 'Daily rewards are live in the launcher',
    body: 'Open the gift button in the top bar, claim your coins and keep the streak alive. Day seven pays the most.',
    date: '24 Nov'
  },
  {
    tag: 'Release',
    tone: 'green',
    title: 'Flash 1.0.2 — input latency and memory patch',
    body: 'Raw mouse input is hooked before the event queue, and Sodium chunk caching now stays resident between dimensions.',
    date: '3 Nov'
  },
  {
    tag: 'Pipeline',
    tone: 'blue',
    title: 'Sodium 0.5.11 shipped as the default renderer',
    body: 'Applies to every 1.20+ environment. 1.8.9 keeps OptiFine so legacy PvP packs still load.',
    date: '1 Nov'
  },
  {
    tag: 'Skins',
    tone: 'amber',
    title: 'Skin fetching now goes through the launcher',
    body: 'Avatars and full-body previews are pulled by the main process, so rate limits and blocked TLS no longer fail the UI.',
    date: '29 Oct'
  },
  {
    tag: 'Servers',
    tone: 'green',
    title: 'Quick play remembers your last network',
    body: 'Pick any server from the Servers tab and the launcher joins it from the Play screen with one click.',
    date: '24 Oct'
  }
];

let NEWS_ITEMS = BUNDLED_NEWS;

function newsDotClass(tone) {
  if (tone === 'green') return 'bg-[#5ec36a]';
  if (tone === 'amber') return 'bg-amber-400';
  if (tone === 'red') return 'bg-rose-400';
  return 'bg-sky-400';
}

function renderNewsFeed() {
  const feed = document.getElementById('news-feed');
  if (!feed) return;

  if (!NEWS_ITEMS.length) {
    feed.innerHTML = '<p class="col-span-2 px-1.5 py-4 text-[12px] text-white/35">Nothing has been published yet. Check back after the next update.</p>';
  } else {
    feed.innerHTML = NEWS_ITEMS.map(item => `
      <article class="rounded-lg border border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.05] p-3.5 transition-colors">
        <div class="flex items-center gap-2 mb-2">
          <span class="w-1.5 h-1.5 rounded-full ${newsDotClass(item.tone)}"></span>
          <span class="text-[11px] text-white/45">${escapeHtml(item.tag)}</span>
          <span class="text-[11px] font-mono text-white/25 ml-auto">${formatNewsDate(item.date)}</span>
        </div>
        <h4 class="text-[12px] font-semibold text-white leading-snug mb-1.5">${escapeHtml(item.title)}</h4>
        ${item.body ? `<p class="text-[11px] leading-relaxed text-white/45 whitespace-pre-line">${escapeHtml(item.body)}</p>` : ''}
        ${item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy" class="mt-2.5 w-full h-24 object-cover rounded-md border border-white/[0.07]" onerror="this.remove()">` : ''}
      </article>`).join('');
  }

  const count = document.getElementById('news-count-label');
  if (count) count.textContent = `${NEWS_ITEMS.length} update${NEWS_ITEMS.length === 1 ? '' : 's'}`;
}
