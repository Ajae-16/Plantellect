// Contributor approval on a change request (pure, no database).
//
// A change request that needs a contributor needs two approvals: that contributor first, then an admin.
//   - a 'description' request that targets ANOTHER contributor's description asks that description's author;
//   - a 'base' (plant info) request asks the plant's PRIMARY contributor, the author of the description the
//     plant page shows first (role 'primary'), unless that is the person asking.
// If the contributor approves, the request goes on to the admin. If the contributor declines, it ends
// there and the admin never sees it. The contributor's answer lives inside the request's own payload, so
// no schema change is needed:
//
//   payload.ownerApproval = {
//       required: true,
//       role,               // 'primary' for a plant-info request; absent for a description request
//       ownerId,            // accountId of the description's author / the primary contributor
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
const OWNER_ROLE_PRIMARY = 'primary';

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
    const primary = oa.role === OWNER_ROLE_PRIMARY;
    if (oa.status === OWNER_PENDING) {
        return primary
            ? `This change is to the plant info, so it also needs the primary contributor${oa.ownerName ? ` (${oa.ownerName})` : ''} to approve first. They have not answered yet.`
            : `This change is to ${oa.ownerName || 'another contributor'}'s description, so it also needs their approval first. They have not answered yet.`;
    }
    if (oa.status === OWNER_DENIED) {
        return primary
            ? 'The primary contributor declined the change, so it cannot be approved.'
            : 'The contributor who wrote this description declined the change, so it cannot be approved.';
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
    OWNER_ROLE_PRIMARY,
    ownerApprovalOf,
    ownerGateMessage,
    stateOf
};
