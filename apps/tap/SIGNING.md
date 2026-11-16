# Signing the tap installer and updates

The tap release is Authenticode-signed (corpus spec D4). Until a purchased
certificate exists it is signed with a self-signed test certificate, which is
fine for the operator's own machines and is not acceptable for any other
machine (corpus task 21).

## Today: test certificate

```
cd apps/tap
npm ci
npm run release -- --test-cert --publish <stateDir>
```

The first run creates `apps/tap/.cache/test-signing.pfx` (an untrusted,
passwordless code-signing key; gitignored, never added to any certificate
store). Every install made from a test release pins that certificate's
thumbprint, so deleting the file means the next release has a new signer and
existing taps must be reinstalled rather than updated.

Windows shows the test-signed installer as from an unknown publisher; that is
expected.

## The operator step: buy a certificate, then one command

1. Buy an OV (or IV, as an individual) code-signing certificate whose key sits
   on a token or in a cloud signing service that exposes the certificate in the
   Windows certificate store. Options checked 2026-10-26 (confirm price and
   individual eligibility with the vendor before paying):
   - Certum cloud OV with SimplySign Desktop: about USD 116 a year reported by
     a reseller, not confirmed on Certum's own site. Timestamp URL:
     `http://time.certum.pl`.
   - Sectigo or Comodo OV on a USB token: from about USD 219 a year. Timestamp
     URL: `http://timestamp.sectigo.com`.
   - SSL.com IV or OV with eSigner: certificate plus at least USD 180 a year for
     eSigner; eSigner signs through its own tool rather than the store, so it
     does not fit `--thumbprint` without extra work.
   - Azure Artifact Signing: monthly subscription; individual onboarding was
     reported paused in 2026 (not confirmed); it signs through signtool and a
     plug-in, not the store.
   Since 2026-03-01 a code-signing certificate lasts at most 460 days, so this
   step repeats about yearly.
   Recommendation: Certum cloud OV if its validation accepts an individual,
   else a Sectigo OV token.
2. With the token plugged in (or SimplySign signed in), on the operator's
   desktop, never in the GLMPS service or an agent session:

   ```
   cd apps/tap
   npm run release -- --thumbprint <certificate thumbprint> --timestamp <vendor timestamp URL> --publish <stateDir>
   ```

   The thumbprint is in `certmgr.msc`, Personal, Certificates, the
   certificate's Details tab. The release refuses to finish unless every signed
   file verifies as `Valid` with that thumbprint.

Taps installed from a test release pin the test certificate and will not
accept an update signed with the purchased one: reinstall them from the new
installer once.
