# Security policy

## Reporting a vulnerability

Please report security problems privately, by email to hello@pulore.com. Don't open a public issue or pull request for them.

Include what you found, how to reproduce it, and the commit you tested. If it's about a deployed stack, for example a firewall rule or Cloud Armor policy that lets in more than it should, say which preset and stack settings you used. Leave out real passwords, keys and project details; describe them instead.

We'll confirm we've received your report and tell you what we plan to do about it. Once a fix is on `main`, we're happy to credit you in the commit or release notes if you'd like.

There is no bug bounty.

## Scope

This repository is a template: fixes land on `main`, and there are no separate supported versions. If you deployed an earlier copy, compare it with `main`.

Problems in Supabase Studio, postgres-meta, nginx or Outline themselves belong with those projects. Tell us too if this template's setup makes one of them worse.
