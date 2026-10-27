# Sourced by the launcher. Does not install software or read wallet sessions.
baw_find_node() {
  local -a baw_candidates
  baw_candidates=(
    "$(command -v node 2>/dev/null || true)"
    /opt/homebrew/bin/node /usr/local/bin/node
    "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node"
    "$HOME"/.nvm/versions/node/*/bin/node(NOn)
  )
  baw_select_node "${baw_candidates[@]}"
}

baw_select_node() {
  local baw_candidate baw_version baw_major
  for baw_candidate in "$@"; do
    [[ -n "$baw_candidate" && -x "$baw_candidate" ]] || continue
    baw_version=$("$baw_candidate" --version 2>/dev/null) || continue
    [[ "$baw_version" == v<->.* ]] || continue
    baw_major="${${baw_version#v}%%.*}"
    if (( baw_major >= 22 )); then
      BAW_RUNTIME_NODE="$baw_candidate"
      return 0
    fi
  done
  return 1
}
