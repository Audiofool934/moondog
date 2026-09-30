# Spotify refresh transactions

Spotify refresh holds the credential store's process-shared filesystem lock through the OAuth exchange and the atomic credential commit. Each transaction re-reads the current credential under that lock. Reactive callers may reuse a different usable access token; changed metadata alone cannot satisfy a rejected-token refresh. Spotify API writes still dispatch once and are never replayed automatically.

Before token dispatch, a durable `refreshAttempt` marker records an unresolved exchange. Successful persistence clears it. Process death, exchange timeout, or an uncertain persistence failure leaves the marker in place; subsequent processes wait for the lock, then refuse another exchange or use of the old access token. `/spotify login` explicitly replaces the uncertain credential. No provider rollback is assumed.

The refresh deadline is 15 seconds, including lock wait. A cancelled caller stops waiting immediately. If dispatch has begun, the bounded transaction continues to persist a rotated token; cancellation before dispatch starts no exchange. A late response after the deadline cannot write credentials. Disk operations finish before releasing the lock; a stalled filesystem can delay internal cleanup beyond the caller deadline.

Lock owners have unique filenames. Only the successful remover of a confirmed dead owner's exact file may remove the lock directory. Empty, malformed, or legacy fixed-filename locks are treated as busy, never stolen; the wait is bounded. An orphaned such lock requires manual local recovery after confirming no process owns it. Credential directories remain 0700 and files 0600. Custom credential stores without a durable transaction/checkpoint API cannot refresh.

Tests use fictional credentials, injected token responses, independent Node processes, process termination, and persistence failures. No live OAuth exchange or grants are part of verification.
