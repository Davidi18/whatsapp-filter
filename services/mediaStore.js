/**
 * Media storage service
 * Downloads and stores media files from Baileys messages
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const MEDIA_DIR = path.join(__dirname, '..', 'config', 'media');
const MAX_MEDIA_FILES = parseInt(process.env.MAX_MEDIA_FILES) || 500;
const MAX_MEDIA_SIZE = parseInt(process.env.MAX_MEDIA_SIZE) || 10 * 1024 * 1024; // 10MB default

// Track stored media: { id: { path, mimeType, size, timestamp } }
let mediaIndex = {};
const INDEX_FILE = path.join(__dirname, '..', 'config', 'media_index.json');

/**
 * Initialize media storage
 */
async function init() {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    // Load index
    try {
      const data = await fs.readFile(INDEX_FILE, 'utf8');
      mediaIndex = JSON.parse(data);
      logger.info('Media index loaded', { count: Object.keys(mediaIndex).length });
    } catch (e) {
      if (e.code !== 'ENOENT') logger.error('Failed to load media index', { error: e.message });
      mediaIndex = {};
    }
  } catch (error) {
    logger.error('Failed to init media store', { error: error.message });
  }
}

/**
 * Save media buffer to disk
 * @param {string} messageId - Message ID
 * @param {Buffer} buffer - Media data
 * @param {string} mimeType - MIME type
 * @returns {string|null} Media ID
 */
async function saveMedia(messageId, buffer, mimeType) {
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length > MAX_MEDIA_SIZE) {
    logger.warn('Media too large, skipping', { messageId, size: buffer.length });
    return null;
  }

  try {
    const ext = getExtFromMime(mimeType);
    const mediaId = `${messageId}_${Date.now()}`;
    const fileName = `${mediaId}${ext}`;
    const filePath = path.join(MEDIA_DIR, fileName);

    await fs.writeFile(filePath, buffer);

    mediaIndex[mediaId] = {
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      size: buffer.length,
      timestamp: new Date().toISOString()
    };

    await saveIndex();
    await cleanupIfNeeded();

    logger.debug('Media saved', { mediaId, size: buffer.length, mimeType });
    return mediaId;
  } catch (error) {
    logger.error('Failed to save media', { messageId, error: error.message });
    return null;
  }
}

/**
 * Get media file info and path
 */
function getMedia(mediaId) {
  const entry = mediaIndex[mediaId];
  if (!entry) return null;

  return {
    filePath: path.join(MEDIA_DIR, entry.fileName),
    mimeType: entry.mimeType,
    size: entry.size
  };
}

/**
 * Save index to disk
 */
async function saveIndex() {
  try {
    await fs.writeFile(INDEX_FILE, JSON.stringify(mediaIndex, null, 2));
  } catch (error) {
    logger.error('Failed to save media index', { error: error.message });
  }
}

/**
 * Cleanup old media if over limit
 */
async function cleanupIfNeeded() {
  const ids = Object.keys(mediaIndex);
  if (ids.length <= MAX_MEDIA_FILES) return;

  // Sort by timestamp, oldest first
  ids.sort((a, b) => new Date(mediaIndex[a].timestamp) - new Date(mediaIndex[b].timestamp));

  const toRemove = ids.slice(0, ids.length - MAX_MEDIA_FILES);
  for (const id of toRemove) {
    try {
      await fs.unlink(path.join(MEDIA_DIR, mediaIndex[id].fileName)).catch(() => {});
      delete mediaIndex[id];
    } catch (e) { /* ignore */ }
  }

  await saveIndex();
  logger.info('Media cleanup', { removed: toRemove.length });
}

/**
 * Get file extension from MIME type
 */
function getExtFromMime(mimeType) {
  if (!mimeType) return '.bin';
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
  };
  return map[mimeType] || '.bin';
}

/**
 * Get stats
 */
function getStats() {
  const ids = Object.keys(mediaIndex);
  const totalSize = ids.reduce((sum, id) => sum + (mediaIndex[id].size || 0), 0);
  return {
    count: ids.length,
    maxFiles: MAX_MEDIA_FILES,
    totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
  };
}

module.exports = {
  init,
  saveMedia,
  getMedia,
  getStats
};
