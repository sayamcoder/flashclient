const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const mods = require('./mods');

/* Modrinth slugs, newest first is not needed — the newest build that supports
   the profile's game version and loader is picked for each. Slugs that have
   nothing for that version are skipped, so one list works across versions.
   The file is copied to the data folder on first run and can be edited. */
const DEFAULTS = {
  fabric: ['sodium', 'lithium', 'ferrite-core', 'krypton', 'fabric-api'],
  forge: ['embeddium', 'ferrite-core', 'modernfix', 'foamfix', 'betterfps'],
  neoforge: ['sodium', 'lithium', 'ferrite-core', 'modernfix']
};

function file() {
  return path.join(app.getPath('userData'), 'performance-mods.json');
}

function lists() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (err) {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(DEFAULTS, null, 2));
    } catch (writeErr) {
      // read-only data folder: fall back to the built-in list
    }
    return DEFAULTS;
  }
}

async function installFor(profile, onProgress) {
  const slugs = Array.isArray(lists()[profile.loader]) ? lists()[profile.loader] : [];
  const installed = [];

  for (let index = 0; index < slugs.length; index += 1) {
    const slug = slugs[index];
    onProgress?.({
      phase: 'perf',
      message: `Checking ${slug}`,
      done: index,
      total: slugs.length,
      ratio: slugs.length ? index / slugs.length : 1
    });

    try {
      const meta = await mods.projectMeta(slug);
      const entry = await mods.install(profile.id, {
        projectId: meta.id,
        slug,
        gameVersion: profile.gameVersion,
        loader: profile.loader,
        title: meta.title,
        icon: meta.icon
      });
      installed.push(entry.title);
    } catch (err) {
      // that mod has no build for this version — the next one may
    }
  }

  onProgress?.({ phase: 'perf', message: 'Performance mods ready', done: slugs.length, total: slugs.length, ratio: 1 });
  return installed;
}

module.exports = { installFor, lists, file, DEFAULTS };
