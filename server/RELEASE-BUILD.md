# Fixed-admin Go release build

This builds the Linux/amd64 Go component locally. It does not connect to a
server, install a service, modify Caddy, initialize an admin password, or build
a Mac package. Historical binaries, archives and their deployment checksum
guards remain separate. The complete operator tools package combines this
component with separately reviewed deployment scripts and the user guide.

Use Python 3.10+ and the pinned local `go1.26.4` toolchain. The official module
versions are fixed in `go.mod` and `go.sum`; the builder is strictly offline.
The available cache uses `x/crypto v0.28.0` and `x/term v0.25.0`, which are not
claimed to be current releases. Dependencies must already be present in the
chosen writable module cache. No password, hash or private key is needed.

From the repository root, build a new release:

```sh
python3 server/build_release.py build \
  --version platform-auth-20261004-r1 \
  --mod-cache /tmp/portrait-admin-auth-modcache \
  --build-cache /tmp/portrait-admin-auth-buildcache \
  --library-archive server/dist/Portrait-Studio-Library-100-r3.tar.gz
```

The output directory and archive must not exist. Choose a new version for a
new release, or an existing empty `--output-root` directory to reproduce the
same release elsewhere. Cache paths are local examples from this Mac; the
builder does not create, download or discover missing modules automatically.

The release directory is
`server/dist/Portrait-Studio-Server-platform-auth-20261004-r1/`, containing:

- `bin/portrait-server`: static Linux/amd64 binary, without CGO.
- `release-manifest.json`: binary/file pins, exact admin authentication
  contract, build inputs, library binding and undeployed status.
- `auth-contract.json`: login, session, initialization and error contract.
- `SHA256SUMS`: hashes for every release file and the manifest.
- Exact Go sources/tests, module pins, this build entry, safe configuration
  examples and the Go source/build guides. The complete manual tools kit owns
  the current operator deployment guide. Test fixture passwords only appear in
  `_test.go` source; tests are excluded from the production binary.

The sibling `.tar.gz` uses sorted names, fixed file modes, zero timestamps,
UID/GID zero and a deterministic gzip header. Its `.sha256` pins the complete
archive. The build uses `-trimpath -buildvcs=false -ldflags='-s -w'`, and rejects
an unexpected Go version. With unchanged sources and the same toolchain/module
bytes, rebuilding with the same version produces identical archive bytes.

Read-only verification of the delivered directory and external gallery:

```sh
python3 server/build_release.py verify \
  server/dist/Portrait-Studio-Server-platform-auth-20261004-r1 \
  --library-archive server/dist/Portrait-Studio-Library-100-r3.tar.gz
```

For an extracted component, use its own `build_release.py` and explicitly pass
the external gallery path. Building again needs a writable output root plus
the same offline caches. Source snapshot and binary generation happen in an
isolated staging directory. The script checks for source changes during the
build and never overwrites a previously published release.

The separate existing gallery archive is deliberately reused, not regenerated:
100 records, schema 1, revision 3, 108 regular files. The builder verifies the
archive and sidecar SHA-256, all member bytes, index count/revision, and every
record's image size/hash. Full native Go CRUD/import compatibility is verified
separately against an isolated extracted copy; this checksum check alone is
not a claim of deployment or a working public endpoint.

Startup still requires the operator to choose a data path and private hash
source. Use `-version platform-auth-20261004-r1` to show the release label in
`/healthz`; the source service example uses a generic `platform-auth` label.
Only the owner runs `init-admin` at an interactive terminal. The binary has no
default password, registration, user CRUD, persistent session secret, or
authentication bypass. Existing dashboard Basic protection belongs to its
own host; the dedicated-host Caddy example is a review input, not an applied
configuration. See [README.md](README.md) and [.env.example](.env.example) for
the authentication choices. Deployment-script and operator-guide links in the
source README refer to the separate complete manual tools kit; those scripts
are intentionally absent from this Go component archive.
