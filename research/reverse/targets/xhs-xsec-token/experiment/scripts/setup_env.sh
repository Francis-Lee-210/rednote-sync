#!/usr/bin/env bash
# Local environment setup only. It does not access any platform.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python3 -c 'import sys; sys.exit("Python 3.11 or newer is required") if sys.version_info < (3, 11) else None'

python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip check

mkdir -p data/captures profiles
chmod 700 data data/captures profiles
python -m unittest discover -s tests

cat <<'DONE'
Local setup complete.

Reminders:
- Put real account cookies only in ~/.rednote_test_accounts/accounts.json (chmod 600).
- Do not place cookies, HAR files, browser profiles, or tokens under Git.
- No platform request has been made by this script.
- Default transport is HTTP protocol; it needs no browser or QR login.
- Only --transport browser uses installed Google Chrome in an ignored profile.
DONE
