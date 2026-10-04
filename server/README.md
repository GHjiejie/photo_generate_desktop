# Portrait Studio Go service

The service owns image bytes, full bilingual prompts, source metadata, CRUD,
batch planning, idempotence, version checks and durable recovery. It reads the
existing schema-1 library without dropping source fields. Original manifests
are archived as exact bytes; source IDs remain separate from allocated IDs.

```sh
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/platform-auth/portrait-server-linux-amd64 ./cmd/portrait-server
```

`-listen` only accepts an explicit loopback IP and port. `-label` can identify
an isolated test library. The service holds a library lock, pins its root and
validates file identity and hashes. Index replacement is the transaction's
commit point. CRUD recovery retains original records and images; interrupted
transactions recover on reopen. Conflicting outside edits are retained for
review rather than overwritten.

API responses use `{ok:true,data:...}` or a sanitized error code. The fixed
routes are `GET /healthz`, `GET /v1/library`, `GET /v1/portraits/{id}`,
`GET /v1/images/{id}?revision=N`, `POST /v1/portraits`,
`PATCH|DELETE /v1/portraits/{id}`, `POST /v1/batches/preview`,
`POST /v1/batches/{previewId}/commit`, and `DELETE /v1/batches/{previewId}`.
Create/update use multipart `metadata` JSON and an optional `image` part;
batch preview uses `metadata`, raw `manifest`, and `image:<relativePath>` parts.
Commit/delete require confirmation and expected versions. Preview IDs identify
transactions and do not provide authentication.

## Fixed admin authentication

The platform has one built-in account, `admin`, with no registration, user CRUD,
or default password. Every gallery, image, mutation and batch/upload route
requires a platform Bearer token before a request body is staged or parsed.
An absent credential configuration leaves the service uninitialized and rejects
business access; malformed or conflicting secret sources fail closed.

The public bootstrap routes are `GET /healthz`, `GET /v1/auth/status` and
`POST /v1/auth/login`. Login accepts only `{username:"admin",password:...}` and
returns an opaque access token with a finite expiry. `GET /v1/auth/session`
checks that token; `DELETE /v1/auth/session` revokes it on the server.
Sessions expire after eight hours, are stored only as SHA-256 token digests in
server memory, and become invalid on restart. A token is not a password hash.
Failed sign-ins are rate limited and password hashing concurrency is bounded.

Passwords use Argon2id with a random salt and fixed bounded parameters
(19 MiB, two iterations, one lane). The administrator chooses the real password
interactively; the assistant does not initialize production credentials. Run
the following **personally on the server**, as the service user, after placing
the reviewed new binary. The terminal hides input and asks for confirmation:

```sh
install -d -m 700 /home/ubuntu/portrait-studio/config
/home/ubuntu/portrait-studio/bin/portrait-server init-admin \
  -auth-file /home/ubuntu/portrait-studio/config/admin-auth.json
```

Use at least twelve characters and at most 1024 UTF-8 bytes, without control
characters. Initialization writes only the hash configuration, with mode 0600,
outside the portrait library. It refuses an existing destination, symlinks,
unsafe ownership and permissions. Passwords are not accepted as command-line
arguments, piped input, raw files or plaintext environment variables.

The process environment supports `PORTRAIT_STUDIO_ADMIN_USERNAME=admin` and
`PORTRAIT_STUDIO_AUTH_FILE`; `-auth-file` can explicitly select the same secret
file. The [.env.example](.env.example) contains only placeholders and paths;
the Go service does not automatically load `.env` files. The reviewed
[platform service example](deploy/portrait-studio-platform-auth.service) sets
these environment parameters and keeps the credential directory read-only.

Alternatively, initialize a private environment secret file interactively:

```sh
env -u PORTRAIT_STUDIO_AUTH_FILE -u PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH \
  /home/ubuntu/portrait-studio/bin/portrait-server init-admin \
  -env-file /home/ubuntu/portrait-studio/config/admin-auth.env
```

