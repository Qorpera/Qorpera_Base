# Reads the kit's .env as docker compose reads an env file, in one place (lib.sh sources it; kit.test.mjs checks it
# against docker compose itself with the README's examples). Sourced, never run.
#   KEY=value              trimmed; a " #" after it starts a comment (a # with no space before it is part of the value)
#   KEY="value"            \" \\ \n \t are read as escapes; anything after the closing quote is ignored
#   KEY='value'            exactly as written
#   export KEY=value       the same as KEY=value
#   # a comment, or a blank line
# Nothing is expanded: a $ is a $. A KEY the environment sets already keeps its value, as with docker compose.

# Prints one value as compose reads it. Fails on a quote that is never closed.
env_value() {
	local v=$1 out= q c i
	v=${v#"${v%%[![:space:]]*}"}
	q=${v:0:1}
	if [ "$q" = "'" ] || [ "$q" = '"' ]; then
		for ((i = 1; i < ${#v}; i++)); do
			c=${v:i:1}
			if [ "$c" = "$q" ]; then
				printf '%s' "$out"
				return 0
			fi
			if [ "$q" = '"' ] && [ "$c" = '\' ] && ((i + 1 < ${#v})); then
				i=$((i + 1))
				c=${v:i:1}
				case $c in
				n) c=$'\n' ;;
				t) c=$'\t' ;;
				esac
			fi
			out+=$c
		done
		return 1
	fi
	v=${v%%[[:space:]]#*}
	v=${v%"${v##*[![:space:]]}"}
	printf '%s' "$v"
}

# Exports every KEY of FILE the environment does not set yet.
load_env() {
	local line name value
	while IFS= read -r line || [ -n "$line" ]; do
		[[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
		name=${BASH_REMATCH[2]}
		value=$(env_value "${BASH_REMATCH[3]}") || return 1
		if [ -z "${!name+set}" ]; then export "$name=$value"; fi
	done <"$1"
}
