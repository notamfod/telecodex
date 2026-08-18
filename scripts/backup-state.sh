#!/usr/bin/env bash
set -euo pipefail

umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "${script_dir}/.." && pwd)"
backup_dir="/root/backups/telecodex"
sync_dir="/root/Sync/telecodex-backups"
timestamp="$(date -u +%Y%m%d-%H%M%S)"
archive_path="${backup_dir}/telecodex-state-${timestamp}.tar.gz"

mkdir -p -- "${backup_dir}" "${sync_dir}"
chmod 700 -- "${backup_dir}" "${sync_dir}"

archive_tmp="$(mktemp "${backup_dir}/.telecodex-state.XXXXXX.tar.gz")"
sync_tmp="$(mktemp "${sync_dir}/.latest.XXXXXX.tar.gz")"
extract_tmp="$(mktemp -d)"

cleanup() {
  rm -f -- "${archive_tmp}" "${sync_tmp}"
  rm -rf -- "${extract_tmp}"
}
trap cleanup EXIT

items=()
while IFS= read -r -d '' state_file; do
  items+=("${state_file#"${project_dir}/"}")
done < <(find "${project_dir}/.telecodex" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null || true)

if [[ -d "${project_dir}/.telecodex/ticket-answers" ]]; then
  items+=(".telecodex/ticket-answers")
fi
if [[ -f "${project_dir}/recipes/recipes.json" ]]; then
  items+=("recipes/recipes.json")
fi
if (( ${#items[@]} == 0 )); then
  echo "No TeleCodex runtime state found under ${project_dir}" >&2
  exit 1
fi

tar -czf "${archive_tmp}" -C "${project_dir}" -- "${items[@]}"
tar -tzf "${archive_tmp}" >/dev/null
tar -xzf "${archive_tmp}" -C "${extract_tmp}"
mv -- "${archive_tmp}" "${archive_path}"
chmod 600 -- "${archive_path}"

cp -- "${archive_path}" "${sync_tmp}"
mv -- "${sync_tmp}" "${sync_dir}/latest.tar.gz"
chmod 600 -- "${sync_dir}/latest.tar.gz"

mapfile -t archives < <(find "${backup_dir}" -maxdepth 1 -type f -name 'telecodex-state-*.tar.gz' -printf '%T@ %p\n' \
  | sort -rn \
  | cut -d' ' -f2-)
if (( ${#archives[@]} > 30 )); then
  rm -f -- "${archives[@]:30}"
fi

echo "Created ${archive_path}"
