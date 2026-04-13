#!/usr/bin/env bash
# SPDX-License-Identifier: EUPL-1.2
# Applies GitHub rulesets to protect the repository.
# Run AFTER making the repository public (rulesets require public or Pro).
#
# Usage: bash scripts/setup-rulesets.sh

set -euo pipefail

REPO="HominisBrowser/FireForge"

echo "Applying rulesets to $REPO..."

# ── Main branch protection ruleset ──────────────────────────────────────
echo "Creating main branch protection ruleset..."
gh api "repos/$REPO/rulesets" \
  --method POST \
  --input - <<'EOF'
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
            "context": "quality (ubuntu, node 20)"
          },
          {
            "context": "codeql"
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
echo "  ✓ Main branch ruleset created"

# ── Tag protection ruleset ──────────────────────────────────────────────
echo "Creating tag protection ruleset..."
gh api "repos/$REPO/rulesets" \
  --method POST \
  --input - <<'EOF'
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
echo "  ✓ Tag ruleset created"

# ── Enable private vulnerability reporting ──────────────────────────────
echo "Enabling private vulnerability reporting..."
gh api "repos/$REPO/private-vulnerability-reporting" \
  --method PUT 2>/dev/null && echo "  ✓ Private vulnerability reporting enabled" || echo "  ⚠ Could not enable (may require manual setup in Settings > Security)"

echo ""
echo "Done! Verify at: https://github.com/$REPO/settings/rules"
