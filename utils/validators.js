/**
 * Input validation helpers
 */

// Phone number validation
// Accepts: pure digits (10-15 chars) OR Israeli formatted (972-XX-XXX-XXXX)
const PHONE_REGEX = /^(\d{10,15}|972[-\s]?[1-9]\d{1}[-\s]?\d{3}[-\s]?\d{4})$/;

// Group ID validation (numeric string, typically 18 digits)
const GROUP_ID_REGEX = /^\d{10,25}$/;

// Valid contact types
const VALID_CONTACT_TYPES = ['PERSONAL', 'BUSINESS', 'VIP', 'TEMP'];

/**
 * Validate phone number format
 */
function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  return PHONE_REGEX.test(phone);
}

/**
 * Validate group ID format
 */
function isValidGroupId(groupId) {
  if (!groupId || typeof groupId !== 'string') return false;
  // Remove @g.us suffix if present
  const cleanId = groupId.replace('@g.us', '');
  return GROUP_ID_REGEX.test(cleanId);
}

/**
 * Validate contact type
 */
function isValidContactType(type) {
  return VALID_CONTACT_TYPES.includes(type);
}

/**
 * Validate name (2-50 characters)
 */
function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  return name.length >= 2 && name.length <= 50;
}

/**
 * Normalize phone number (remove formatting)
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/[-\s]/g, '');
}

/**
 * Normalize group ID (remove @g.us suffix)
 */
function normalizeGroupId(groupId) {
  if (!groupId) return '';
  return groupId.replace('@g.us', '');
}

/**
 * Extract source info from remoteJid
 */
function parseRemoteJid(remoteJid) {
  if (!remoteJid) {
    return { sourceId: '', sourceType: 'unknown', isStatusBroadcast: false };
  }

  if (remoteJid.includes('status@broadcast')) {
    return { sourceId: '', sourceType: 'status', isStatusBroadcast: true };
  }

  if (remoteJid.includes('@g.us')) {
    return {
      sourceId: remoteJid.replace('@g.us', ''),
      sourceType: 'group',
      isStatusBroadcast: false
    };
  }

  return {
    sourceId: remoteJid.replace('@s.whatsapp.net', ''),
    sourceType: 'contact',
    isStatusBroadcast: false
  };
}

module.exports = {
  isValidPhone,
  isValidGroupId,
  isValidContactType,
  isValidName,
  normalizePhone,
  normalizeGroupId,
  parseRemoteJid,
  VALID_CONTACT_TYPES
};
