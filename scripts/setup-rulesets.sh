#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# Applies GitHub rulesets to protect the repository.
# Run AFTER making the repository public (rulesets require public or Pro).
#
# Reconciling, not create-only: each ruleset is looked up by name and PUT
# when it already exists, POSTed when it does not. The previous version
# POSTed unconditionally, so a second run failed on "name already in use"
# and drift between this file and the live ruleset could never be corrected
# by running it — which is how the live ruleset came to require no status
# checks at all while this file claimed three.
#
# Usage: bash scripts/setup-rulesets.sh

set -euo pipefail

REPO="HominisBrowser/FireForge"

echo "Applying rulesets to $REPO..."

# Looks up a ruleset id by name, then PUTs (update) or POSTs (create).
# Reads the ruleset body on stdin.
apply_ruleset() {
  local name="$1"
  local body
  body="$(cat)"

  local existing_id
  existing_id="$(
    gh api "repos/$REPO/rulesets" --jq \
      ".[] | select(.name == \"$name\") | .id" 2>/dev/null | head -n 1
  )"

  if [ -n "$existing_id" ]; then
    printf '%s' "$body" | gh api "repos/$REPO/rulesets/$existing_id" --method PUT --input - >/dev/null
    echo "  ✓ '$name' updated (id $existing_id)"
  else
    printf '%s' "$body" | gh api "repos/$REPO/rulesets" --method POST --input - >/dev/null
    echo "  ✓ '$name' created"
  fi
}

# ── Main branch protection ruleset ──────────────────────────────────────
# The required contexts must match the job `name:` values in
# .github/workflows/ci.yml and security.yml exactly. Both files carry a
# comment explaining why those names must not embed the Node version.
echo "Applying main branch protection ruleset..."
apply_ruleset "Protect main" <<'EOF'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "automatic_copilot_review_enabled": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          {
            "context": "quality (ubuntu)"
          },
          {
            "context": "smoke (ubuntu-latest)"
          },
          {
            "context": "smoke (macos-latest)"
          },
          {
            "context": "smoke (windows-latest)"
          },
          {
            "context": "codeql"
          },
          {
            "context": "npm audit"
          },
          {
            "context": "dependency review"
          }
        ]
      }
    },
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "squash"
      }
    }
  ]
}
EOF

# ── Tag protection ruleset ──────────────────────────────────────────────
echo "Applying tag protection ruleset..."
apply_ruleset "Protect tags" <<'EOF'
{
  "name": "Protect tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~ALL"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    },
    {
      "type": "creation",
      "parameters": {
        "name_pattern": {
          "operator": "regex",
          "pattern": "^v[0-9]"
        }
      }
    }
  ]
}
EOF

# ── Enable private vulnerability reporting ──────────────────────────────
echo "Enabling private vulnerability reporting..."
gh api "repos/$REPO/private-vulnerability-reporting" \
  --method PUT 2>/dev/null && echo "  ✓ Private vulnerability reporting enabled" || echo "  ⚠ Could not enable (may require manual setup in Settings > Security)"

echo ""
echo "Done! Verify at: https://github.com/$REPO/settings/rules"
