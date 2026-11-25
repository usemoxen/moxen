# Test fixtures

Everything here is FICTIONAL and exists only to drive the tests.

| File | What it is |
|---|---|
| `aspsps.json` | A `GET /aspsps` answer with two invented banks. |
| `session.json` | A `POST /sessions` answer: one invented session, two invented accounts, IBAN-shaped strings that fail their checksum on purpose (`ES00…`). |
| `session-get.json` | A `GET /sessions/{id}` answer for the same session. |
| `account-details.json` | A `GET /accounts/{uid}/details` answer, with the extra fields the API adds so the tests prove they are ignored. |
| `balances.json` | A `GET /accounts/{uid}/balances` answer: one positive and one negative balance. |
| `transactions-page-1..3.json` | Three recorded pages, chained by `continuation_key`, one of them base64 with `=`, one cancelled transaction that a ledger must drop. |
| `test-key-pkcs8.pem`, `test-key-pkcs1.pem` | A 2048-bit RSA key pair generated locally for these tests, in both PEM shapes the parser accepts. |
| `test-key-encrypted.pem` | The same key, password-protected, to prove an encrypted key is refused with a typed error. |

The keys are NOT credentials: they were generated for this directory, are not
registered with Enable Banking or any other service, sign nothing but the
throwaway tokens these tests mint, and the private half exists nowhere else.
Test keys in a public repository are the normal way to test a signature; a real
user's key never leaves their OS keychain.
