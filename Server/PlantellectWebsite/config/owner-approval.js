// Contributor approval on a change request (pure, no database).
//
// A 'description' change request that targets ANOTHER contributor's description needs two
// approvals: the contributor who wrote that description, and an admin. The contributor's
// answer lives inside the request's own payload, so no schema change is needed:
//
//   payload.ownerApproval = {
//       required: true,
//       ownerId,            // accountId of the description's author
//       ownerName,          // for display
//       status,             // 'pending' | 'approved' | 'denied'
//       requestedAt, decidedAt, note
//   }
//   payload.descriptionOwnerId   the author of the description at filing time
//   payload.requesterSeenState   "<requestStatus>|<ownerStatus or none>" the requester last looked at
//
// A request that changes your OWN description has no ownerApproval: only the admin decides it.
// A request whose description belongs to an inactive account (for example the system actor)
// also has none, because nobody could ever answer it.

const OWNER_PENDING = 'pending';
const OWNER_APPROVED = 'approved';
const OWNER_DENIED = 'denied';

function ownerApprovalOf(payload) {
    const oa = payload && typeof payload === 'object' ? payload.ownerApproval : null;
    return oa && typeof oa === 'object' && oa.ownerId ? oa : null;
}

/**
 * Why an admin may not approve this request yet, or null when nothing is in the way.
 * Takes an already parsed payload.
 */
function ownerGateMessage(payload) {
    const oa = ownerApprovalOf(payload);
    if (!oa) return null;
    if (oa.status === OWNER_PENDING) {
        return `This change is to ${oa.ownerName || 'another contributor'}'s description, so it also needs their approval first. They have not answered yet.`;
    }
    if (oa.status === OWNER_DENIED) {
        return 'The contributor who wrote this description declined the change, so it cannot be approved.';
    }
    return null;
}

/** The state string the requester has (or has not) acknowledged. */
function stateOf(status, payload) {
    const oa = ownerApprovalOf(payload);
    return `${status}|${oa ? oa.status : 'none'}`;
}

module.exports = {
    OWNER_PENDING,
    OWNER_APPROVED,
    OWNER_DENIED,
    ownerApprovalOf,
    ownerGateMessage,
    stateOf
};