Use that file as the systemd `EnvironmentFile`. Remove the unit's
`PORTRAIT_STUDIO_AUTH_FILE` setting and any `-auth-file` flag in this variant.
The environment value `PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH` is a strictly
validated Argon2id PHC hash, never a plaintext password. Do not print, copy into
chat, commit, upload or include either private credential file in a data
archive. Choose exactly one source. Restart the service after initializing it.

## Caddy routing and existing Basic protection

The old dashboard's Basic password and the new platform admin password are
separate. Adding a login endpoint behind site-wide Basic authentication still
requires the old password before that endpoint can be reached.

The preferred reviewed plan adds a **new dedicated HTTPS host**,
`portrait-18-180-65-241.sslip.io`, using
[caddy-platform-auth.example](deploy/caddy-platform-auth.example). Only
`/portrait-studio/*` reaches the loopback Go service; all other paths return
404. Existing dashboard and every other site block, including their Basic
protection, remain unchanged. Caddy preserves the Authorization header for Go
to validate; it does not invent a user or token. TLS setup, actual Caddy
adaptation/validation and reload must be reviewed and performed by the server
administrator. These inputs have not been applied or verified on the server.

After the new host is configured, set the desktop URL to
`https://portrait-18-180-65-241.sslip.io/portrait-studio/` and use platform login.
This address is a deployment plan, not an assertion that it is currently live.
The existing recommended dashboard address is unchanged until the operator
selects an actually deployed platform endpoint. A gateway Basic challenge is
reported separately from a rejected platform password.

If the same dashboard host must be retained, the administrator must instead
review an explicit ordered `route`: the application-prefix handle goes first;
all other handlers and the existing Basic protection go together inside the
fallback handle. Merely adding `handle_path` after a top-level `basic_auth`
does not exempt the application. Do not remove authentication from the whole
site, duplicate a guessed password hash, or apply this restructuring without
checking the actual adapted configuration and all old protected paths.

Limits include 500 records / 1 GiB per batch, 30 MiB per image, 32 MiB JSON,
10,000 stored records, 30-minute previews and bounded staging. Matching is
strict relative path, unique basename, repeated identical ID prefix, or unique
ID when no filename exists. No order or fuzzy matching is used. Complete,
explicit derived Chinese prompts preserve the original English and raw source
metadata, with provenance hashes. Preview cancellation does not commit data.

SSH forwarding is useful for development tests and is not the public client
architecture. Deploying the new dedicated directory/service and changing an
existing HTTPS route require the applicable user authorization.

The current user-run platform-auth delivery is documented in
[deploy/USER-DEPLOY.md](deploy/USER-DEPLOY.md). From the project root,
`python3 server/deploy/platform_admin/deploy_from_mac.py --prepare` performs
local verification with no SSH. The same entry with `--apply` requires the
administrator's real terminal, review of the exact new-host candidate and
private password initialization in a separate SSH terminal. It pins the new
fixed-admin binary and the reusable 100-record revision-3 archive, preserves
all existing site authentication, and guards installation and rollback with
file hashes. Unknown existing installations or unprovable Caddy structures
stop for review. Preparing or transferring a delivery does not mean that its
public service is deployed or authenticated gallery access has been verified.

The old deploy scripts and manifest directly under `deploy/` and the sealed
old tools archive remain historical Basic-auth artifacts. Do not bypass their
checksum guards or use them to deploy the new platform login. No production
password initialization, remote write or Caddy change was executed here.

The new hashing and terminal dependencies are pinned to the available official
Go module cache (`x/crypto v0.28.0`, `x/term v0.25.0`). A current-version download
was unavailable in this execution environment. They are not claimed to be the
latest releases; only Argon2id, terminal input and their required dependencies
are used. [Go Argon2 documentation](https://pkg.go.dev/golang.org/x/crypto/argon2)
and the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
describe the selected algorithm and minimum parameters. The routing scheme
follows Caddy's [handle](https://caddyserver.com/docs/caddyfile/directives/handle)
and [route](https://caddyserver.com/docs/caddyfile/directives/route) behavior.
