# Moxen Finances banking

A read-only account-information client for [Enable Banking](https://enablebanking.com/docs/api/reference/),
the service Moxen Finances supports but never provides. Each user has their OWN
Enable Banking account and application (restricted production mode, individual
non-commercial use, their own accounts whitelisted) and their own private key.
One key never serves two users, and nothing here is shared between installs.

It reads banks, links an account through a loopback redirect, and fetches
account details, balances and transactions. **It cannot move money:** there is
no payment code in this crate, and no endpoint that would need one.

| Module | What it holds |
|---|---|
| `jwt` | The RS256 token (`typ`/`alg`/`kid` header, `iss`/`aud`/`iat`/`exp` claims, one hour, clamped to the API's 24 hours), PEM parsing with typed errors. |
| `transport` | The `Transport` trait, its `ureq` implementation (rustls, Mozilla roots, no OpenSSL), and the request/response shapes. Blocking on purpose. |
| `client` | `list_aspsps`, `start_auth`, `create_session`, `get_session`, `account_details`, `balances`, `transactions` (every page, with a cap), `delete_session`; retries with backoff; the error mapping. |
| `callback` | The one-shot loopback server: `127.0.0.1` only, a fixed port list, `GET /callback`, the `state` compared in constant time, a static page in English and Spanish. |
| `secrets` | The private key in the OS keychain, imported once from a file the user points to. `MemoryStore` for tests. |
| `model` | The neutral shapes a caller persists: `BankTransaction` with a stable dedupe key, `BankAccount`, `BankBalance`, `BankLink`. |
| `money` | Decimal strings to integer minor units, no floats, currency exponents. |
| `dto` | The API's wire shapes and the one place they become the neutral ones. |
| `testing` | A recorded transport and a fake clock, for this crate's tests and a caller's. |

## The flow

1. `list_aspsps("ES")` for a bank picker.
2. `CallbackServer::bind(&DEFAULT_CALLBACK_PORTS)` to know which of
   `http://127.0.0.1:47831/callback` (…47832, …47833) to register; the
   `localhost` spelling matters to some browsers.
3. `start_auth` with the bank, a random `state` and that redirect URL; open the
   returned `url` in the browser.
4. `server.wait(&state, CALLBACK_TIMEOUT)` returns the `code`, or the reason
   there is none.
5. `create_session(&code)` returns the session and its accounts. **Part of that
   answer is shown once:** keep what you need immediately
   (`SessionGrant::into_link`).
6. `balances`, `transactions` (a date window, every page), `account_details`.
7. `delete_session` when the user unlinks, and `check_consent` before a sync:
   a consent that ran out means "link again", never a silent retry.

## The rules this crate keeps

- **The key never leaves the keychain.** `import_pem_file` reads a PEM the user
  chose, checks it, and stores it under the application id in the macOS
  Keychain or the Windows Credential Manager. The path is not kept. Nothing
  writes the key to a config, a log, the database, an error message or the
  repository, and `Debug` of anything holding it is a placeholder.
- **Nothing identifies a person in a log.** `Debug` of a request, an account, a
  link, a transaction or a callback outcome masks the identifiers (session ids,
  account uids, IBANs, entry references, bearer tokens); response bodies render
  as a length.
- **Only loopback.** The callback server binds `127.0.0.1`, answers only
  `GET /callback`, and echoes nothing into its pages.
- **Read only.** Account information, no payments.

## Tests

Every test uses a fake transport with recorded, fictional responses, except the
ones that exercise the real transport and the callback server against a loopback
socket in the same process. Nothing touches a network, a keychain or real data.
`tests/fixtures/` holds invented banks, invented "IBAN-shaped" strings that fail
their checksum on purpose, and a throwaway RSA key generated for this directory.

Two tests never run by default:

- `tests/sandbox_smoke.rs` needs `ENABLE_BANKING_SANDBOX_APP_ID` and
  `ENABLE_BANKING_SANDBOX_KEY_FILE`, is `#[ignore]`d, and prints a count and
  nothing else.
- `tests/secrets.rs::the_keychain_store_round_trips_a_fictional_key` writes to
  the platform keychain under its own service name and deletes the entry again.

```sh
cargo test -p moxen-finances-banking
```

## Not here (yet)

The settings screen that asks for the application id and the key file, the
mapping into the Finances store, and the periodic sync. Those follow the
multiple-accounts work in the store.
