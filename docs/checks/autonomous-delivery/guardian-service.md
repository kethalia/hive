# Signed guardian service checkpoint

Status: local authenticated-service, transaction and handler proof. Installed outer/client/owner-app/FD3 composition is the next gate. The new route defaults off; no middleware or preview bypass, public activation, remote migration, cloud resources or account inference is included.

Owner provisioning independently resolves the current owner-only Coder app and challenges its public outer identity with a fresh nonce. The service checks exact deployment-approved package/ELF/Node/protection pins, server-derived dynamic config digest and software-reported startup identity chain. The signed identity is possession evidence for the trusted installed host boundary, not hardware remote attestation. A one-use 60-second issuer grant binds the exact outer key, lifetime, workspace/build/app and startup digest. Grant values remain on server-to-owner-app/private host channels and are never returned to the browser.

The fixed POST `/api/codex-host/guardians` accepts only strict signed actions: enrollment, preparation, checkout binding, first-native reservation, native finalization, execution fence, current metadata authorization and closed barrier. Proofs bind the domain, method, exact path and complete body. Every call verifies the persisted outer key and freshly resolves owner/Coder scope and expected config before storage. Host/body package hashes are compared to deployment policy; they cannot approve themselves. Different actions share no generic URL/file/command transport.

The route rejects browser Origin, query strings (including empty query markers), encoded/trailing path variants and other methods. Cookies and forwarded owner headers establish no authority. Bodies use the bounded session reader; responses and errors are no-store and contain no input echo. The actual Next route wraps the helper, so Next's route-context argument cannot be confused with the unit-test factory seam.

Each signed request obtains a store bound to its authorization expiry and abort signal. Transactions check these before work and against database time immediately before returning to commit. Tests delay a real PostgreSQL UPDATE and then expire/abort; both cases roll back the authority extension. Enrollment is additionally bounded by the earlier issuer-grant expiry, so a still-live transport frame cannot consume a grant after its deadline. A delayed-update regression preserves both grants unconsumed and the runtime reserved. Metadata read transactions receive the same final checks. Cancellation after the last guard can still leave a commit outcome unknown; callers must hold/reconcile rather than assume undo. Registration, runtime/admission generation and underlying physical writer holds remain separate checks.

The source-bound local probe runs six actual PostgreSQL tests (four cryptographic bootstrap/enrollment and two SQL rollback) plus five route tests:

```
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:39989/hive_delivery_test \
  node scripts/probe-guardian-service.mjs
```

Evidence is `guardian-registry-local/service.json`; `HIVE_GUARDIAN_SERVICE_EVIDENCE_PATH` selects a separate JSON there for independent review. Its owner/Coder app resolution, package manifest values and kernel identity reports are synthetic fixtures. Real Ed25519 signatures, one-use persistence, database transactions and handler boundaries are exercised. The owner-app fixed `/guardian/identity` and `/guardian/bootstrap` transport and private FD3 equivalents are approved for the following composition, but are not claimed by this proof.

The initial combined run hit P2034 because two integration files concurrently installed delay triggers on the same table. `service-first-failure.json` preserves that failure; the parent failure artifact remains untouched. All delay cases now live in the same sequential integration file, preserving the intended RegistrationRejected and rollback assertions without adding production retries.
