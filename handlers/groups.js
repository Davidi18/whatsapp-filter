/**
 * Group event handlers
 * Handles: GROUPS_UPSERT, GROUP_UPDATE, GROUP_PARTICIPANTS_UPDATE
 */

const statsService = require('../services/stats');
const logger = require('../utils/logger');

/**
 * Handle GROUPS_UPSERT - Group created/updated
 */
async function handleUpsert(payload, context) {
  statsService.increment('GROUPS_UPSERT', 'total');

  // Evolution API wraps data in 'data' field
  const data = payload.data || payload;

  const groupId = data.id || data.jid;
  const groupName = data.subject || data.name;

  logger.debug('Group upsert', { groupId, groupName });

  statsService.logEvent({
    event: 'GROUPS_UPSERT',
    action: 'logged',
    details: {
      groupId,
      groupName
    }
  });

  return { action: 'logged', groupId, groupName };
}

/**
 * Handle GROUP_UPDATE - Group info updated
 */
async function handleUpdate(payload, context) {
  statsService.increment('GROUP_UPDATE', 'total');

  // Evolution API wraps data in 'data' field
  const data = payload.data || payload;

  const groupId = data.id || data.jid;

  logger.debug('Group update', { groupId });

  statsService.logEvent({
    event: 'GROUP_UPDATE',
    action: 'logged',
    details: {
      groupId
    }
  });

  return { action: 'logged', groupId };
}

/**
 * Handle GROUP_PARTICIPANTS_UPDATE - Group members changed
 */
async function handleParticipants(payload, context) {
  statsService.increment('GROUP_PARTICIPANTS_UPDATE', 'total');

  // Evolution API wraps data in 'data' field
  const data = payload.data || payload;

  const groupId = data.id || data.jid;
  const action = data.action; // add, remove, promote, demote
  const participants = data.participants || [];

  logger.debug('Group participants update', { groupId, action, count: participants.length });

  statsService.logEvent({
    event: 'GROUP_PARTICIPANTS_UPDATE',
    action: 'logged',
    details: {
      groupId,
      participantAction: action,
      participantCount: participants.length
    }
  });

  return { action: 'logged', groupId, participantAction: action };
}

module.exports = {
  handleUpsert,
  handleUpdate,
  handleParticipants
};
