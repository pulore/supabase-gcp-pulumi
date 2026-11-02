# Contributing

Issues and pull requests are welcome. Security problems go by email instead; see [SECURITY.md](SECURITY.md).

Before opening a pull request (CI runs the first three steps on every push and pull request):

```bash
npm ci
npm run build   # type-checks everything, tests included
npm test        # unit tests against Pulumi's mocks; nothing is deployed
cat scripts/common.sh scripts/supabase-studio.sh | shellcheck -s bash -
cat scripts/common.sh scripts/outline-vpn.sh | shellcheck -s bash -
```

A few conventions:

- One component per concern in `components/`, with sizing in `config/presets.ts`, not in the component.
- Every new setting gets a type, a default and validation in `config/index.ts`, and a row in the README.
- When you bump the Supabase images, take Studio and postgres-meta from the same self-hosted release and say which one in `config/images.ts`.
- Secrets never go into instance metadata or startup scripts; pass the Secret Manager version name instead.
- Add or update a test for any change to firewall rules, Cloud Armor, Cloud SQL networking or backups.
- If you deployed your change to a real project, say so in the pull request, and what you checked.
