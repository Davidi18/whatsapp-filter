/**
 * Input validation helpers
 */

// Phone number validation
// Accepts: international format with optional +, digits with optional formatting
// Examples: +972547554964, 972-54-755-4964, +972-54-755-4964, 0547554964
const PHONE_REGEX = /^\+?[\d\s\-()]{10,20}$/;

// Group ID validation (numeric string, typically 18 digits, with optional @g.us suffix)
const GROUP_ID_REGEX = /^\d{10,25}(@g\.us)?$/;

// Default contact/group types
const DEFAULT_CONTACT_TYPES = ['PERSONAL', 'BUSINESS', 'VIP', 'TEMP'];
const DEFAULT_GROUP_TYPES = ['GENERAL', 'BUSINESS', 'VIP', 'TEMP'];

// Will be populated from config for custom types
let customContactTypes = [];
let customGroupTypes = [];

/**
 * Set custom types from config
 */
function setCustomTypes(contactTypes = [], groupTypes = []) {
  customContactTypes = contactTypes;
  customGroupTypes = groupTypes;
}

/**
 * Get all valid contact types (default + custom)
 */
function getValidContactTypes() {
  return [...DEFAULT_CONTACT_TYPES, ...customContactTypes];
}

/**
 * Get all valid group types (default + custom)
 */
function getValidGroupTypes() {
  return [...DEFAULT_GROUP_TYPES, ...customGroupTypes];
}

/**
 * Validate phone number format
 * Accepts various formats: +972547554964, 972-54-755-4964, (054) 755-4964
 */
function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  // Check basic format first
  if (!PHONE_REGEX.test(phone)) return false;
  // Check normalized length is 10-15 digits
  const normalized = normalizePhone(phone);
  return normalized.length >= 10 && normalized.length <= 15;
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
  return getValidContactTypes().includes(type);
}

/**
 * Validate group type
 */
function isValidGroupType(type) {
  return getValidGroupTypes().includes(type);
}

/**
 * Validate name (2-50 characters)
 */
function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  return name.length >= 2 && name.length <= 50;
}

/**
 * Normalize phone number (remove all formatting)
 * Removes: +, -, spaces, parentheses, dots
 * Example: "+972-54-755-4964" -> "972547554964"
 */
function normalizePhone(phone) {
  if (!phone) return '';
  // Remove all non-digit characters to ensure consistent comparison
  return phone.replace(/\D/g, '');
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
    return { sourceId: '', sourceType: 'unknown', isStatusBroadcast: false, isLid: false };
  }

  if (remoteJid.includes('status@broadcast')) {
    return { sourceId: '', sourceType: 'status', isStatusBroadcast: true, isLid: false };
  }

  if (remoteJid.includes('@g.us')) {
    return {
      sourceId: remoteJid.replace('@g.us', ''),
      sourceType: 'group',
      isStatusBroadcast: false,
      isLid: false
    };
  }

  // Handle LID (Linked ID) format - WhatsApp internal user identifier
  if (remoteJid.includes('@lid')) {
    return {
      sourceId: remoteJid.replace('@lid', ''),
      sourceType: 'contact',
      isStatusBroadcast: false,
      isLid: true
    };
  }

  return {
    sourceId: remoteJid.replace('@s.whatsapp.net', ''),
    sourceType: 'contact',
    isStatusBroadcast: false,
    isLid: false
  };
}

module.exports = {
  isValidPhone,
  isValidGroupId,
  isValidContactType,
  isValidGroupType,
  isValidName,
  normalizePhone,
  normalizeGroupId,
  parseRemoteJid,
  setCustomTypes,
  getValidContactTypes,
  getValidGroupTypes,
  DEFAULT_CONTACT_TYPES,
  DEFAULT_GROUP_TYPES
};
