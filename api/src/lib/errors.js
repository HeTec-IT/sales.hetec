'use strict';
// Fehlercodes entsprechen bewusst den Firestore-Codes, damit die App
// ('permission-denied' usw.) unveraendert darauf reagieren kann.
class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const E = {
  unauth: m => new ApiError(401, 'unauthenticated', m || 'Nicht angemeldet.'),
  denied: m => new ApiError(403, 'permission-denied', m || 'Keine Berechtigung.'),
  notFound: m => new ApiError(404, 'not-found', m || 'Nicht gefunden.'),
  bad: m => new ApiError(400, 'invalid-argument', m || 'Ungueltige Anfrage.'),
  conflict: m => new ApiError(409, 'aborted', m || 'Konflikt, bitte erneut versuchen.')
};
module.exports = { ApiError, E };
