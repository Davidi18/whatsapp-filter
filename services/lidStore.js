/**
 * LID Store Service
 * Persistent LID↔Phone mapping table for WhatsApp's LID→JID migration.
 * In-memory Map backed by a JSON file for persistence across restarts.
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const LID_MAP_PATH = path.join(__dirname, '..', 'config', 'lid-map.json');

// In-memory mapping: lidNumber → { phone, name, updatedAt }
const lidMap = new Map();

/**
 * Load mappings from disk on startup
 */
async function load() {
  try {
    const data = await fs.readFile(LID_MAP_PATH, 'utf8');
    const entries = JSON.parse(data);
    let count = 0;
    for (const [lid, value] of Object.entries(entries)) {
      lidMap.set(lid, value);
      count++;
    }
    logger.info('LID map loaded', { count });
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.info('No existing LID map file, starting fresh');
    } else {
      logger.warn('Failed to load LID map', { error: err.message });
    }
  }
}

/**
 * Persist current map to disk
 */
async function persist() {
  try {
    const dir = path.dirname(LID_MAP_PATH);
    await fs.mkdir(dir, { recursive: true });
    const obj = Object.fromEntries(lidMap);
    await fs.writeFile(LID_MAP_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    logger.warn('Failed to persist LID map', { error: err.message });
  }
}

/**
 * Save a LID→Phone mapping
 * @param {string} lid - LID number (without @lid suffix)
 * @param {string} phone - Phone number (without @s.whatsapp.net suffix)
 * @param {string} [name] - Contact display name
 */
function save(lid, phone, name) {
  const cleanLid = lid.replace('@lid', '');
  const cleanPhone = phone.replace('@s.whatsapp.net', '').replace('@lid', '');

  // Skip if phone doesn't look like a real phone number
  if (!/^\d{7,15}$/.test(cleanPhone)) return;

  const existing = lidMap.get(cleanLid);
  // Only update if new or phone/name changed
  if (!existing || existing.phone !== cleanPhone || (name && existing.name !== name)) {
    lidMap.set(cleanLid, {
      phone: cleanPhone,
      name: name || existing?.name || null,
      updatedAt: Date.now()
    });
    logger.info('LID mapping saved', { lid: cleanLid, phone: cleanPhone, name: name || null });
    // Persist async — don't block
    persist();
  }
}

/**
 * Resolve a LID to a phone number
 * @param {string} lid - LID number (without @lid suffix)
 * @returns {{ phone: string, name: string|null } | null}
 */
function resolve(lid) {
  const cleanLid = lid.replace('@lid', '');
  return lidMap.get(cleanLid) || null;
}

/**
 * Get total number of mappings
 */
function size() {
  return lidMap.size;
}

module.exports = {
  load,
  save,
  resolve,
  size
};
