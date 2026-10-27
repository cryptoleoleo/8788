#!/bin/zsh
BAW_ROOT="${0:A:h}"
cd -- "$HOME" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.local/share/mise/shims"
source "$BAW_ROOT/runtime.zsh" || exit 1
if ! baw_find_node; then
  print '请先从 https://nodejs.org/ 安装 Node.js LTS（建议 24 或更新版本），再重新启动。'
  if [[ -t 0 ]]; then read '?按回车关闭…'; fi
  exit 1
fi
export PATH="${BAW_RUNTIME_NODE:h}:$PATH"
# Optional external launch settings. Keep the original port unless explicitly configured.
if [[ -f "$BAW_ROOT/mac-options.json" ]]; then
  BAW_OPTIONS="$BAW_ROOT/mac-options.json"
  BAW_PORT=$("$BAW_RUNTIME_NODE" -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(c.port!==null && c.port!==undefined){if(!Number.isInteger(c.port)||c.port<1||c.port>65535)throw Error("端口必须为 1 至 65535 的整数或 null");process.stdout.write(String(c.port));}' "$BAW_OPTIONS")
  BAW_OPTIONS_RESULT=$?
  if (( BAW_OPTIONS_RESULT != 0 )); then
    print 'Mac 启动配置无效，请检查 mac-options.json。'
    if [[ -t 0 ]]; then read '?按回车关闭…'; fi
    exit 1
  fi
  if [[ -n "$BAW_PORT" && -z "${PORT:-}" ]]; then export PORT="$BAW_PORT"; fi
fi
"$BAW_RUNTIME_NODE" "$BAW_ROOT/mac-launch.mjs"
BAW_RESULT=$?
if (( BAW_RESULT != 0 )) && [[ -t 0 ]]; then read '?启动失败，按回车关闭…'; fi
exit "$BAW_RESULT"
